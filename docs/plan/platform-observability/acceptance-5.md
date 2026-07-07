# acceptance-5:② provider 观测暴露

对应 `sub-5.md`。

## 用例

1. **Platform providerStats**:每 provider 一行,含 enabled/in-flight/queue/累计 tokens/calls/err%/avg latency;文本格式。
2. **数据源正确**:tokens/calls 来自 ProviderUsageStore 累计;in-flight/queue 来自并发管理器;latency 进程内 running。
3. **IPC provider:stats**:返全 provider 累积 JSON。
4. **IPC provider:usage**:granularity=hour → 近 24 桶;granularity=day → 近 30 桶;每桶按 model 分 series(供堆叠)。
5. **IPC provider:queue**:返该 provider 排队 session 清单(sessionId/agentId/tier/waitedSince)。
6. **disabled provider**:disabled 的也列出(标 disabled,统计 0)。
7. **无 cost/余额**:不返成本/余额字段。

## 验证手段

- 单测:Platform providerStats 文本输出 + 字段齐。
- 单测:IPC provider:usage hour/day 聚合 + per-model series。
- 单测:IPC provider:queue 内容(接 sub-3 getWaiting)。
- typecheck 三层 + vitest(sibling cwd)。
