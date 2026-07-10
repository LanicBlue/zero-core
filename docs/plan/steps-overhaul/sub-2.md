# sub-2:阶段1 recorder choke point(大 tool result 外置)

## 范围
tool result >16K bytes 时,在 `TurnRecorder.updateToolResult` 这个唯一 choke point 外置到文件 + steps 存指针(非 PostToolUse modifiedResult)。

## 依赖
sub-1(steps 表)。

## 改动点
- `src/runtime/turn-recorder.ts` `updateToolResult`:加 size 判断;>16K bytes → 写外置文件(`~/.zero-core/tool-outputs/<hash>.<ext>` 之类)+ 存指针(摘要 + 文件路径 + 原 seq)。≤16K 原样存。
- 外置文件位置/命名规则(见 design:与 archives 同根 `~/.zero-core/`)。
- tool 类型策略(一次性/可廉价重跑的可截;昂贵/不可重跑的落盘保留)—— 保留可配置。
- 验证 `turn-hooks.ts:133-140` 的 persist 路径 + `agent-loop.ts:1835` 都过 recorder.updateToolResult → 都自动指针化。

## 关键不变量
- **不用 PostToolUse modifiedResult**(那是返回值,到不了持久化 handler `turn-hooks`,它读 ctx.result 原始先跑 → 窗口/崩溃破不变量)。
- steps 永远存指针,完整字节只在外置文件;第一次进 recorder 就是指针(无原始窗口)。
- 不依赖 hook 注册顺序。

## 参考
design.md「阶段 1」「可行性已验证」(冲突点①)。
