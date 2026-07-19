# Acceptance 03：Flow 关系与进度可视化

对应 [Plan 03](plan-03-flow-visualization.md)。

- [ ] Board 可跨多个 Definition 查看，并保留各自 state/view 配置。
- [ ] dependency、lineage、related 图层可独立开关且视觉含义不同。
- [ ] transitive blocker 与 downstream impact 与服务端图查询一致。
- [ ] split/merge 不被画成 gate，related 不显示 blocked。
- [ ] 返工循环不会产生倒退的伪百分比。
- [ ] 无 progressProjection 时只显示 state/milestone/blocker/Work/age 摘要。
- [ ] 跨 Project 未授权节点不泄露 title/document/definition。
- [ ] 1,000 instance fixture 可搜索、折叠和局部展开，阈值写入 result。
- [ ] Overview blocker/attention 深链接可复现相同 Flow 筛选。
- [ ] WorkRun contribution 在 Plan 04 前缺席或明确 unavailable，不显示伪事件。

## 布局与容量

- [ ] Board/Dependency/Lineage/Related/Timeline 共用一个 view switch、filter/deep-link 合同，
  不重复 Project shell。
- [ ] Board column 240–320px、header sticky，只有 Board 自身横向滚动；100+ card/column
  使用 virtualization 或分页。
- [ ] Graph filter rail 240px 可折叠，宽屏 canvas ≥720px，480/420px detail drawer 以
  overlay 打开。
- [ ] dependency/lineage/related 不只靠颜色区分，edge pattern、arrow/endpoint、legend
  均不同。
- [ ] 初始 graph ≤150 visible nodes；>300 要求筛选/折叠，1,000 instance 仍可搜索和局部展开。
- [ ] Timeline 1,000/10,000 event 不全量挂 DOM；compact 只保留 time/Flow/event 主列。
- [ ] `900 × 600` graph 可视高度 ≥360px；toolbar 换行不隐藏 view switch/search。
- [ ] 三档视口与 0/50/1,000 instance、5/20 state、长 title/blocker/portal 有视觉证据。
