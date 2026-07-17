# Acceptance 03：Invocation Inbox、软插入与 Handoff

- [ ] 队列项保存完整 immutable invocation，不继承旧 Turn source/context。
- [ ] 普通 chat queue 不新增持久表。
- [ ] WorkRun durable queue 与普通 inbox 所有权不混合。
- [ ] next_step 不中断正在运行的 provider/tool。
- [ ] retry 不重复消费，Turn 结束前未注入项会降级而不滞留。
- [ ] waiting/needs_input/barrier handoff 在同一状态事务中替换 active Turn。
- [ ] running 中的新 invocation 默认排队。
- [ ] Stop 后 queue paused；明确的新 invocation 可按契约启动。

