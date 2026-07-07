# sub-3:并发队列观测 + 优先级

> ②.3 + ②.4。给并发队列加身份观测 + 优先级调度。对应 design ②.3/②.4。依赖 sub-1(turnSource→tier)。

## 任务

### ②.3 队列观测

- `ConcurrencyQueue.waiters` 结构加身份:`{ resolve, reject, abortHandler, sessionId, agentId, tier, waitedSince }`([concurrency-queue.ts](../../../src/runtime/concurrency-queue.ts))。
- `acquire(opts?: { signal, sessionId, agentId, tier })` —— 把身份挂 waiter。
- 新 `getWaiting(): { sessionId, agentId, tier, waitedSince }[]`(替代只返数的 getWaitingCount,后者保留)。
- `ProviderConcurrencyManager.getQueue(name).getWaiting()` → 每 provider 排队清单。

### ②.4 优先级调度

- **AsyncLocalStorage** 传 tier:agent-loop.run 开始 set `{ sessionId, source→tier }`(tier 映射:user=P1, work/cron=P2, background=P3);provider-factory 中间件 acquire 时读 ALS([provider-factory.ts:66](../../../src/runtime/provider-factory.ts#L66)/[:90](../../../src/runtime/provider-factory.ts#L90))。
- `release()` 改**按 tier 出队**:选 tier 最小(最高优先)的 waiter;同 tier 内按 waitedSince FIFO(最早优先)。
- 严格优先级:P1 先于 P2 先于 P3。background(P3)可能饿死 —— **接受**(本期;防饿死的 aging 后续再做)。

## 范围

- 改 `concurrency-queue.ts`(waiter 结构 + release)、`provider-factory.ts`(acquire 传 ALS tier)、`agent-loop.ts`(set ALS by source)、ALS 模块新建。
- 不改并发上限配置逻辑(reconfigure 不变)。

## 风险

- release 改非 FIFO 是**运行时行为改动**,需回归(并发场景下不出错、abort 仍正确摘 waiter)。
- ALS 跨 async 边界:确保 agent-loop.run 的 scope 覆盖所有 LLM 调用(含 subagent?subagent 是独立 loop,各自 set ALS,OK)。
- 严格优先级下 background 饥饿 —— 已接受,acceptance 标注。

## 验收

见 `acceptance-3.md`。
