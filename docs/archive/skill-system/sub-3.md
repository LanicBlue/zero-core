# sub-3:`[skills]/` Shell 虚拟路径通道(脚本,resource 段)

> progressive disclosure 第 3 段(resource:脚本执行)。复用 sub-2 解析器,把 `[skills]/` 接进 Shell,让 agent 能跑 skill 自带脚本。对应 design 决策 4。**依赖 sub-2(解析器)**。

## 任务

1. **Shell 接入**(`src/tools/bash.ts`):
   - 命令里扫描 `[skills]/<id>/<rel>` token → 经 sub-2 解析器 → 真实路径 → 替换进命令 → 执行。
   - 真实路径命令不变(Shell 现有 autoApprove/scope 流程)。
2. **Windows 反斜杠**:解析出的真实路径在 win32 带 `\`,直接塞进 bash 命令会被当转义 → 替换时**引号包裹 + 转正斜杠**(或 POSIX 路径)。
3. **`SKILL_DIR` 环境变量**:执行 skill 脚本时设 `SKILL_DIR=<真实 baseDir>` env(协议脚本可能依赖自定位)。

## 范围

- 只接 Shell;**复用 sub-2 解析器**(不重写)。
- 不动 Read 通道(sub-2)、prompt(sub-4)、UI(sub-5/6)。
- **可后置**:核心 skill 链路(读 SKILL.md)在 sub-2 + sub-4 即可用,脚本是增强。

## 风险

- **Shell token 替换稳健性**:引号、变量、多路径;只替换 `[skills]/...` token。先朴素正则 + 单测边界。
- **Windows 路径注入**(F3):反斜杠进 bash 需引号 + 转正斜杠。
- **命令注入面**:解析后真实路径含空格/特殊字符时,替换进命令要正确转义,防注入。

## 验收

见 `acceptance-3.md`。
