# Step 3B · todo→StepEnd + metrics 重做 + TurnEnd 闭合 + 删 PostTurnComplete(impl)

> sub1 只读本文档。前置:3A 完成。Phase 3 收尾。

## 背景
最后一批操作下沉 + metrics 重做 + TurnEnd 加 turn 边界闭合 + PostTurnComplete 操作全搬完后删除该事件。

## 目标
1. **todo-cleanup-hooks**:`PostTurnComplete` → `StepEnd`(每 step 完成后查全 done → clearSessionTodos + emit todos_update[])。
2. **metrics-hooks 重做**:砸 `recordTokenEstimate` 粗估(msgCount×50 / len÷4),改读真实 `usage`(StepEnd 的 usage 已带 input/output tokens)。保留 streaming/idle/error:`trackSessionStreaming`@SessionStart、`trackSessionIdle`@SessionClose、`trackSessionError`@TurnError。核查 PreCompact 分支(3A 若确认死则删)。
3. **TurnEnd turn 边界闭合**:turn-hooks 加 TurnEnd handler —— 闭合当前 turn_group + 推进 turn_seq(下个 user 输入 turn 属性 +1)。现 turn_seq 是 TurnStart 时 getTurnCount 隐式取;TurnEnd 显式闭合更干净(实现:标记 turn_group 闭合,确保下次 TurnStart 的 turn_seq 正确 +1)。
4. **删 PostTurnComplete**:3A+本步把它的全部操作(compression/extraction/todo)搬走后,从 hook-types 删 `PostTurnComplete`、agent-loop 删其 trigger(L252)、删相关 context 类型。

## 要改的文件
- `src/runtime/hooks/todo-cleanup-hooks.ts`(PostTurnComplete → StepEnd)
- `src/server/metrics-hooks.ts`(砸粗估 + 改读 usage)
- `src/runtime/hooks/turn-hooks.ts`(加 TurnEnd handler)
- `src/core/hook-types.ts`(删 PostTurnComplete + 类型)
- `src/runtime/agent-loop.ts`(删 PostTurnComplete trigger L252)

## 边界
- ❌ 不动 turns 表 legacy API(4A)。
- ❌ 不外置循环(2C 已做)。
- ⚠️ TurnEnd 的 turn_seq 推进要与 TurnStart 的取值一致(不串 turn)。metrics 读 usage 要确认 StepEnd ctx 真的带 usage(2C/2D 应已带)。

## 自检
- typecheck + build:lib + vitest green。
- grep `"PostTurnComplete"` 在 src → 0。
- 手动:连续两个 turn → turn_group 递增;全部 todo 完成后某 step 的 StepEnd 清空 todo。
