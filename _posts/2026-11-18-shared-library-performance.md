---
title: ".so lib可能让程序变慢？"
date: 2026-11-18 00:00:00 +0800
category: 工程实践
tags: [GCC, ELF, CPython, LTO]
description: "从嵌入 CPython 时遇到的性能差异说起，梳理 ELF 共享库的符号抢占、PLT/GOT 与 LTO。"
---

多年前，我在一个程序里嵌入 CPython，发现链接 `libpython.so` 时，同一段 Python 脚本比把解释器静态链接进主程序慢了不少。当时改用静态链接解决了问题，没继续追查。最近借助 AI 回头梳理，发现 ELF 共享库的符号抢占可以解释这种差异。至于它在当时占了多少，还得靠控制变量的测试来确认。

## 开销从哪里来

Linux 下构建 `.so` 通常用 `-fPIC` 生成位置无关代码。共享库中默认可见的全局符号可能被进程里的同名定义抢占，即使引用和定义都在同一个库里。为了支持运行时绑定，可抢占的函数调用可能经过 PLT（过程链接表），全局数据访问可能通过 GOT（全局偏移表）取地址。库内能确定目标的引用则可以直接绑定。 [GCC 代码生成选项](https://gcc.gnu.org/onlinedocs/gcc/Code-Gen-Options.html#index-fPIC)、[ELF 符号可见性](https://gabi.xinuos.com/elf/05-symtab.html#symbol-visibility)

间接访问本身有开销，符号抢占还会影响编译优化。保留抢占语义时，即使 GCC 看得到函数体，也得考虑运行时会调用另一个实现，因此内联、跨函数常量传播等优化会受限。如果解释器的热路径频繁调用这些函数，差异就可能累积到脚本运行时间上。 [GCC 符号抢占选项](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html#index-fsemantic-interposition)

## 怎么优化

- **控制导出。** 用 `-fvisibility=hidden` 默认隐藏内部符号，再用 `__attribute__((visibility("default")))` 标记需要公开的 API。库内调用可以绑定到已知的内部实现。 [GCC 可见性选项](https://gcc.gnu.org/onlinedocs/gcc/Code-Gen-Options.html#index-fvisibility)
- **放宽编译器对抢占的假设。** `-fno-semantic-interposition` 保留符号导出，让 GCC 假设替换实现具有相同的语义和副作用，从而可以基于本库的实现做内联等优化。 [GCC 符号抢占选项](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html#index-fsemantic-interposition)
- **在链接时绑定库内引用。** `-Wl,-Bsymbolic` 让库内对本库全局符号的引用绑定到本库定义，函数和数据都受影响。这样可以减少部分间接访问，内联仍由编译器决定。 [GNU ld 链接选项](https://sourceware.org/binutils/docs/ld/Options.html#index-Bsymbolic)

这两个选项可能让库内调用直接使用本库定义的函数，绕过 `LD_PRELOAD` 提供的替换实现。对 `libc` 或其他共享库的外部符号引用，动态链接器仍按原有规则查找。例如，`malloc`、`free` 如果仍是运行时解析的外部引用，就可以照常通过 `LD_PRELOAD` 加载 tcmalloc 或 mimalloc 来接管这些调用。 [glibc 分配器替换](https://sourceware.org/glibc/manual/latest/html_node/Replacing-malloc.html)、[TCMalloc 用法](https://gperftools.github.io/gperftools/tcmalloc.html#usage)、[mimalloc 动态替换](https://github.com/microsoft/mimalloc#dynamic-override-on-linux-bsd)

LTO 让 GCC 在生成 `.so` 时看到多个源文件的实现。缩小导出范围或放宽抢占约束后，LTO 有更多机会跨文件内联和传播常量。比较静态库和共享库时，值得固定编译器、优化级别和 PGO 配置，只改变要验证的选项。 [GCC LTO 选项](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html#index-flto)

CPython 也采用了这项编译优化。从 3.10 起，用支持该选项的 GCC 构建共享版 `libpython` 并启用 `--enable-optimizations` 时，构建系统会加入 `-fno-semantic-interposition`。LTO 可通过 `--with-lto` 单独开启。 [CPython 构建文档](https://docs.python.org/3.10/using/configure.html#cmdoption-enable-optimizations)
