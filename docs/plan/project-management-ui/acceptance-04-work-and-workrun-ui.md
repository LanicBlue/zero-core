# Acceptance 04：Work 与 WorkRun 管理

对应 [Plan 04](plan-04-work-and-workrun-ui.md)。

- [ ] Work Catalog 按真实 WorkDefinition version/binding/trigger 展示。
- [ ] validate/publish/activate 复用 Project management API 与 server validator。
- [ ] 旧 Worker 功能按 reconciliation 结果迁移，不保留第二套活动 Work 配置。
- [ ] queued/deferred/running/waiting/terminal 与 runtime API 一致。
- [ ] Flow-triggered run 可追溯 origin event/instance/revision。
- [ ] defer/prioritize/switch/retry/cancel 使用 expected revision。
- [ ] switch 只在 runtime 安全 handoff 后改变 current invocation。
- [ ] 无 Work 能力的主体只读，伪造跨 Session mutation 稳定拒绝。
- [ ] reconnect 不丢 defer reason、order、actor 或 current run。
- [ ] Overview Work attention 深链接可恢复相同 queue/filter。
- [ ] Definition 反向引用与 Flow timeline 只来自真实 WorkDefinition/WorkRun API。

## 布局与容量

- [ ] Definitions/Runs/Queue 使用稳定二级导航与 deep link，不同时堆在一个长页面。
- [ ] Definitions row 52px，Runs/Queue row 44px，Action 列宽屏保留 120/132px，不被长名称
  或 reason 挤掉。
- [ ] 100 WorkDefinition、1,000 WorkRun 使用 pagination/virtualization；实时更新不重置
  scroll/filter/selection。
- [ ] detail drawer 宽屏 480px、标准 420px，并按 status/origin/invocation/events/actions
  排列，compact 占可用宽。
- [ ] `1024 × 768` 收起次要列；`900 × 600` 使用双行 compact row，无页面横向滚动。
- [ ] safe switch 560px impact dialog 明确 current/target revision 与 handoff；cancel 显示真实
  取消边界。
- [ ] Queue order 有键盘操作，不只支持拖拽；pending mutation 不乐观伪造 runtime state。
- [ ] 三档视口和 0/20/100 Definition、0/100/1,000 Run、长 reason/stale/readonly 有视觉证据。
