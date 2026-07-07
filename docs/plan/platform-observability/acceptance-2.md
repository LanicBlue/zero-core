# acceptance-2:provider_usage 表 + 记录

对应 `sub-2.md`。

## 用例

1. **表存在**:migration 后 `provider_usage` 表存在(含 fresh DB)。
2. **打点正确**:用 provider X / model Y 跑一步 → 行 `(X, Y, <当前hour>, source, calls=1, tokens累加)`。
3. **同桶累加**:同 hour 多次调用 → 同一行 calls/tokens 累加(upsert,不多行)。
4. **mid-session 切 provider**:session 中途从 X 切 Y → X、Y 各自独立行(归因正确)。
5. **source 维度**:不同 source(user/work/cron/background)→ 不同行(source 是键一部分)。
6. **天视图**:`series(granularity=day)` = GROUP BY date(hour_bucket),返每日总量。
7. **小时视图**:`series(granularity=hour, range=24h)` 返近 24 桶。
8. **留存**:30 天前数据被清理,近 30 天保留。
9. **error 计**:失败 step 对应桶 errors +1。

## 验证手段

- 单测:ProviderUsageStore upsert 累加 + series(hour/day)聚合 + 留存清理。
- 集成:mock usage 事件(带 provider/model/source)→ store 落正确行。
- typecheck 三层 + vitest(sibling cwd)。
