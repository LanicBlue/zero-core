# Acceptance 02：Cancellation Tree 与 Stop

- [ ] Stop 后 snapshot 经 cancelling 到稳定状态。
- [ ] provider concurrency/retry/circuit、tool limiter、Wait、AskUser 和 blocking child
  均能被同一 Turn signal 唤醒。
- [ ] Stop 后 queued input 不自动启动。
- [ ] Stop 不取消显式 background task。
- [ ] AskUser 无悬挂 promise/card，旧回答不能进入后续 Turn。
- [ ] cancellation 与 error/superseded 在 DTO、日志、metrics 中可区分。
- [ ] compaction commit 临界段不会被破坏；settle 后遵守 Stop。
- [ ] UI 不在 backend 确认前伪造 agent_end。
