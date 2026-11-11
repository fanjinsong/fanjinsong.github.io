---
title: "ebpf采样混合栈示例"
date: 2026-11-11 00:00:00 +0800
category: trace
tags: [Linux, eBPF, BCC, Lua, profile]
description: "结合 native_lua_stack_profile 示例，分析 ELF 与进程映射、BPF 现场快照、Lua CallInfo 遍历、DWARF 解栈和混合栈火焰图的完整实现。"
---

在 [ptrace与ebpf]({{ '/notes/ptrace-ebpf.html' | relative_url }}) 中，介绍了通过 perf event 触发 eBPF、在事件发生时保存寄存器和栈内存的思路。本文结合 [native_lua_stack_profile 示例](https://github.com/fanjinsong/trace/tree/fb2abd9/ebpf-trace/native_lua_stack_profile)，把这个过程展开到一个具体的 C++ / Lua 混合调用场景：从目标进程中取得 native 和 Lua 两种调用栈，将它们合并，再生成火焰图。

这里的重点是**同一次采样中的两份栈信息如何关联**。native 栈记录 C/C++ 和 Lua VM 的机器调用过程，Lua 调用链则保存在解释器的 `CallInfo` 等结构中。仅有 native 栈，往往只能看到 `luaV_execute`，看不到它正在解释执行的多层 Lua 函数；仅有 Lua 栈，又会缺少 C++ 回调及其上层调用者。

整个实现分成初始化、内核采集和用户态处理三部分：

[![混合栈采样整体流程：ELF和maps初始化，BPF采集同一次现场，Python解栈合并并输出火焰图]({{ '/assets/images/ebpf-mixed-stack-sampling/pipeline.svg' | relative_url }})]({{ '/assets/images/ebpf-mixed-stack-sampling/pipeline.svg' | relative_url }})

*图 1：初始化时解析地址与结构布局；采样时复制现场；Python 持续解栈、合并和计数。点击图示可查看原图。*

## 一、示例程序的目的与约束

### 1. 构造 Lua 与 C++ 反复跨越的调用链

目标程序 `profile_test` 创建 Lua state，注册 `cpp.work` 和 `cpp.call_lua`，加载 `test.lua`，然后循环调用 Lua 的 `profile_entry()`。

Lua 侧有多层普通函数调用，C++ 侧既有计算函数，也有再次调用 Lua 的入口。采样落在 Lua 回调中的 `cpp.work()` 时，逻辑调用路径可以简化为：

```text
main
  → Lua: profile_entry
    → Lua: lua_stage_one
      → Lua: lua_stage_two
        → C++: cpp_call_lua
          → Lua: lua_callback
            → C++: cpp_work
```

这个例子同时覆盖了 Lua → Lua、Lua → C++、C++ → Lua 回调。普通 Lua 调用可以共用一次 native VM 执行，而 C++ 再进入 Lua 会产生另一段 VM 执行过程，后面的合并逻辑正是围绕这个差别展开。

`test.lua` 在一些函数返回前保留额外运算，避免 Lua 尾调用折叠掉要观察的逻辑层级。CMake 则使用 `-O2 -g`：保留优化，也保留调试信息。因此，上图是源码层面的示意，真实 native 栈仍可能受内联和优化影响，不能要求每个 C++ 源码函数都有独立的机器栈帧。

### 2. 用全局变量提供 Lua state 的入口

`main.cpp` 导出了一个全局指针变量：

```cpp
extern "C" {
lua_State* g_lua_state = nullptr;
}
```

创建 Lua state 后，将指针写入 `g_lua_state`；关闭 state 前，再将它清空。采集器可以按符号名找到这个变量，BPF 在每次采样时读取它当前保存的值。

这里需要分清两个地址：

```text
&g_lua_state          全局变量自身的地址，也就是指针槽位地址
g_lua_state          槽位中保存的 lua_State*，指向 Lua 状态对象
```

传给 BPF 的 `LUA_STATE_SLOT` 是前者。采集器初始化时只定位槽位，状态对象地址由 BPF 在实际采样时读取。

### 3. 先限定运行时范围

这个示例使用仓库中的 Lua 5.4，运行在 x86-64 Linux 或 WSL2 上，只支持单线程目标和唯一主 state。示例不创建协程，也不覆盖 yield、debug hooks、JIT，以及运行中装载或卸载代码模块的情况。

这些约束直接影响实现：单个全局主 state 无法自动指出当前正在执行哪个协程；如果同时存在多个线程或独立 state，也需要额外建立 TID 与活动 state 的关联。当前版本在启动时检查 `/proc/PID/task`，拒绝多线程目标。

## 二、从 ELF 和 maps 准备 BPF 所需的信息

初始化由 [`pylib/lua_layout.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/lua_layout.py) 的 `load_layout(pid)` 完成。它需要准备三类信息：

| 信息 | 后续用途 |
| --- | --- |
| `g_lua_state` 槽位的运行时地址 | BPF 读取当前 Lua state |
| Lua 结构成员偏移和 `StackValue` 大小 | BPF 按目标库的实际布局读取 Lua 对象 |
| `luaV_execute` 的运行时地址范围 | Python 在 native 栈中识别 VM 帧，确定 Lua 帧的插入位置 |

### 1. 结合 ELF 程序头与 maps 换算运行时地址

ELF 符号的 `st_value` 给出链接虚拟地址。对于 PIE 或共享库，实际装载位置还受到 ASLR 等因素影响，需要结合 `/proc/PID/maps` 换算：

```python
runtime_address = load_bias + symbol["st_value"]
```

`_maps(pid)` 解析带绝对路径的文件映射，保存地址范围、权限、文件偏移、设备号和 inode。同一个 ELF 的多个映射会分别保留。随后，采集器根据已打开文件的设备号和 inode，找出属于该 ELF 的映射。

`_load_bias()` 遍历可执行的 `PT_LOAD` 段，将段的文件偏移和链接虚拟地址向下页对齐，并与带 `x` 权限的映射匹配。对一个匹配项，计算：

```python
delta = mapping.offset - file_start
linked_address = virtual_start + delta
load_bias = mapping.start - linked_address
```

`mapping.offset` 是这条映射起点对应的文件偏移；`file_start` 是段的文件页面起点。两者之差说明映射从该段的哪一页开始。将同样的位移加到 `virtual_start` 上，就得到映射起点对应的链接地址，再与实际映射地址相减。

例如，以下数值是用于解释公式的假设数据：

```text
file_start     = 0x1000
virtual_start  = 0x5000
mapping.offset = 0x3000
mapping.start  = 0x7f0000007000

delta          = 0x2000
linked_address = 0x7000
load_bias      = 0x7f0000000000
```

各匹配项得到的偏移放进一个集合，只有候选值唯一时才继续。因此，不能简单地把某条 `r-xp` 映射的起点当成装载偏移，也不能在缺少 ELF 程序头时，一概使用“映射起点减文件偏移”。ELF 中文件偏移、链接地址与装载地址的关系可参考 [ELF 程序装载规范](https://gabi.xinuos.com/elf/07-pheader.html)。

主程序通过 `/proc/PID/exe` 打开，定位 `g_lua_state` 后，还要检查符号大小为 8 字节，并确认整个槽位落在主程序的可读映射内。

Lua 库则按 `liblua.so` 或 `liblua.so.*` 的路径名筛选，要求只有一个候选路径。读取时通过 `/proc/PID/root` 按目标的根目录解释库路径，并核对打开文件的设备号、inode 与映射一致，避免用已替换的新库去解释旧进程。这里匹配文件身份，不代表对文件内容做了完整性校验。

### 2. 从 DWARF 提取 Lua 结构布局

定位 `g_lua_state` 的槽位地址后，还需要准备读取 Lua 状态对象的字段偏移。BPF 在采样时拿到 `lua_State*`，才能据此访问 `ci`、`stack` 等字段。当前实现通过目标实际加载的 Lua 库中的 DWARF 调试信息提取这些偏移，而不是使用采集器本机头文件中的结构布局。

`FIELDS` 把 BPF 宏名映射为“类型名 + 成员路径”，例如：

```python
"OFF_LUA_STATE_CI": ("lua_State", "ci"),
"OFF_LUA_STATE_STACK": ("lua_State", "stack", "p"),
"OFF_CALLINFO_FUNC": ("CallInfo", "func", "p"),
"OFF_CALLINFO_PREVIOUS": ("CallInfo", "previous"),
"OFF_PROTO_SOURCE": ("Proto", "source"),
```

`_Types.offset()` 找到结构体或联合体定义，沿成员路径逐层累计 `DW_AT_data_member_location`。例如 `lua_State.stack.p` 需要累加 `stack` 相对 `lua_State` 的偏移，以及 `p` 相对 `stack` 所属类型的偏移。联合体成员共享起点，缺省位置可按 0 处理；需要动态 DWARF 表达式的偏移则不在当前支持范围内。

这里特意指定 `.p`，因为 Lua 的 `StkIdRel` 联合体既有普通运行时使用的指针成员，也有栈重新分配期间使用的临时 offset 成员。采样器需要识别的是指针形式；碰到更新中间状态时，还要依靠后续的结构校验拒绝无效数据。

`_lua_offsets()` 同时检查 `lua_ident` 包含 `Lua 5.4`，并要求 `StackValue` 为 16 字节。这些检查用于限定示例支持的布局，不能等同于对任意 Lua 5.4 构建的完整 ABI 验证，更不适用于 LuaJIT。

[![Lua状态访问路径：全局指针槽位、lua_State、CallInfo链，以及闭包到Proto和source字符串]({{ '/assets/images/ebpf-mixed-stack-sampling/lua-state-layout.svg' | relative_url }})]({{ '/assets/images/ebpf-mixed-stack-sampling/lua-state-layout.svg' | relative_url }})

*图 2：槽位地址负责找到对象，DWARF 成员偏移负责访问对象内部字段。CallInfo 链和 native 机器栈是两种不同的结构。*

### 3. 将布局转换成 BCC 编译参数

`Layout.cflags()` 将槽位地址、成员偏移和栈元素大小转换成 `-D` 参数，`profile.py` 再加入目标 PID 与 PID namespace 信息：

```python
layout = load_layout(args.pid)
namespace = Path("/proc/self/ns/pid").stat()
cflags = layout.cflags() + [
    "-DTARGET_PID=%d" % args.pid,
    "-DPIDNS_DEV=%dULL" % namespace.st_dev,
    "-DPIDNS_INO=%dULL" % namespace.st_ino,
]
bpf = BPF(src_file=str(ROOT / "pylib" / "bcc.c"), cflags=cflags)
```

BPF 随后可以直接使用 `LUA_STATE_SLOT`、`OFF_LUA_STATE_CI` 等常量。PID namespace 的设备号和 inode 则用于取得与采集器所见 PID 一致的目标身份。

`luaV_execute` 的地址区间保存在 `layout.vm_ranges` 中，交给用户态合并器，不作为布局宏注入 BPF。初始化末尾还会重读文件映射，若与开始时不同就拒绝继续；这个比较没有暂停目标，只能检测两次快照之间可见的映射差异。

## 三、BPF 在一次采样中保存两种栈信息

### 1. perf event 提供采样时机

[`profile.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/profile.py) 使用软件 `CPU_CLOCK` perf event，目标频率为 49 Hz：

```python
bpf.attach_perf_event(
    ev_type=PerfType.SOFTWARE,
    ev_config=PerfSWConfig.CPU_CLOCK,
    fn_name="sample",
    sample_freq=SAMPLE_HZ,
)
```

这里按 CPU 挂载事件，在 BPF 内筛选目标 PID，并要求 `tid == pid`。49 Hz 是每 CPU 的软件时钟采样频率，并不保证每秒收到 49 个目标样本。目标休眠、被抢占时没有它的 on-CPU 现场；目标处于内核态时，示例也会跳过并单独计数。

因此，最终图的权重来自**用户态 on-CPU 样本数**，不能用来直接解释锁等待或 I/O 阻塞时间。BCC 按在线 CPU 挂载事件的实现可对照 [attach_perf_event 源码](https://github.com/iovisor/bcc/blob/master/src/python/bcc/__init__.py)。

### 2. native 部分保存寄存器与原始栈字节

[`pylib/bcc.c`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/bcc.c) 的 `snapshot_native()` 保存 17 个寄存器，顺序符合 AMD64 DWARF 寄存器编号：

```text
RAX, RDX, RCX, RBX, RSI, RDI, RBP, RSP,
R8, R9, R10, R11, R12, R13, R14, R15, RIP
```

RIP 给出当前执行位置，RSP 给出用户栈读取起点；CFI 展开还可能依赖其他寄存器，所以不能只保留 RIP、RSP、RBP。

程序令 `stack_base = RSP`，从这个地址向更高地址复制最多 16 KiB。读取先处理当前页剩余部分，再按页和固定小块继续；发生读取失败时停止，保留此前成功复制的字节数。

这一阶段没有执行 native DWARF 解栈。BPF 保存的是“寄存器 + 栈内存副本”，具体调用链要由 Python 结合 ELF 展开信息恢复。达到 16 KiB 上限不自动说明调用链完整或不完整；一次读取失败也可能发生在解栈所需数据之后，最终要看展开结果。

### 3. Lua 部分沿 CallInfo 链读取逻辑帧

`snapshot_lua()` 首先从全局槽位读取状态指针，再按注入的偏移读取状态对象：

```c
read_pointer(LUA_STATE_SLOT, &state);
read_pointer(state + OFF_LUA_STATE_CI, &ci);
read_pointer(state + OFF_LUA_STATE_STACK, &stack);
read_pointer(state + OFF_LUA_STATE_STACK_LAST, &stack_last);
```

上面省略了错误处理。实际代码还会检查空 state、地址范围和对齐等条件。

Lua 的活动调用链从 `L->ci` 开始，沿 `CallInfo.previous` 从叶子向根遍历，直到内嵌的 `L->base_ci`。`base_ci` 是结束边界，本身不写入帧列表；最多保存 64 个 Lua/C CallInfo。

每个 CallInfo 的 `func.p` 指向 Lua 值栈中的函数槽位。BPF 检查槽位是否位于 `stack.p` 与 `stack_last.p` 范围内、是否按 `StackValue` 大小对齐，再读取 `TValue` 的类型标记，并结合 `callstatus` 判断帧类型：

| 帧类型 | 主要读取路径 | 保存的信息 |
| --- | --- | --- |
| Lua 函数 | `TValue → LClosure → Proto` | `callstatus`、Proto 地址、source、函数定义行 |
| light C function | `TValue → Value.f` | `callstatus`、C 函数地址 |
| C closure | `TValue → CClosure.f` | `callstatus`、C 函数地址 |

对于 Lua 帧，`Proto.source` 指向 `TString`，`Proto.linedefined` 表示函数定义行。source 的字符串内容在 BPF 中通过 `bpf_probe_read_user_str()` 复制到事件的 128 字节数组中。Python 拿到事件后就能构造 `lua:source:定义行` 标签，无需再访问目标当时使用的 Lua 堆对象。

这也说明当前输出没有自动恢复 Lua 函数名或采样点的精确执行行。后文用 `profile_entry` 等名字解释调用关系时，实际图中的标签仍是文件路径与函数定义行。

`callstatus` 还包含后续合并需要的 `CIST_C` 和 `CIST_FRESH`。BPF 负责保存这些标记，按 `CIST_FRESH` 切分执行段的工作在 Python 中完成。

### 4. 将同一次现场封装成一个事件

事件同时包含以下数据：

| 部分 | 内容 |
| --- | --- |
| 标识与时间 | 版本、大小、序号、时间戳、PID/TID、CPU |
| native 快照 | 17 个寄存器、栈起点、有效长度、读取标记和最多 16 KiB 字节 |
| Lua 快照 | state 地址、帧数、状态标记，以及最多 64 个 Lua/C 帧 |

当前固定事件大小为 27,344 字节。BPF 直接在 ring buffer 中预留记录，清零后依次调用 `snapshot_native()` 和 `snapshot_lua()`，再提交给用户态，避免把这个大对象放进 BPF 局部栈。

```c
struct sample_event *event = events.ringbuf_reserve(sizeof(*event));
/* 检查预留结果，清零并填写事件头。 */
snapshot_native(ctx, event);
snapshot_lua(event);
events.ringbuf_submit(event, 0);
```

预留失败会增加丢样计数。ring buffer 的 reserve/submit 与容量不足语义可参考 [内核文档](https://docs.kernel.org/bpf/ringbuf.html)。

把两类快照放在同一次 perf 回调里，可以避免用户态分别采两次、再拼接不同时间的现场。不过，采样可能恰好打断 Lua 更新数据结构的过程，因此指针、类型、槽位范围等校验仍然必需。读失败、深度超过 64 帧、source 可能截断等情况都会写入标记，留给用户态判断完整性。

## 四、Python 解开 native 栈并合并 Lua 栈

### 1. 只用快照中的寄存器和栈内存解栈

ring buffer 回调先通过 `decode_event()` 检查事件大小、版本、PID/TID、数组有效长度和状态标记，还会核对寄存器中的 RSP 与 `stack_base` 是否一致。只有 `stack_length` 范围内的字节被视为有效栈副本。

随后，`MixedStackBuilder` 将这些信息封装为 `Snapshot`，复用 [`malloc-trace/dwarf_unwind.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/malloc-trace/dwarf_unwind.py) 中的 libdwfl 解栈器。

libdwfl 根据当前 PC 所属模块的 CFI 规则，恢复上一层调用者的寄存器，再逐帧向外展开。这里有两个关键回调：初始寄存器回调返回事件中保存的 17 个寄存器；内存回调则把虚拟地址转换为快照内的偏移：

```python
offset = address - snapshot.stack_base
```

只有请求的 8 字节全部落在 `snapshot.stack` 范围内，读取才成功。**它不会用目标此刻的实时栈补齐旧样本。** 目标在 BPF 回调结束后已经继续运行，此时再读当前内存，会混入另一个时间点的数据。

DWARF 解栈仍然需要匹配的 ELF/CFI 元数据，完整性还受快照范围、CFI 是否存在和最大展开深度影响。当前默认最多恢复 127 个 native 帧，缺少 CFI 时不会退回猜测性的栈扫描或帧指针回溯。

对需要按返回地址查询的帧，解栈器使用 `pc - 1` 作为 `lookup_pc`，让地址落回调用点所属范围；激活现场的 PC 保持原值。它用于符号及 VM 区间查询，不是把所有帧都按某条指令长度回退。

### 2. 按 CIST_FRESH 拆分 Lua 执行段

native 解栈和 BPF 采集的 Lua 链都是叶子到根的顺序；[`mixed_stack.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/mixed_stack.py) 在合并时将它们转换为根到叶子。

关键问题是：**多个 Lua 函数帧，可能对应同一个 native `luaV_execute` 帧。** 不能拿两边的帧按数量逐个配对，也不能将整条 Lua 栈统一接到 native 栈末尾。

Lua 从 C 调用进入一次新的 `luaV_execute` 时，会将入口 CallInfo 标记为 `CIST_FRESH`。这个标志提供了“哪一帧开始对应一次新的 native VM 调用”的依据。`_lua_segments()` 的规则是：

1. 遇到带 `CIST_FRESH` 的 Lua 帧，开始一个新的 Lua 执行段。
2. 后续普通 Lua 帧追加到当前段，表示这一次 VM 执行中的 Lua → Lua 调用。
3. 遇到 `CIST_C` 帧时结束当前段。C 帧只参与识别边界，不额外生成标签，C/C++ 调用层级由 native 栈保留。

对于前面采样落在回调内 `cpp.work()` 的例子，会得到两个 Lua 执行段：

```text
段 1：profile_entry → lua_stage_one → lua_stage_two
段 2：lua_callback
```

此时回调中的 `lua_work()` 已经返回，所以它不在这次 `cpp_work()` 的祖先链上。若采样发生在 `lua_work()` 执行期间，第二段才会继续包含它。

### 3. 用 native VM 帧作为合并锚点

初始化时已经取得 `luaV_execute` 的运行时地址区间。合并器用 `lookup_pc` 判断 native 帧是否落在这个区间内，找到各次 VM 调用。它按地址范围识别锚点，不依赖函数名字符串。

```python
anchors = [index for index, frame in enumerate(native_frames)
           if any(start <= frame.lookup_pc < end
                  for start, end in vm_ranges)]
```

native VM 帧数量必须等于 Lua 执行段数量。满足条件后，按照根到叶子的顺序一一配对，把每段 Lua 帧插在对应的 `luaV_execute` 帧之后，其余 native 帧全部保留。

[![混合栈合并：两个native VM锚点分别插入两个Lua执行段，C++回调保持原有位置]({{ '/assets/images/ebpf-mixed-stack-sampling/merge-stacks.svg' | relative_url }})]({{ '/assets/images/ebpf-mixed-stack-sampling/merge-stacks.svg' | relative_url }})

*图 3：C++ 回调再次进入 Lua 时，对应第二个 VM 锚点。图中省略 Lua C API 等内部帧；实现会保留这些实际展开出的 native 帧。*

为了阅读方便，省略内部帧后的合并结果可以写成：

```text
native:main
  native:luaV_execute
    lua:test.lua:25          # profile_entry
      lua:test.lua:20        # lua_stage_one
        lua:test.lua:14      # lua_stage_two
          native:cpp_call_lua
            native:luaV_execute
              lua:test.lua:8 # lua_callback
                native:cpp_work
```

其中 Lua 标签以当前示例的定义行为准，source 路径在这里缩写为 `test.lua`；真实 native 名称还可能包含 C++ 参数签名和匿名命名空间信息。

### 4. 无法证明完整时，保留失败信息

正确的合并依赖两份快照完整、Lua 段结构有效、VM 锚点数量匹配。native 展开不完整、Lua 读取失败或截断、缺少 `CIST_FRESH`、锚点数量不一致时，当前实现不会强行拼接：

| 情况 | 输出方式 |
| --- | --- |
| 已有 native 帧，但无法完成混合栈合并 | 保留 native 帧，在根部添加 `[mixed_partial]` |
| 没有恢复出 native 帧 | 输出 `[native_failed]` 标记 |
| 没有活动 Lua 帧，且 native 栈与零个 VM 锚点相符 | 可以输出完整的 native-only 栈 |

采集器还会统计失败原因与 BPF 丢样数量。目标存活期间发现代码模块映射变化时，会停止采集，避免继续使用不匹配的模块信息。目标退出后排队的旧事件则继续使用会话保存的模块信息解析，不把复用 PID 的新进程当成原目标。

## 五、从混合栈计数生成火焰图

### 1. 采集过程中持续解栈和聚合

`Collector.record()` 在收到每条事件时就执行解码、native 解栈和混合栈合并，再按完整路径计数：

```python
result = self.builder.build(sample)
self.stacks[result.frames or ("[empty_stack]",)] += 1
```

`self.stacks` 是一个 `Counter`，键为根到叶子的帧元组，值为该调用路径的样本数。相同叶子函数如果来自不同调用者，会形成不同的键。完成处理后，无需长期保留这一条样本的原始寄存器与栈副本。

停止采集时，先 detach perf event，防止继续写入，再排空 ring buffer，将已经收到的样本处理完。Ctrl+C、SIGTERM 或目标退出都会进入收尾流程；SIGKILL 则无法执行这段清理逻辑。

### 2. 输出 folded 文件并调用 FlameGraph

输出时，将每条路径的帧用分号连接，在末尾附加样本数。下面只是格式示例，路径经过缩写，计数用于演示：

```text
native:main;native:luaV_execute;lua:test.lua:25;lua:test.lua:20;lua:test.lua:14 120
native:main;native:luaV_execute;lua:test.lua:25;lua:test.lua:20;lua:test.lua:14;native:cpp_work 80
```

生成的 `.folded` 文件交给 FlameGraph 子模块的 `flamegraph.pl`，输出交互式 SVG。`pylib/flamegraph.py` 使用临时 `palette.map` 将 Lua 帧固定为绿色，native 帧使用稳定的暖色，并在图上标注颜色说明；不需要修改 FlameGraph 子模块。

阅读这种 CPU 火焰图时，横向宽度表示样本占比，纵向表示调用深度，顶部显示各路径的叶子帧；横轴不是时间轴。一条路径越宽，表示它在本次采样中出现得越多。具体说明可参考 [Flame Graphs 官方介绍](https://www.brendangregg.com/flamegraphs.html)。

`[mixed_partial]` 和 `[native_failed]` 路径也会参与计数，便于看到观测失败占了多少样本。即使没有 complete 样本，只要存在已累计的栈记录，也可以生成 SVG；只有栈计数为空时才只写 folded 文件，并提示未生成火焰图。

### 3. 运行示例并查看结果

以下命令在示例目录执行，依赖包名沿用 README 中的 Debian 13 环境：

```bash
cd trace/ebpf-trace/native_lua_stack_profile
sudo apt-get install python3-bpfcc python3-pyelftools libdw1t64 perl
git submodule update --init --recursive
cmake -S . -B build
cmake --build build -j
./build/profile_test
```

还需要 CMake、C/C++ 编译器，以及当前内核适用的 BPF、perf event、ring buffer 和头文件支持。另开一个终端，进入同一目录，用程序输出的实际 PID 启动采集：

```bash
sudo /usr/bin/python3 profile.py --pid <PID>
```

在采集器终端按 Ctrl+C，结果写入 `profile-output/` 下按 PID 和时间命名的 `.folded`、`.svg` 文件。先查看终端中的丢样与失败原因统计，再用浏览器打开 SVG；绿色 Lua 帧能帮助辨认脚本层级，暖色 native 帧则保留解释器、C++ 回调及其他机器调用层级。

实现入口可按下面的顺序阅读：

| 文件 | 对应环节 |
| --- | --- |
| [`main.cpp`、`lua_api.cpp`、`test.lua`](https://github.com/fanjinsong/trace/tree/fb2abd9/ebpf-trace/native_lua_stack_profile) | 目标程序和跨语言调用关系 |
| [`pylib/lua_layout.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/lua_layout.py) | ELF、maps、DWARF 和布局宏 |
| [`pylib/bcc.c`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/bcc.c) | perf 回调内的 native / Lua 快照 |
| [`pylib/sample_events.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/sample_events.py) | C / Python 事件格式与解码校验 |
| [`pylib/mixed_stack.py`](https://github.com/fanjinsong/trace/blob/fb2abd9/ebpf-trace/native_lua_stack_profile/pylib/mixed_stack.py) | native 解栈适配、Lua 分段与合并 |
| [`profile.py`、`pylib/flamegraph.py`](https://github.com/fanjinsong/trace/tree/fb2abd9/ebpf-trace/native_lua_stack_profile) | 事件消费、路径计数和火焰图输出 |
