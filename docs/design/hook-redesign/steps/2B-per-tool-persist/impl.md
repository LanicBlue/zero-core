# Step 2B · per-tool result 即时落库(impl)

> sub1 只读本文档。前置:2A GO。

## 背景
现在 tool-call/result 只在 finish-step(StepEnd)一次性落库。崩溃在工具副作用后、落库前 → 副作用孤儿。本步让每个工具一完成就立即持久化其 block(result 已知),不等 finish-step。这是 case2 恢复的硬前提(spec §Phase 2 持久化与恢复 #1)。

## 目标
- `PostToolUse` / `PostToolUseFailure` 触发时,立即把该 tool block(含 result/isError)upsert 到当前 step 的落库(用 turn-recorder 的 `persistCurrentStep` 或新方法,upsert 当前 step row)。
- 落库时机:工具执行完(PostToolUse)就写一次,不等 finish-step。StepEnd 仍做最终的 step 落库(含 usage),两者用 upsert 幂等不冲突。
- 仍走 per-loop registry(1B)+ 新事件名(1C:PostToolUse/PostToolUseFailure)。

## 要改的文件
- `src/runtime/hooks/turn-hooks.ts`(或新建 tool-persist-hooks):在 PostToolUse/PostToolUseFailure handler 里加即时落库。
- `src/runtime/turn-recorder.ts`:可能需暴露"按 toolCallId 即时 upsert 当前 step"的方法(若 persistCurrentStep 不够细)。
- `src/runtime/agent-loop.ts`:PostToolUse/PostToolUseFailure 的 trigger ctx 已带 toolCallId/result(1C 后),确认透传。

## 边界
- ❌ 不外置 step 循环(2C)、不加 OnLLMError(2C)、不动 resume(2D)。
- ❌ 不改 appendStep/upsertStep schema(P4)。
- ❌ 不动 dangling tool-call 合成(2E)—— 本步只管"完成的工具即时落库"。

## 自检
- typecheck + build:lib + vitest green。
- 手动:一个 step 内 2 工具,跑到第 1 个 PostToolUse 后立刻查 DB → 第 1 个 tool block 已在(含 result);不必等 finish-step。
