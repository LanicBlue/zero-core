# Acceptance 05：Compacting 与统一 UI/API

- [ ] compacting 是独立可见主状态，并显示 phase。
- [ ] commit 不会因 Stop 留下半提交 cursor/context。
- [ ] compacting 中 input/task event 不丢失，也不热切换当前上下文。
- [ ] commit 后 Stop 优先于 queue/handoff。
- [ ] UI 能区分 agent_wait、background_barrier、provider/tool capacity。
- [ ] queue paused/count 与 background count 独立显示。
- [ ] HTTP initial snapshot、WS 增量与重连后的 revision 一致。
- [ ] UI 不再从多个布尔事件自行推导权威状态。

