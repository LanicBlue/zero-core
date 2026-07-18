# Acceptance 00：Post-Dependency Reconciliation

对应 [Plan 00](plan-00-post-dependency-reconciliation.md)。

- [ ] baseline 包含 Wiki Final 与 Session Lifecycle Final 的 result/merge commit。
- [ ] 记录环境、dirty files、数据库文件/连接 owner、schema version 和测试基线。
- [ ] Core summary/cursor、Wiki patch/revision/request id、prompt refresh 的真实 API 映射完整。
- [ ] Session supervisor、compacting branches、Provider priority、safe point、Stop/Wait 的真实
  API 映射完整。
- [ ] main/delegated/Work/Cron/archive/manual caller inventory 无遗漏。
- [ ] transcript placeholder、截断推进 cursor、reopen 丢失、single-turn guard 和 AgentLoop
  重入五项均有可重复证据或上游已修复证据。
- [ ] 32K–1M threshold/token-estimate baseline 有机器可读结果。
- [ ] `cacheTtlMs` 空值实际回退 60 分钟；所有“6 分钟”残留位置已列出。
- [ ] 没有用旧接口 adapter、双写或 dead-path mock 掩盖上游合同缺失。
- [ ] 本阶段没有改变生产 compression/memory 语义。
- [ ] `npm run typecheck`、`npm run build:lib`、相关 unit 和 `npm run check:links` 通过。

result 必须给出后续每阶段的真实文件/类型/测试映射；发现硬冲突时本 acceptance 不得 PASS。
