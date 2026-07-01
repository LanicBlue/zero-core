# Step 2C · executeStream 外置 step 循环 + OnLLMError + step 级重试(impl)

> sub1 只读本文档。前置:2A GO、2B 完成。**Phase 2 最高风险步**,引擎核心改动。

## 背景
现 executeStream 一次 `streamText({stopWhen: stepCountIs(200)})` 跑完所有 step,重试是 turn 级(重跑整条 stream)。改成外层 while 每次跑 1 step,失败只重试该 step,并加 OnLLMError hook。

## 目标
1. `executeStream()` 重构为外层 while:
   ```
   while (应继续 && !aborted):
     trigger StepStart
     pre = trigger PreLLMCall   // 每 step 注入(原 prepareStep 的 appendMessages 语义并入此处)
     result = streamText({ stopWhen: stepCountIs(1), model, messages, system, tools, abortSignal, providerOptions, ...(ctx) })
     try:
       await processStreamEvents(result)   // 单步:text/tool-call/tool-result/finish-step
       await finalizeOneStep(result)        // 该步收尾:seal+usage+StepEnd 落库
       messages = [...messages, ...result.response.messages]
     catch err:
       trigger OnLLMError({error, errorClass})   // handler 可 {retry, delayMs}
       处理见下(重试该 step 或抛出)
     if (该步无 tool-call) break   // 模型不再调工具 → turn 结束
   ```
2. **注入并入 PreLLMCall**:原 SDK `prepareStep` 回调删除;StepStart + PreLLMCall 在外层循环 step 开头 fire,appendMessages 经 registry concat 合并后并入 messages(spec §7)。
3. **OnLLMError + step 级重试**:单步 streamText 抛错 → trigger OnLLMError(ctx 含 error + classifyError 的 errorClass);handler 可返回 `{retry?, delayMs?}`。默认:transient(timeout/rate_limit/server_error/network)→ 退避重试**该 step**(messages 不变,重发该步);`prompt_too_long` → aggressivePrune(当前 step 上下文)后重试;fatal(auth 等)/ 耗尽 → 抛出 → TurnError。
4. **runWithRetry 重构**:turn 级重试循环下沉到 step 级(executeStream 内每步自带重试);runWithRetry 退化为"调 executeStream + 处理整体 abort/超时",或并入 run()。
5. abort 语义:外置循环 abort 在 step 边界检查(signal.aborted → break);step 内 streamText 的 abortSignal 仍生效。

## 要改的文件
- `src/runtime/agent-loop.ts`(executeStream / processStreamEvents / runWithRetry 重构)
- 可能 `src/runtime/turn-recorder.ts`(配合单步 finalize)

## 边界
- ❌ 不动 resume(2D)—— 本步只管"正向跑 + 单步重试"。
- ❌ 不动 deferred 消费 / dangling 合成 / task 链接(2E)。
- ❌ 不改 step 级检查点 lastCompletedStepSeq 的持久化(2D 配 resume 做;本步可在内存推进,持久化留 2D)。
- ❌ 不动 turns 表 schema(P4)。

## 自检
- typecheck + build:lib + vitest green;**回归 m3-orchestrate**(多 step tool-use 链)必须 green。
- 新单测见 accept。
