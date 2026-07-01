# Step 3A · compression + extraction 改挂 StepEnd(impl)

> sub1 只读本文档。前置:Phase 2 完成(StepEnd 已是 per-step fire)。

## 背景
compression/extraction 现挂 PostTurnComplete(turn 末一次)。改挂 StepEnd(每 step 评估),更灵敏(spec §Phase 3)。todo 仍在 PostTurnComplete(3B 搬),所以 PostTurnComplete 事件本步**保留**(3B 删)。

## 目标
1. **compression-hooks**:register 从 `PostTurnComplete` 改 `StepEnd`。每 step 的 StepEnd 评估 contextUsage > l1Threshold → 压缩;`contextUsage` 从 StepEnd ctx 取(每 step 的 usage 算)。PreCompact/PostCompact 仍作压缩内嵌子事件。
2. **extraction-hooks**:register 从 `PostTurnComplete` 改 `StepEnd`。每 step 查阈值游标(cursor),跨过则增量抽取。m5-extractors 测试改写(触发点从 turn 末改 step 中)。
3. **核查 PreCompact firing**(spec §10 #5):grep 确认 compression 真的 fire PreCompact;若死代码 → 删 metrics 的 PreCompact 分支(3B 处理 metrics 时一并)。

## 要改的文件
- `src/runtime/hooks/compression-hooks.ts`(PostTurnComplete → StepEnd)
- `src/runtime/hooks/extraction-hooks.ts`(同)
- `src/runtime/agent-loop.ts`(StepEnd ctx 已带 contextUsage? 若没有补上 —— 每步 usage 推导 contextUsage 传入)
- `tests/unit/m5-extractors.test.ts`(触发点改 StepEnd)

## 边界
- ❌ 不动 todo-cleanup / metrics / TurnEnd(3B)。
- ❌ 不删 PostTurnComplete 事件(todo 还在,3B 删)。
- ❌ 不外置循环(2C 已做)/ 不动 turns 表(4A)。
- 注意:compression 在 StepEnd 每 step 评估,但 `compressIfNeeded` 内部已有"未超阈值直接 return"的廉价 guard,不会每 step 真压缩 —— 保留这个 guard。

## 自检
- typecheck + build:lib + vitest green(m5-extractors 改写后 green)。
- 手动:contextUsage 超阈值的 turn → 在某 step 的 StepEnd 触发压缩(不是 turn 末)。
