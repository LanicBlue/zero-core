# Final Acceptance：Project Management UI

> 只在 Acceptance 00–06 全部通过后执行。

- [ ] Project selector、header、Overview、Flows、Work、Wiki、Settings 信息架构成立。
- [ ] projectId/section/deep link 可恢复，多 Project 和窄窗口可用。
- [ ] Overview 正确聚合健康/attention/activity，但不是跨领域真相源。
- [ ] Wiki 管理复用 Wiki Final 的 API、组件语义和持久 job，无重复实现。
- [ ] 用户可管理同 Project 多个 Definition 及独立 active version。
- [ ] draft、validate、publish、activate、diff、simulate 全链路成立。
- [ ] FlowView 与 semantic contract 分离。
- [ ] Board、dependency、lineage、related、timeline 和派生进度准确。
- [ ] WorkDefinition 管理使用 Project management API，没有旧活动配置双写。
- [ ] WorkRun queue 状态与 runtime 一致，操作遵守能力与 revision。
- [ ] Requirement import 无损、幂等且不双写。
- [ ] Shell/Overview、Studio、Flow views、Work 和 Importer 均符合各自线框、列宽、drawer、
  scroll owner 与容量合同。
- [ ] `1400 × 900`、`1024 × 768`、`900 × 600` 无非语义页面横向滚动，主操作和 selected
  Project identity 始终可达。
- [ ] 固定大数据 fixture、light/dark、200% zoom 和可重现视觉回归证据通过。
- [ ] 性能、重连、权限、可访问性和全局验证通过。
- [ ] 独立验收 Agent 明确记录 PASS。
