# Step 2E · 延迟消费注入 + dangling tool-call 兜底 + tool-call↔task 链接(impl)

> sub1 只读本文档。前置:2C/2D 完成。Phase 2 收尾步。

## 背景
三件收尾(spec §Phase 2 #2/#3/#5 + 注入讨论):
1. control message / insert_now 现在注入即消费 → 失败 attempt 会吃掉。改成 StepEnd 成功才消费。
2. 落库捕获到 `status:"running"`(无 result)的 tool-call 且无法 resume → 合成 `[interrupted]` result,保证 rebuild 合法。
3. Agent/Orchestrate dispatch 时把 taskId 记到 tool-call block;父恢复时 dangling 的 Agent tool-call → 按 taskId resume 委派任务(不重新 invoke)。

## 目标
1. **task-control-hooks**:PreLLMCall 注入 control message 时**只标记已投递**(不清 controlMessage);StepEnd 该 step 成功后才 `updateDelegatedTask({controlMessage: undefined})`。需在 StepEnd handler 里识别"本 step 注入过该 task 的 control message"。
2. **input-queue-hooks**:PreLLMCall `consumeInsertNow` 改"peek/标记已投递";StepEnd 才真正出队列(从 InputQueueStore 删)。
3. **dangling 兜底**:turn-hooks(或 StepEnd/TurnError 落库路径)若捕获到 tool block `status:"running"` 且无 result → 合成 `{result:"[interrupted]", status:"error"}` 再落库。
4. **tool-call↔task 链接**:`Agent`/`Orchestrate` 工具 dispatch 时,把委派的 `taskId` 写到 tool-call block(`toolCallId` ↔ `taskId` 映射,落库)。父 step 恢复(2D resume)遇到 dangling Agent tool-call → 查 taskId → `resume` 该 delegated task(SubagentDelegator 暴露 resume),拿结果回填该 tool-call 的 result。

## 要改的文件
- `src/runtime/hooks/task-control-hooks.ts`、`src/runtime/hooks/input-queue-hooks.ts`(延迟消费 + 加 StepEnd handler)
- `src/server/input-queue-store.ts`(peek/mark + step-bound consume)
- `src/runtime/hooks/turn-hooks.ts` 或落库路径(dangling 合成)
- `src/runtime/tools/agent.ts` / `orchestrate-tool.ts`(dispatch 记 taskId 到 block)
- `src/runtime/subagent-delegator.ts`(暴露 resumeTask(taskId);父恢复路径调用)

## 边界
- ❌ 不外置循环/重试/resume 机制(2C/2D 已做)—— 本步只在既有机制上加"延迟消费 + 兜底 + 链接"。
- ❌ 不退役 turns 表(4A)。
- ❌ 不搬 compression/extraction 等(P3)。

## 自检
- typecheck + build:lib + vitest green。
- 手动:request_finish 带 control message 注入到一个会失败重跑的 step → 重跑时 control message 仍在 → 成功后才消失。
- 手动:abort 在 Agent 工具执行中 → 父 step 该 tool-call dangling → resume → 按 taskId resume 子任务 → 结果回填。
