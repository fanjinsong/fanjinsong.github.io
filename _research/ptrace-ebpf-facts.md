# ptrace 与 eBPF 技术核对

核对日期：2026-11-09。本文是文章写作的资料笔记；Linux API 以 man-pages 为准，架构相关解栈用 Linux v6.12 的 x86 源码举例。

## ptrace 采样

- ptrace 附加和操作的对象是线程 TID。`PTRACE_SEIZE` 建立跟踪关系但不停止线程；之后 `PTRACE_INTERRUPT` 请求停止，再由 `waitpid` 检查实际的 ptrace-stop。`PTRACE_ATTACH` 则会发送 `SIGSTOP`，同样不能省略等待。读取后用 `PTRACE_CONT` 恢复；结束跟踪才用 `PTRACE_DETACH`。[ptrace(2)](https://man7.org/linux/man-pages/man2/ptrace.2.html)
- `PTRACE_GETREGSET` 使用寄存器集合（如 `NT_PRSTATUS`）和 `iovec` 读取寄存器。`PTRACE_PEEKDATA` 每次读取一个机器字。因此逐字远程读取会累积系统调用；不是所有 ptrace profiler 都必须逐字读取。[ptrace(2)](https://man7.org/linux/man-pages/man2/ptrace.2.html)
- 可用 `process_vm_readv` 一次读取多个内存范围，但要检查短读，其传输没有原子性保证。它本身不负责停止目标。停止一个线程也不能冻结其他线程共享的堆对象。[process_vm_readv(2)](https://man7.org/linux/man-pages/man2/process_vm_readv.2.html)
- **由上述接口推导的工程判断**：每次采样至少包含中断、等待、取寄存器、读内存和恢复等阶段；所需调用数取决于批量读取策略。混合栈若沿运行时对象指针逐层读取，且下一地址依赖上一结果，就难以全部合并为一次读取。提前完整复制所需寄存器、栈与运行时数据，可在恢复后离线展开；只复制 native 栈未必覆盖脚本运行时的堆上帧对象。

## perf event 周期采样

- `perf_event_open` 可建立按线程或按 CPU 的事件；按线程事件跟随任务调度，不能描述为“线程睡眠期间也按固定墙钟周期采到其栈”。`PERF_COUNT_SW_CPU_CLOCK` 是每 CPU 高精度时钟；`PERF_COUNT_SW_TASK_CLOCK` 计运行任务时间。`sample_period` 是事件计数单位的周期，`freq=1` 使用目标频率；一般频率模式会调节周期以尝试接近目标。[perf_event_open(2)](https://man7.org/linux/man-pages/man2/perf_event_open.2.html)
- libbpf 的 `bpf_program__attach_perf_event_opts` 将已加载的 BPF 程序附到 perf FD，支持 BPF link 或旧 ioctl 路径。无需让用户态采集器在每个采样点执行停止/恢复协议。[libbpf 源码](https://raw.githubusercontent.com/libbpf/libbpf/master/src/libbpf.c)
- CPU/task clock 软件事件使用 hrtimer；当前内核实现可将其频率直接换算为周期。这一点比笼统说“所有频率模式都实时动态调节周期”更准确。[Linux perf 核心源码](https://raw.githubusercontent.com/torvalds/linux/master/kernel/events/core.c)
- **工程推断**：内核触发减少了用户态定时器唤醒、调度、停止等待带来的采样时刻漂移，但不能保证硬实时。中断延迟、采样频率上限、事件节流、缓冲区满、PMU skid 都可能影响实际数据；CPU profile 也不等于 off-CPU 等待时间分析。[perf_event_open(2)](https://man7.org/linux/man-pages/man2/perf_event_open.2.html)

## uprobe / uretprobe

- uprobe 位于可执行文件或共享库的文件偏移处；uretprobe 跟踪函数返回。入口可读寄存器参数，返回探针可读返回值。libbpf 可按符号解析挂载；API 不能把 ELF 虚拟地址直接当文件偏移。[内核 uprobe 文档](https://docs.kernel.org/trace/uprobetracer.html)、[libbpf 源码](https://raw.githubusercontent.com/libbpf/libbpf/master/src/libbpf.c)
- 常规 uprobe 机制把软件断点写入目标映射；命中时陷入内核、运行处理器，再处理被替换指令的执行（例如异地单步）后继续。没有“每次命中都唤醒用户态 debugger”的必要，但陷入和探针运行本身有成本；新内核和架构可能另有优化，文章宜用“大体流程”。[Linux uprobes 源码](https://raw.githubusercontent.com/torvalds/linux/master/kernel/events/uprobes.c)
- “支持断点方便”宜表述为方便安装观测探针和读取参数、返回值、调用栈；不能让读者误解为完整的交互式暂停、单步调试器。

## 内核采栈的边界

- `bpf_get_stackid` / `bpf_get_stack` 可获取调用链；`BPF_F_USER_STACK` 选择用户栈。`bpf_probe_read_user` 可安全尝试读取用户内存，失败必须处理。[bpf-helpers(7)](https://man7.org/linux/man-pages/man7/bpf-helpers.7.html)
- x86 的普通用户 callchain 例程从 BP/FP 沿帧指针链读取，不会自动根据 DWARF CFI 展开任意二进制。无 FP 时可设计为采集寄存器和有界栈快照，用户态再结合 DWARF 展开；脚本/JIT 的逻辑栈仍需运行时适配。[Linux v6.12 x86 perf_callchain_user](https://github.com/torvalds/linux/blob/v6.12/arch/x86/events/core.c#L2734)
- **工程推断**：优势是事件发生时就在目标线程上下文里访问寄存器和用户内存、在内核聚合，减少跨进程系统调用及唤醒；不能写成“进入内核就能零成本、任意完整地读取所有栈”。拷贝大快照、脚本对象遍历和 DWARF 展开依然耗时；其他线程也未被整体冻结。
- ring buffer 是有界缓冲区，预留空间可能失败，应记录丢失并限制报告结论。[BPF ring buffer 文档](https://docs.kernel.org/bpf/ringbuf.html)
