# Step 2A · Spike 结果 — AI SDK 单步循环可行性

> **门结论:GO.** 4 个问题全部通过。AI SDK v6 `streamText({ stopWhen: stepCountIs(1) })`
> 配合外层 while 可以干净地单步循环,Phase 2 可推进到 2C。
>
> 环境:`ai@6.0.182`、`@ai-sdk/provider@3.0.10`、`vitest@4.1.8`、Node 20+。
> Spike 代码:`tests/spike/step-loop-spike.test.ts`(隔离,不入生产路径)。
> 运行:`npx vitest run --config tests/spike/vitest.spike.config.ts tests/spike/step-loop-spike.test.ts`
> 结果:**4 passed (4)**。

## 摘要

| #  | 问题 | 结论 | 一句话证据 |
|----|------|------|-----------|
| Q1 | 单步 tool-call 续跑 | **GO** | 两步 streamText,step0 tool-call→step1 text-finish,`finalMessages` roles = `[user, assistant, tool, assistant]` |
| Q2 | abort | **GO** | mid-stream abort → fullStream emit `abort` 事件,无 `finish-step` 残留(无虚假 StepEnd 落库) |
| Q3 | 单步重试 | **GO** | transient 错只重跑当步(call2→call3),step0 的 tool-call/result 原样保留,roles = `[user, assistant, tool, assistant]` |
| Q4 | finish-step 时机 | **GO** | 每个单步 streamText 都 emit `finish-step` + `usage`(token 数与 fixture 一致),StepEnd 落库可依赖 |

---

## 关键实现要点(给 2C 的交接)

外层 while 骨架(实测可行):

```ts
let messages = [...initial];
while (!done) {
  const result = streamText({
    model, messages, tools,
    stopWhen: stepCountIs(1),
    abortSignal,
  });
  for await (const ev of result.fullStream) {
    // 处理 text-delta / tool-call / tool-result / finish-step / abort ...
  }
  // ⚠️ result.response 是 PromiseLike,必须先 await 再读 .messages
  const response = await result.response;
  messages = [...messages, ...response.messages];
  if (lastStepHadNoToolCall) done = true;
}
```

**两个陷阱(实测踩到):**

1. **`result.response` 是 `PromiseLike`,不是同步对象。**
   `ai@6` 的类型:`readonly response: PromiseLike<LanguageModelResponseMetadata & { messages: Array<ResponseMessage> }>`。
   写 `await result.response.messages` 会得到 `undefined`(`await` 一个普通属性无意义),
   导致 messages 不累加、下一 step 看不到上一步的 tool-call/tool-result。
   正确写法:`const response = await result.response; response.messages`。
   *这是 2C 必须照抄的不变量。*

2. **V2 spec mock 触发 "compatibility mode" 警告。**
   现有 `src/runtime/mock-language-model.ts` 用 `specificationVersion: "v2"`。
   `ai@6` 的 `streamText` 同时接受 V2/V3,但 V2 走兼容路径,日志里会反复打
   `AI SDK Warning: ... "specificationVersion" is used in a compatibility mode`。
   功能不受影响(spike 4/4 通过),但 2C 之后可考虑把 mock 升到 V3
   (`specificationVersion: "v3"` + `LanguageModelV3StreamPart`)清掉噪音。
   非阻塞。

---

## Q1 — 单步 tool-call 续跑

**结论:GO.**

**场景:** mock 第 1 个 model call 吐 `tool-call(echo, {value:"hello"})` + `finish(tool-calls)`,
第 2 个 model call 吐 `text("All done.")` + `finish(stop)`。外层 while 跑两轮 streamText。

**实测 trace(节选):**

```
step 0: events = [start, start-step, tool-input-start, tool-input-delta,
                  tool-input-end, tool-call, tool-result, finish-step, finish]
        finishReason = "tool-calls"   hadToolCall = true
        finishStepUsage = { inputTokens:12, outputTokens:3, totalTokens:15 }
step 1: events = [start, start-step, text-start, text-delta, text-end,
                  finish-step, finish]
        finishReason = "stop"         hadToolCall = false
        finishStepUsage = { inputTokens:20, outputTokens:4, totalTokens:24 }

finalMessages roles = [user, assistant, tool, assistant]
totalStreamTextCalls = 2
```

**断言:** `steps.length === 2`,`steps[0].hadToolCall === true`,
`steps[1].finishReason === "stop"`,roles 含 `tool`。**全通过。**

**含义:** 外层 while + `stepCountIs(1)` + `await result.response` → `.messages` 累加,
续跑正确。tool-result 由 SDK 自动注入(mock 吐 tool-call,SDK 执行 tool.execute,
生成 tool-result 并喂给下一步),无需外层手动拼 tool-result。

