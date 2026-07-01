# Step 1C · 原子重命名 + Session 级所有权归位(impl)

> sub1 只读本文档。这是 Phase 1 最大的原子步:事件重命名 + session 级 hook 移到 agent-service,一次改完保持 green。

## 背景
1B 已接好 per-loop registry(旧事件名)。本步一次性:(a) hook-types 改 14 新名 + 新 context 类型 + loopKind 字段;(b) agent-loop 所有 trigger 改新名,删 SessionEnd 空 trigger;(c) agent-service 加 Session 级 fire(SessionStart@loop建 / SessionClose@loop销);(d) 所有 hook 模块 register 改新名。

## 命名映射(严格按此)
- `UserPromptSubmit` → **删**(无消费者;门控暂缺,后续需要再加)
- `SessionStart`(agent-loop per-run)→ **`TurnStart`**
- `Stop` → **`TurnEnd`**
- `StopFailure` → **`TurnError`**
- `PostStep` → **`StepEnd`**
- `PrepareStep` → **`StepStart`**
- `SessionEnd`(agent-loop 空 trigger)→ **删**
- `PreLLMCall` → 不变
- `PostTurnComplete` → **暂保留**(其操作在 P3 才搬到 StepEnd/SessionClose;本步只改名... 但 PostTurnComplete 不在新 14 hook 里。处理:本步**保留 PostTurnComplete 事件名**,挂在 run() 原 PostTurnComplete 触发点不改,P3 再删并搬操作。hook-types 暂留 PostTurnComplete)
- `PreToolUse`/`PostToolUse`/`PostToolUseFailure` → 不变
- 新增 agent-service fire:**`SessionStart`**(loop 建)、**`SessionClose`**(loop 销)—— 注意这两个是新语义(实例生命周期),与已改名为 TurnStart 的旧 per-run SessionStart 不撞名了(旧的已改名)。

## 目标
1. `src/core/hook-types.ts`:`HookEventName` 改为 14 新名 **+ 临时保留 `PostTurnComplete`**(P3 删)。`BaseHookContext` 加 `loopKind?`。新增 context 类型:`TurnStartContext`(原 SessionStartContext)、`TurnEndContext`(原 StopContext)、`TurnErrorContext`(原 StopFailureContext)、`StepStartContext/Result`(原 PrepareStep*)、`StepEndContext/Result`(原 PostStep*)、`PostLLCallContext`(空,占位)、`OnLLMErrorContext`(error/errorClass/可选 retry/delayMs)、`SessionCloseContext`。按 level 分节注释。删 UserPromptSubmit* / SessionEnd* 类型。
2. `src/runtime/agent-loop.ts`:所有 trigger 改新名;**删** 两处 `SessionEnd` 空 trigger(L270/314);`PostTurnComplete` 触发点(L252)名不变。每个 trigger ctx 仍带 loopKind(1B 已加)。
3. `src/server/agent-service.ts`:loop 创建两处(534/701 + loops.set 后)`await loop.registry.trigger("SessionStart", {agentId, sessionId, loopKind:"main", timestamp})`;loop 销毁处(abort 302/agent 删 195/session 删 1193/关停 1183)`trigger("SessionClose", ...)`。抽 `fireSessionStart/Close(loop, agentId, sessionId)` helper。关停路径:SessionClose 必须在 `sessionManager.dispose()`(L1174)/ DB close **之前**。
4. 所有 hook 模块 register 改新事件名:turn-hooks(SessionStart→TurnStart, Stop→TurnEnd, StopFailure→TurnError, PostStep→StepEnd)、durable-hooks(同)、notification/rag/provider-options/workflow-context(PreLLMCall 不变)、task-control/input-queue(PrepareStep→StepStart)、metrics-hooks(SessionStart 保留=现在 agent-service fire;SessionEnd→SessionClose;Stop→TurnEnd;StopFailure→TurnError)、compression/todo/extraction(PostTurnComplete 不变,暂留)。

## 要改的文件
- `src/core/hook-types.ts`、`src/runtime/agent-loop.ts`、`src/server/agent-service.ts`、`src/runtime/hooks/*.ts`、`src/server/*-hooks.ts`、`tests/unit/m5-extractors.test.ts`(PostTurnComplete 不变,但若引用了改名的类型要同步)

## 边界(不要做)
- ❌ 不搬 compression/extraction/todo/metrics 的操作到 StepEnd/SessionClose —— P3 做(本步它们仍在 PostTurnComplete/旧点,只是事件名 metrics 的 Stop→TurnEnd 这种跟随改名是允许的)。
- ❌ 不外置 step 循环、不加 OnLLMError/PostLLCall 的 fire —— P2 做(本步只加它们的类型,不 fire)。
- ❌ 不动 turns 表 / appendStep —— P4。
- ❌ `PostTurnComplete` 本步**保留**(事件 + 触发点都不动),P3 删。

## 自检
- typecheck 三层 + build:lib + vitest 全 green。
- grep 旧名 `"Stop"|"StopFailure"|"PostStep"|"PrepareStep"|"SessionEnd"|"UserPromptSubmit"`(代码引用,排除注释/字符串字面量里的历史记录)→ 0。`"SessionStart"` 仅在 agent-service fire + types + hook 模块(metrics)。
