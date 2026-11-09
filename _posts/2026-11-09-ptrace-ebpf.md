---
title: "ptrace与ebpf"
date: 2026-11-09 00:00:00 +0800
category: trace
tags: [Linux, ptrace, eBPF, profile]
description: "对比 ptrace 与 eBPF 的调用栈采集流程、系统调用开销，以及 perf event 采样和 uprobe 追踪的实现。"
---

ptrace 和 eBPF 都可以用于进程 profile，通过采集线程调用栈来分析程序的运行状态和性能热点。两者获取现场的方式差别很大：ptrace 由外部采集器暂停目标线程，再读取寄存器和内存；eBPF 则借助 perf event、uprobe 等内核事件，在事件发生时采集现场。这种差异直接影响采样开销、目标线程的暂停时间和采样时机，在需要读取更多运行时数据的 native 与脚本混合栈场景下尤其明显。

## 一、ptrace 如何实现采样

ptrace 本身没有“每隔一段时间返回一份完整调用栈”的接口。采集器需要自己安排采样时机，停止目标线程，读取寄存器和内存，再交给解栈器恢复调用链。

### 1. 先停止目标线程

ptrace 操作的对象是 **TID，也就是具体线程**。对多线程进程做采样，通常先枚举 `/proc/<pid>/task/`，为需要观察的线程建立跟踪关系，并处理采集期间新建、退出的线程。

一种适合周期采样的方式是：

1. 初始化时，对目标 TID 调用 `PTRACE_SEIZE`。它建立跟踪关系，**不会立即停止线程**。
2. 到达采样时刻后，调用 `PTRACE_INTERRUPT` 请求线程进入 ptrace-stop。
3. 用 `waitpid` 等待对应 TID，并检查返回状态，确认它确实已经停止。发送停止请求和线程实际停止之间有延迟，不能立即读取后就假定拿到了稳定现场。
4. 采集完成后调用 `PTRACE_CONT`，让线程继续运行；结束整个采集任务时再解除跟踪。

另一种入口是 `PTRACE_ATTACH`，它在建立跟踪关系的同时向目标线程发送 `SIGSTOP`。以原本正在运行的线程为例，内核中的挂起流程大致如下：

1. **建立跟踪关系**：采集器进入 ptrace 系统调用，内核根据 TID 找到目标的 `task_struct`，检查权限和跟踪状态，通过后将它关联到采集器。
2. **发出停止请求**：内核将 `SIGSTOP` 加入目标线程的待决信号，并设置待处理信号标志。如果目标处于可中断睡眠，会尝试唤醒它；如果正在另一 CPU 上运行，则可通过处理器间中断促使其进入内核检查信号。
3. **进入跟踪停止状态**：目标线程在内核检查待决信号时发现自己正被跟踪，经 `ptrace_stop()` 进入 `TASK_TRACED` 状态，并通知采集器发生了停止事件。这个过程由内核完成，不需要目标程序安装信号处理函数。
4. **让出 CPU，确认停止**：目标线程调用调度器让出 CPU，停在内核的 ptrace 停止路径中，不再继续执行用户代码。采集器通过 `waitpid` 取得停止状态后，才能开始读取它的寄存器和内存。
5. **恢复执行**：采集器取完数据后调用 `PTRACE_CONT`，内核唤醒目标，使其重新具备运行条件，等待调度。对于 attach 引入的这次 `SIGSTOP`，通常在继续时传入信号 `0`，不再将它实际递送为进程组停止。

因此，**`PTRACE_ATTACH` 返回成功，只表示附加操作成功，不保证目标此刻已经停止**；线程仍要走到能处理停止请求的位置。如果它处于不可中断的内核等待中，停止还可能延后。停止期间，供 ptrace 读取的用户态寄存器现场由内核保存，后续 `PTRACE_GETREGSET` 就从这份现场取数。

