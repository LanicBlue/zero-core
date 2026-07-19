# Acceptance 01：Policy、Snapshot 与 CompactionAtom

对应 [Plan 01](plan-01-policy-snapshot-atoms.md)。

- [ ] 32K/64K/128K/200K/256K/1M 的 preferred/hard/target/summaryCap 表驱动测试精确通过。
- [ ] output/protocol reserve 能把 `effectiveHard` 限制在安全输入预算内。
- [ ] tool call/result、AskUser/answer 和未闭合语义组不能被 boundary 切开。
- [ ] 不保留完整 Turn；同一 Turn 的两个不同 sealed StepEnd 可生成递增 boundary。
- [ ] pending user message、in-flight Step 和 `seq > B` 只属于 fresh tail。
- [ ] continuity reference 不进入 coverage/digest/cursor。
- [ ] Snapshot 创建后不可变；前台追加 Step 不改变 B 或历史 digest。
- [ ] TurnEnd/Wait + TTL eligibility 与 hard StepEnd eligibility 有 fake-clock 测试。
- [ ] 语义 Step 会取消未启动 TTL wait；stream/heartbeat/retry telemetry 不会。
- [ ] Memory/Compression bypass call 不刷新 `lastForegroundLLMCallAt`。
- [ ] 空 Provider TTL 使用 60 分钟；实现和注释无“6 分钟”分叉。
- [ ] 本阶段测试不需要真实 Provider/Wiki/DB，且生产行为未切换。
