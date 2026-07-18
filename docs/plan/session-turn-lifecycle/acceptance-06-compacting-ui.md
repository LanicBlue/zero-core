# Acceptance 06：Compacting 与统一 UI/API

对应 [Plan 06](plan-06-compacting-ui.md)。

- [ ] compacting 是独立可见主状态，并显示 phase。
- [ ] commit 不会因 Stop 留下半提交 cursor/context。
- [ ] compacting 中 input/task event 不丢失，也不热切换当前上下文。
- [ ] commit 后 Stop 优先于 queue/handoff。
- [ ] UI 能区分 agent_wait、background_barrier、provider/tool capacity、provider_retry、
  provider_quota、provider_suspended 和 provider_config。
- [ ] quota/suspended 状态显示可信 resetAt/nextRetryAt；未知恢复时间不伪造倒计时。
- [ ] Provider preview reset 与 compaction generation 各自 fencing，不会相互回退 revision。
- [ ] 首页同时展示全部 Provider，aggregate state 可展开到 availability key，不再依赖单选
  selector 才能发现故障。
- [ ] Provider 行显示受影响 Session/Task、nextProbeAt/resetAt 和 sanitized error，不泄露
  credential/account secret。
- [ ] “重试 Provider”只在 manualRetry.allowed 时启用；一次点击只发一个 probe，防连点、
  stale revision 和 command result 均有明确反馈。
- [ ] known resetAt 前不允许 retry；config_required 提供 Settings 入口。
- [ ] Session/Task 页面只链接到首页 Provider 状态，不复制 retry 按钮。
- [ ] usage/queue 历史详情保留，但不作为 runtime health 真相源。
- [ ] queue paused/count 与 background count 独立显示。
- [ ] HTTP initial snapshot、WS 增量与重连后的 revision 一致。
- [ ] provider_runtime_changed 事件驱动首页刷新，轮询仅为断线兜底。
- [ ] UI 不再从多个布尔事件自行推导权威状态。

## 首页布局与容量

- [ ] Provider Control Center 位于 KPI 与 Agents/今日任务之间，不留在可能掉出首屏的页尾。
- [ ] `1400 × 900` 下 header、KPI、5 个 Provider 行和至少 300px 主区空间可见，无横向滚动。
- [ ] `1024 × 768` 使用 compact table；`900 × 600` 至少显示 Provider header + 3 行，其他
  内容通过页面主滚动到达。
- [ ] ≥1180px 的 Action 列固定保留 120px；900–1179px 合并次要列但不隐藏 retry/settings。
- [ ] 0/1/4/5/10 Provider 均使用页面主滚动，不在 collapsed Provider list 内制造第二个滚动区。
- [ ] detail drawer 在宽屏 520px、标准窗口 480px、窄屏占可用宽；关闭后恢复触发行焦点。
- [ ] drawer 中 100 waiter 不全量渲染，使用前 20 项分页或 virtualization。
- [ ] 40 字符 Provider 名、本地化长错误、99 waiters/tasks、长 resetAt 不重叠或挤掉 Action。
- [ ] `1400 × 900`、`1024 × 768`、`900 × 600` 与 0/1/4/5/10 Provider 组合有截图或视觉回归证据。
- [ ] 状态不只依赖颜色；ellipsis 内容可从 tooltip/drawer/accessible name 完整读取。