上面的 `PTRACE_SEIZE` 则把“附加”和“请求停止”分开：附加时不发送 `SIGSTOP`，之后用 `PTRACE_INTERRUPT` 请求 ptrace-stop。实际采集器仍要区分信号停止、线程退出等状态。接口语义见 [ptrace(2)](https://man7.org/linux/man-pages/man2/ptrace.2.html)，上述内核流程可对照 Linux v6.12 的 [ptrace.c](https://github.com/torvalds/linux/blob/v6.12/kernel/ptrace.c) 和 [signal.c](https://github.com/torvalds/linux/blob/v6.12/kernel/signal.c)。

[![ptrace 采样流程：建立跟踪关系、请求停止、等候停止、读取寄存器和内存、恢复线程、离线解栈]({{ '/assets/images/ptrace-ebpf/ptrace-sampling.svg' | relative_url }})]({{ '/assets/images/ptrace-ebpf/ptrace-sampling.svg' | relative_url }})

*图 1：ptrace 的一次采样包含停止、等待、读取和恢复。点击流程图可查看原图。*

### 2. 读取寄存器和栈内存

寄存器给出解栈的起点。通过 `PTRACE_GETREGSET`，指定 `NT_PRSTATUS` 等寄存器集合，可以取得目标线程的通用寄存器。在 x86-64 上，最直接相关的是指令指针 RIP、栈指针 RSP，以及可能用作帧指针的 RBP；其他架构有对应的 PC、SP、FP。解栈器还可能需要更多寄存器，不能只保存这三个值。

随后读取目标地址空间中的栈内存，常见方式有两种：

| 读取方式 | 大体做法 | 对采样的影响 |
| --- | --- | --- |
| `PTRACE_PEEKDATA` | 每次从目标地址读取一个机器字 | 逐字复制大块栈时，会产生大量系统调用 |
| `process_vm_readv` | 一次提交一组远程地址范围，批量复制到采集器 | 可以显著减少读取调用，但需要处理短读、不可读区域和权限检查 |

例如，在机器字为 8 字节的环境下，用 `PTRACE_PEEKDATA` 逐字复制 16 KiB 栈，仅这一步就需要 `16384 / 8 = 2048` 次调用。使用 `process_vm_readv` 可以把连续区域合并读取，所以“大量逐字调用”是朴素实现的成本，并不是所有 ptrace profiler 都必须承受同样的调用次数。

`process_vm_readv` 本身不负责停止线程，也不保证整次传输具有原子性。通常仍要先稳定寄存器和对应内存，再建立一致的快照；停止一个 TID 也没有冻结其他线程可能修改的共享对象。见 [process_vm_readv(2)](https://man7.org/linux/man-pages/man2/process_vm_readv.2.html)。

### 3. 从现场恢复 native 栈

拿到寄存器和内存后，才开始真正的 stack unwinding，也就是解栈：

- **Frame Pointer（帧指针）方式**：如果程序保留了可用的帧指针链，就沿 FP 查找上一帧和返回地址。
- **DWARF CFI 方式**：根据当前指令地址查找 `.eh_frame` 等位置的展开规则，恢复上一帧的寄存器，再继续向上展开。这需要对应 ELF 的展开信息，不是从栈上搜索“看起来像代码地址”的数值。
- **符号化**：结合模块映射、加载基址和符号信息，把栈帧地址转换为函数名；源码行还可能需要调试信息。解栈和符号化是两个步骤。

如果所需寄存器、栈内存和模块信息已经完整保存，就可以先恢复线程，再在采集器里离线解栈。若解栈器仍按需读取目标内存，就需要继续维持合适的停止状态，否则读到的可能是恢复运行后的数据。关于展开规则，可参考 [DWARF 标准的 Call Frame Information](https://dwarfstd.org/doc/DWARF5.pdf)。

### 4. native 与脚本混合栈为什么更贵

混合栈不仅是把 native 栈展开得更深。比如一条调用路径可能是：

```text
C++ 主循环 → Python 函数 A → Python 函数 B → C 扩展函数
```

native 解栈可能只看到解释器的求值循环和 C 扩展入口。脚本函数 A、B 的逻辑帧还可能保存在解释器的线程状态、帧链和堆对象中；解释执行、JIT、内联等情形也有各自的表示方式。因此，需要针对具体运行时和版本读取这些结构，并把脚本帧与 native 帧关联起来。CPython 自己的 [GDB 辅助脚本](https://github.com/python/cpython/blob/main/Tools/gdb/libpython.py) 就展示了这类运行时结构解析。

这会增加许多分散读取：先找到线程状态，再读取当前帧，之后沿指针寻找上一帧、代码对象、函数名和行号信息。下一次读取的地址往往依赖上一次的结果，无法提前全部合并。如果每一步都通过远程读接口完成，就会形成多轮系统调用；只复制一段连续 native 栈，也未必包含这些堆上的脚本帧。

因此，ptrace 采样的成本通常来自两部分：**停止、等待和恢复带来的调度及往返成本，以及寄存器、栈和运行时对象的读取成本**。混合栈会进一步放大后者。批量读取、缓存不变元数据和离线解栈可以降低成本；若数据还没保存完整，就不能为了缩短暂停时间而提前恢复线程。

## 二、eBPF 如何进行采样和断点 trace

eBPF 是在内核中运行采集逻辑的机制，采样时机则由挂载的事件决定：周期 profile 可以用 perf event，函数入口或返回追踪可以用 uprobe、uretprobe。用户态负责加载程序、配置事件和消费结果，事件发生时的取数工作放在内核中完成。

### 1. 基于 perf event 做周期采样

用户态通过 `perf_event_open` 创建采样事件，再把 `BPF_PROG_TYPE_PERF_EVENT` 类型的 BPF 程序挂到事件上。可以按线程建立事件，也可以按 CPU 建立事件，再在 BPF 中筛选目标进程。初始化仍会涉及系统调用，但不需要每采一个样本，都让采集器执行一轮停止和恢复协议。

周期可以按事件计数或目标频率配置。例如，软件事件 `PERF_COUNT_SW_TASK_CLOCK` 计量任务运行时间，`PERF_COUNT_SW_CPU_CLOCK` 提供每 CPU 的高精度时钟事件；也可以选择 CPU cycles 等硬件事件。使用 `sample_period` 时，周期单位由事件类型决定；使用 `freq = 1` 和 `sample_freq` 时，则指定目标采样频率。具体配置和作用范围见 [perf_event_open(2)](https://man7.org/linux/man-pages/man2/perf_event_open.2.html)。

[![eBPF 周期采样流程：初始化挂载 perf event，内核事件触发 BPF 采集现场，缓冲区异步传递给用户态]({{ '/assets/images/ptrace-ebpf/ebpf-sampling.svg' | relative_url }})]({{ '/assets/images/ptrace-ebpf/ebpf-sampling.svg' | relative_url }})

*图 2：perf event 负责触发，BPF 当场采集，用户态批量消费和分析。*

当事件触发时，内核调用挂载的 BPF 程序。程序可以记录 PID/TID、事件现场的寄存器，尝试读取用户栈，或者直接更新 BPF map 中的统计结果。结果可以通过 ring buffer 等缓冲区异步交给用户态，采集器不必在每个采样时刻立即获得调度。

这里的 CPU profile 主要回答“线程运行时在执行什么”。按线程建立的运行时间采样事件会跟随任务调度，线程睡眠时不会每隔固定墙钟时间产生一份同样的栈；分析锁等待、I/O 等 off-CPU 时间，需要额外的调度事件或其他观测方式。

### 2. 为什么在内核里采集通常更省

关键是 **事件发生时，采集代码就在目标执行上下文中**。它可以使用现场寄存器，并通过 `bpf_probe_read_user` 等 helper 尝试读取用户内存，不必由外部采集器反复发起跨进程读取请求。还可以在内核中按调用栈计数，只上报聚合结果，减少数据传输和用户态唤醒。

不过，采集原始现场和展开完整调用链要分开看：

| 需求 | 常见实现 | 需要注意的条件 |
| --- | --- | --- |
| 直接取得调用链 | `bpf_get_stackid` 或 `bpf_get_stack`，用户栈使用 `BPF_F_USER_STACK` | 受架构、帧指针、深度上限和读取失败影响 |
| 没有可用帧指针，需要 DWARF | BPF 保存寄存器和有界栈快照，用户态结合 CFI 展开 | 快照必须覆盖展开所需的数据，并匹配当时的模块映射 |
| native 与脚本混合栈 | 增加运行时专用的帧遍历或元数据采集 | 仍需理解解释器/JIT 的结构和版本，不能仅靠 native stack helper |

例如，x86 的常规用户调用链采集路径会沿帧指针读取栈，不能理解成自动对任意二进制进行完整 DWARF 展开。相关接口见 [bpf-helpers(7)](https://man7.org/linux/man-pages/man7/bpf-helpers.7.html)，具体路径可对照 [Linux x86 的用户调用链实现](https://github.com/torvalds/linux/blob/v6.12/arch/x86/events/core.c#L2734)。

所以，“进入内核后读取堆栈开销更低”主要指减少了外部采集器的系统调用往返、停止等待和唤醒。复制大块栈、遍历脚本对象、解栈和符号化仍然有成本。BPF 的用户内存读取也可能失败，且没有冻结其他线程；采样现场仍需要完整性检查。

### 3. 采样周期为什么更容易控制

ptrace 方式通常先由用户态定时器唤醒采集器，再请求停止目标，等目标真正停住后才能取样。最终看到的现场已经受到采集器调度、目标停止延迟和读取耗时的影响；如果每轮完成后再等待下一个间隔，还会累积漂移。

perf event 将触发放到内核事件路径上。软件 CPU/task-clock 事件使用高精度定时器，硬件事件可在计数达到条件时触发，省掉了“先调度采集器，再停止目标”的链路。因此，相比上述用户态轮询停止方案，**采样时刻通常更接近配置的事件节奏**。软件时钟的实现可参考 [Linux perf 核心代码](https://github.com/torvalds/linux/blob/master/kernel/events/core.c)。

这不是硬实时保证：中断延迟、采样频率限制、节流、硬件事件的 skid，以及缓冲区满都可能影响结果。设为 99 Hz 表示目标采样频率，不代表每个样本都恰好相隔约 10.1 ms 墙钟时间。解读结果时应同时检查有效样本数和丢失情况。

### 4. 基于 uprobe / uretprobe 做断点 trace

周期采样看的是统计分布，而追踪 `malloc`、某个业务函数或脚本运行时入口，往往希望“每次走到这里就记录”。这时可以使用：

- **uprobe**：挂到用户态可执行文件或共享库的某个指令位置，常用于函数入口，读取参数和调用栈。
- **uretprobe**：跟踪函数返回，常用于读取返回值，并与入口记录关联。

底层挂载位置通常表示为“文件路径 + 文件偏移”；上层工具可以根据函数符号解析偏移，并按 PID 限制观测范围。文件偏移不能直接等同于 ELF 虚拟地址或进程中的运行时地址。接口例子见 [内核 uprobe 文档](https://docs.kernel.org/trace/uprobetracer.html)。

在传统的软件断点路径中，内核在探测位置布置断点；线程执行到这里时陷入内核，运行 BPF 处理逻辑，再处理被替换指令的执行并继续用户代码。以 x86 为例，常见机制包含 `int3` 和异地执行原指令；具体路径会随架构和内核优化变化。可参考 [Linux uprobes 实现](https://github.com/torvalds/linux/blob/master/kernel/events/uprobes.c)。

这让安装观测“断点”很方便：入口记录参数，返回记录结果，按 TID 配对就能分析一次调用。每次命中不需要唤醒用户态 debugger 再发出继续命令；探针执行仍会同步占用目标线程的时间，命中频繁时成本也会很明显。这里说的断点 trace 是事件观测，不等于交互式暂停和单步调试。

| 对比项 | ptrace 外部采样 | eBPF + perf event / uprobe |
| --- | --- | --- |
| 触发方式 | 采集器安排时机，再请求目标停止 | 内核采样事件或目标探针位置触发 |
| 每个样本的处理 | 停止、等待、远程读取、恢复 | 内核中取现场，可就地聚合或提交事件 |
| 系统调用与切换 | 采集器每轮多次调用，可能反复远程读 | 初始化和消费仍有调用；事件仍有中断或陷入开销 |
| 混合栈 | 外部解析运行时结构，分散读取可能很重 | 可减少远程读取往返，仍需要运行时适配 |
| 更适合的任务 | 需要外部控制线程、检查完整现场 | 持续 CPU profile、函数事件追踪和聚合统计 |

### 5. 案例：用 malloc-trace 查找内存泄漏线索

本地的 `trace/ebpf-trace/malloc-trace/` 就采用了 uprobe 追踪分配与释放，再离线分析调用栈的思路。代码仓库是 [fanjinsong/trace](https://github.com/fanjinsong/trace)，案例源码和使用说明见 [malloc-trace](https://github.com/fanjinsong/trace/tree/main/ebpf-trace/malloc-trace)。

[![malloc-trace 流程：malloc 入口保存大小，返回时取得指针和栈快照，free 记录释放，用户态配对并汇总仍存活的分配]({{ '/assets/images/ptrace-ebpf/ebpf-uprobe.svg' | relative_url }})]({{ '/assets/images/ptrace-ebpf/ebpf-uprobe.svg' | relative_url }})

*图 3：把分配与释放关联起来，再从剩余分配中查找可疑的调用路径。*

这个案例的处理过程是：

1. **malloc 入口**：uprobe 按线程保存申请的大小。
2. **malloc 返回**：uretprobe 读取返回指针；对于成功分配，记录大小，并尝试保存寄存器和从 RSP 开始的用户栈快照。
3. **free 入口**：uprobe 记录释放地址，用于删除对应的存活分配。
4. **用户态配对**：分配和释放走两个 ring buffer，消费端按全局序号恢复事件顺序。采集中每新增 1000 条记录做一次配对清理，移除已释放的记录。
5. **停止后分析**：按 Ctrl+C 后停止探针、排空缓冲区，只对仍未释放分配的快照使用 libdwfl 做 DWARF 解栈，再按调用栈汇总分配次数和字节数。

这里 **BPF 负责保存现场，DWARF 解栈放在用户态**，采集期间不展开每一笔分配的调用栈。已经分配并释放的对象可以先被配对清理，最终只为剩余记录支付解栈成本。解栈使用保存的寄存器和栈副本，不用目标后来变化的实时栈补齐旧现场。

如果某条调用路径的未释放字节数随着观察时间持续增长，就值得进一步检查。但“窗口结束时仍存活”只是泄漏候选，缓存和长生命周期对象也可能如此。当前案例只跟踪安装探针后指定进程的 `malloc/free`，未单独覆盖 `calloc/realloc/mmap` 和自定义分配器；栈快照截断、缺少 CFI、模块映射变化、事件丢失也会影响完整性。ring buffer 预留失败的语义见 [BPF ring buffer 文档](https://docs.kernel.org/bpf/ringbuf.html)，实际使用范围以仓库 README 为准。
