# Step 2D · step 级 resume + durable step 检查点(impl)

> sub1 只读本文档。前置:2C 完成。

## 背景
现 resume() 从 turnSeq 重跑整个 turn;durable 检查点是 turn 级(turn_state phase)。改成 step 级:检查点记 per-session `lastCompletedStepSeq`,崩溃后续跑从下一 step。UI 恢复也从 step 推导(spec §Phase 2 #2/#4)。

## 目标
1. **step 检查点持久化**:每 StepEnd(finish-step 成功)推进 per-session `lastCompletedStepSeq`(写 turn_state 或新字段/表,记录该 session 最后完成 step 的 seq)。
2. **resume() 改 step 级**:`resume()` 读 `lastCompletedStepSeq`,从下一 step 续跑(不重跑已完成 step);messages 已含已完成 step 的 tool-call/result(2B 即时落库 + StepEnd 保证)。
3. **durable-hooks 重构为 step 级**:turn_state 的 turn 级 phase(pending/tools_executing/completed/failed)→ step 级检查点。`createTurnState`(TurnStart)→ 初始化 step 检查点;`completeTurnState`(TurnEnd)/`failTurnState`(TurnError)→ 标 session 级 done/failed;`updateTurnPhase`(PostToolUse "tools_executing")→ 改为 StepEnd 推进 lastCompletedStepSeq。
4. **doRecoverIncompleteSessions 改用 lastCompletedStepSeq**:`getIncompleteTurns` → 改查"未 done 的 session 检查点";resume 传 lastCompletedStepSeq(而非 turnSeq 重跑)。
5. UI 恢复从 step 推导(读源码核对 sessionManager.track* 的调用点)。

## 要改的文件
- `src/runtime/agent-loop.ts`(resume)
- `src/server/durable-hooks.ts`(step 检查点)
- `src/server/session-db.ts`(turn_state schema 加 last_completed_step_seq,或新查询)
- `src/server/agent-service.ts`(doRecoverIncompleteSessions 改用 step 检查点)
- `src/runtime/hooks/turn-hooks.ts`(StepEnd 推进检查点,若不由 durable 做)

## 边界
- ❌ 不外置循环(2C 已做)、不动 OnLLMError(2C)。
- ❌ 不动 deferred 消费 / dangling 合成 / task 链接(2E)。
- ❌ 不退役 turns 表 / appendTurn(4A)—— turn_state 表本步可加列但不动 turns 表 legacy API。
- ⚠️ DB 新列(若加 last_completed_step_seq)必须 5 处同步([[feedback-fresh-db-migrations]])。

## 自检
- typecheck + build:lib + vitest green。
- 手动:一个 turn 跑 3 step 后 kill 进程 → 重启 → resume → 从第 4 step 续,前 3 step 不重跑。
