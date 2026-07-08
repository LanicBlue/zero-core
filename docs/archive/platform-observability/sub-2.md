# sub-2:provider_usage 表 + 记录

> ②.2 数据基础。provider 层独立用量表(与 session 各记各的),喂 sub-5 观测 + sub-6 图表。对应 design ②.2。依赖 sub-1(source)。

## 任务

1. **新 DB 表 `provider_usage`**(provider 层,与 session 独立):
   - 键 `(provider, model, hour_bucket, source)`,值 `calls · inputTokens · outputTokens · cacheRead · cacheWrite · errors`。
   - hour_bucket = hour-floor ISO(UTC)。PK = (provider, model, hour_bucket, source)。
   - migration 新建表(SessionDB 自管)。
2. **打点**:usage 事件(agent-loop `finalizeOneStep` [:1367](../../../src/runtime/agent-loop.ts#L1367) 发 `type:"usage"` 事件 [:1373](../../../src/runtime/agent-loop.ts#L1373))携带 `providerName + modelId + source`。
   - session-manager 处理 usage 事件时 → `ProviderUsageStore.upsert({provider,model,hour,source,tokens,calls,error?})`(同桶累加)。
   - error:该 step 若失败,error 计 +1。
3. **新 `ProviderUsageStore`**(server):upsert(累加)+ 查询:`cumulative(provider?,model?)` SUM、`series(provider, granularity:hour|day, range:24h|30d)` GROUP BY hour_bucket / date(hour_bucket)。
4. **留存 ≥30d**:定期清 30 天前数据(类 turn_state 清理 [:921](../../../src/server/session-db.ts#L921))。

## 范围

- 只建表 + 记录 + 查询接口。暴露(Platform/IPC)在 sub-5。
- provider/model 在 finalizeOneStep 处都已知(`this.config.providerName/modelId`);source 从 turn(sub-1)。

## 风险

- usage 事件现按 session 累积;加 provider/model/source 字段要同步事件结构 + session-manager 处理。
- mid-session 切 provider → 不同 provider 行(归因正确,这正是目的)。
- 高频写(每 step):upsert 同桶累加,不是每步一行,可控。

## 验收

见 `acceptance-2.md`。
