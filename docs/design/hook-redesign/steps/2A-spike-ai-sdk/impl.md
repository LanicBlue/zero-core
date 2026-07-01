# Step 2A · Spike AI SDK 单步循环(GATE · impl)

> sub1 只读本文档。本步是 **Phase 2 的门**:先验证 AI SDK 能干净地单步跑,不通则 Phase 2 回退。

## 背景
执行引擎要从"一次 streamText(200 step)"改成"外层 while 每次跑 1 step"。这依赖 AI SDK 的单步行为正确。spike 先证,再动引擎。

## 目标
写一个**独立** spike(临时脚本或临时测试,放 `tests/spike/` 或 `scripts/spike/`,跑完可删),验证以下问题,把结论写进 `docs/design/hook-redesign/steps/2A-spike-ai-sdk/RESULT.md`:

1. **单步 tool-call 续跑**:`streamText({ stopWhen: stepCountIs(1), ... })` 配合工具,模型第一步调工具、第二步拿到 tool-result 后继续 —— 用外层 while 多次 streamText 是否能正确续跑(messages 带 tool-call + tool-result 喂回)?
2. **abort**:`abortSignal.abort()` 在单步 streamText 进行中,是否干净抛 AbortError、无残留?
3. **单步重试**:某步 streamText 抛 transient 错,外层只重跑该步(不重发前序),messages 状态是否正确?
4. **finish-step 时机**:单步 streamText 是否仍 emit `finish-step` + usage(StepEnd 落库依赖它)?

## 实现
- 用项目已配的 mock provider(见 memory project-minimax-role / project-e2e-test-setup 的 mock)或直接 mock LanguageModelV3,构造"第一步 tool-call、第二步 text finish"的场景。
- 外层 while:while(!done){ result = streamText({stopWhen:stepCountIs(1), messages, tools, ...}); await consume(result.fullStream); messages = [...messages, ...result.response.messages]; if(无 tool-call) done=true; }
- 记录每步的 events / response.messages / 是否正常结束。

## 边界
- ❌ 不改 `src/runtime/agent-loop.ts` 的真实 executeStream(那是 2C)。
- ❌ spike 代码不进生产路径(隔离在 tests/spike 或 scripts/spike)。

## 自检
- spike 能跑、有明确输出。
- RESULT.md 含 4 个问题各自的"通/不通 + 证据(日志/断言)"。