---

## Q2 — abort

**结论:GO.**

**场景:** mock 延迟 50ms/part,外层在 80ms 时 `ac.abort()`,同时消费 `result.fullStream`。

**实测:**

```
seenEvents = [start, start-step, text-start, text-delta, abort]
caught      = <no-throw>            // fullStream 不抛,以 abort 事件终止
finish-step 出现? = false            // 无虚假 StepEnd
```

**断言:** 消费者不抛(干净终止),`finish-step` 不出现(abort 后无 StepEnd 落库)。**通过。**

**含义:** abort 信号在 `fullStream` 上体现为一个 `abort` 事件而非抛错。
2C 实现需显式监听 `ev.type === "abort"` 判定中断(不能只靠 try/catch)。
无残留 `finish-step` —— StepEnd 落库不会被 abort 污染。

> 注:`ai@6` 对 abort 的默认行为是 emit `abort` 事件 + 干净关闭流;若想强制抛错,
> 可配 `streamText` 的 error 处理或检查 `abortSignal.aborted`。
> 当前 zero 的 `agent-loop.ts` 已有 `if (signal.aborted) break` 兜底,2C 沿用即可。

---

## Q3 — 单步重试

**结论:GO.**

**场景:** call 1(step0)= tool-call + finish(tool-calls);call 2(step1) **抛 transient 错**;
call 3(step1 重试)= text + finish(stop)。外层 try/catch 包单步 streamText,失败重试同一步。

**实测 stepRecords:**

```
step 0: events = [...tool-call, tool-result, finish-step, finish]
        toolCall = true   retried = false        // 一次成功
step 1: events = [...text-delta, finish-step, finish]
        toolCall = false  retried = true         // 第 2 次成功(call2 抛 → call3 成功)
finalMessages roles = [user, assistant, tool, assistant]
```

**断言:** step0 未重试且含 tool-call;step1 重试一次后成功;`tool` role 计数 = 1
(step0 的 tool-result 没被重发)。**全通过。**

**含义:** 单步 streamText 抛错后,只要**不**在 catch 里推进 `messages`(只重发同一步的
streamText,messages 不变),前序步骤的 tool-call/tool-result 完整保留,不重放。
这正是 Phase 2 step-centric 引擎想要的"局部重试"语义。
2C 的重试逻辑要在 `messages = [...messages, ...response.messages]` **之前**判定成功 ——
抛错的那步 response.messages 不应被采纳(实测:抛错时 `result.response` 不可用)。

---

## Q4 — finish-step 时机

**结论:GO.**

**场景:** 两步 fixture 各带独立 usage(step0: 12/3,step1: 20/4)。
断言每个单步 streamText 都 emit `finish-step` 且携带 usage。

**实测:**

```
step 0: finishStepSeen = true  usage = {inputTokens:12, outputTokens:3, totalTokens:15}
step 1: finishStepSeen = true  usage = {inputTokens:20, outputTokens:4, totalTokens:24}
```

**断言:** 每步 `finishStepSeen === true`,`usage.totalTokens` 为 number,
step1 usage 与 fixture 完全一致。**全通过。**

**含义:** `stepCountIs(1)` **不抑制** `finish-step` 事件。每个单步 streamText 完成时
照常 emit `finish-step` + usage,StepEnd 落库依赖的钩子点完整保留。
2C 在单步模式下监听 `finish-step` 即可拿到该步的 token usage,无需改 StepEnd 落库逻辑。

> 注:usage 还自动补了 `inputTokenDetails: {}` / `outputTokenDetails: {}` 空对象 ——
> SDK 标准结构,zero 现有 reading 代码取 `inputTokens`/`outputTokens`/`totalTokens` 不受影响。

---

## 结论与建议

**门通过。Phase 2 可进入 2C(外置 step loop 到 executeStream)。**

2C 实现交接清单:
1. 外层 while 骨架按本文「关键实现要点」照抄。
2. **必须** `const response = await result.response; response.messages`(不要 `await result.response.messages`)。
3. abort 判定:监听 `fullStream` 的 `abort` 事件 + 保留 `signal.aborted` 兜底。
4. 单步重试:try/catch 单步 streamText,**抛错时不推进 messages**,只重发该步。
5. StepEnd 落库:继续监听 `finish-step`(单步模式下照常 emit,带 usage)。
6. (可选,清噪音)2C 之后把 `src/runtime/mock-language-model.ts` 升到 V3 spec。

**无 NO-GO 项。无需 Phase 2 回退方案。**
