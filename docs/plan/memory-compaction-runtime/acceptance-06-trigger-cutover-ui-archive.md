# Acceptance 06：Trigger Cutover、UI、Archive 与 Hardening

对应 [Plan 06](plan-06-trigger-cutover-ui-archive.md)。

- [ ] preferred 只在 TurnEnd/Wait、threshold、semantic idle、foreground TTL 四项同时满足时
  启动。
- [ ] hard 在完整 StepEnd/PreLLM fit guard 生效，不截断运行中 tool。
- [ ] 新 semantic Step 取消未启动 TTL wait；已 Snapshot 的 cycle 继续，新增 Step 进 tail。
- [ ] preferred P2 让位 P1；hard P0、Work/Cron/Subagent inheritance 和 archive P4 与设计一致。
- [ ] prompt-too-long、manual compact、main/delegated 全部只走新 coordinator。
- [ ] 生产代码无自然语言 compression request、Agent compression tool、nested AgentLoop、
  single-turn guard 或旧直接 compression path。
- [ ] UI/HTTP/WS/reconnect 一致显示 trigger、phase、两个 branches、pass progress、
  `compaction_blocked` 和 retry。
- [ ] Archive MemoryRun 恰好一个原模型逻辑 call、P4、运行中不写 Wiki；失败后 archive best-effort
  语义不变。
- [ ] Memory commit 不热替换已经构造的 foreground prompt。
- [ ] telemetry 不包含 Wiki正文、prompt、credential 或原始 transcript。
- [ ] 超长单 Turn 可多次 cycle；专用小窗口模型可 multi-pass；最终低于 target 或给出稳定
  blocked/config error。
- [ ] Stop/Wait/handoff/provider quota/concurrency/restart race 无丢 input、半提交或旧事件污染。
- [ ] 活动文档不再描述顺序 memory→rewrite、Agent 自判压缩或一次 Turn 最多一次压缩。
- [ ] typecheck、build、unit、integration/E2E、links 全部通过，无 skipped/only/timeout 放宽。
