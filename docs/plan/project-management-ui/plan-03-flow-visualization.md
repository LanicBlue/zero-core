# Plan 03：Flow 关系与进度可视化

## 目标

让用户从 Project 级别理解多个 Definition 下的 FlowInstance、阻塞关系、拆分/合并来源和
当前执行进度，而不把派生展示写回 Flow。

## 依赖

Acceptance 00–02 通过。

## 实施范围

- Definition/state Board，支持 terminal、blocked、ready、stale 筛选；
- dependency graph：direct/transitive blocker、milestone、impact preview；
- lineage graph：split/merge parent/source/target；
- related graph：label/context，不显示为阻塞；
- timeline：transition reason/actor/revision、relation 和 document；预留稳定 WorkRun
  contribution，由 Plan 04 接入真实 runtime API；
- 跨 Project portal node、权限收窄和 missing target；
- 派生 progress summary；
- 只有 FlowView 显式配置时显示 percentage，并标注 projection；
- 大图折叠、局部展开、搜索和深链接。

本阶段不得用旧 Worker event 或 mock WorkRun 填充 timeline/Overview。

## 布局方案

Flows/Instances 使用 focus mode。Definitions 是 Plan 02 Studio；本阶段新增同一 shell 内的
`Board | Dependency | Lineage | Related | Timeline` 二级 view switch，不创建平行页面壳。

```text
┌ View switch / definition / state / terminal / search / saved view / … 48px ┐
├ Filter rail 240px ─┬ Board / Graph / Timeline workspace ────────────────────┤
│ Definitions        │                                                        │
│ State/status       │                    detail drawer 480/420px (overlay)   │
│ Blocker/age        │                                                        │
└────────────────────┴────────────────────────────────────────────────────────┘
```

Filter rail 可收为 44px；detail drawer 宽屏 480px、标准 420px 并以 overlay 打开，不永久
挤压 graph/board。toolbar 与当前 view/filter 进入 deep link。

### Board

- 每个 state column 宽 280px、最小 240px、最大 320px；column header sticky；
- Board 只有自身的语义横向滚动，页面外层不横向滚动；
- card 高度目标 88–120px，只显示 title、definition/state、blocker、work/age 摘要；
- 完整 documents、relations、history 进入 480/420px detail drawer；
- 每列超过 100 card 使用 virtualization 或分页；拖动不作为唯一 transition 入口，键盘/
  action menu 可执行同一操作；
- 多 Definition 时用 group header/label 区分，不把不同 state 名机械合并为一列。

### Dependency/Lineage/Related Graph

- 同一时刻只选择一种主关系模式；辅助 milestone/portal layer 可切换；
- filter rail 240px，canvas flex 且宽屏不低于 720px；detail drawer overlay 480/420px；
- dependency 使用实线箭头 + blocker icon，lineage 使用另一种线型/端点，related 使用虚线；
  颜色只是辅助；
- 默认查询 root/筛选结果的局部 neighborhood，不一次绘制全部 1,000 instances；
- 初始可见不超过 150 nodes，交互扩展超过 300 visible nodes 时要求收窄筛选或折叠，服务端
  结果仍可搜索；
- minimap、fit selection、reset layout 和 keyboard focus 可用；portal/missing/unauthorized
  node 有稳定占位尺寸，避免布局跳动。

### Timeline 与进度

- Timeline 使用 full-width virtualized table/list，sticky header 44px；
- 宽屏列：time 144、Flow min 220、event 160、actor 140、revision 100、summary flex；
- <900px 只保留 time、Flow、event，其他进入 drawer；Action/deep link 不隐藏；
- 1,000+ event 不全量挂 DOM；筛选/分页状态进入 URL；
- progress summary 位于 card/drawer header，percentage 只有 FlowView 明确定义时出现。

### Standard/compact

- workspace <900px 时 filter rail 变 drawer；Board 保留语义横向滚动；
- graph canvas 占满，detail drawer 占可用宽；toolbar 分两行，view switch 与 search 保留；
- `900 × 600` 下 graph 可视高度至少 360px，不能被 filter chips/legend 吃完；
- drawer 打开/关闭、切 view、浏览器返回均恢复 selected Flow 和 filter。

### 容量与视觉证据

在 `1400 × 900`、`1024 × 768`、`900 × 600` 覆盖：

- 0/50/1,000 instance，1/3/20 Definition，5/20 state column；
- dependency、lineage、related 各自 legend/edge/node，split/merge 与跨 Project portal；
- 60 字符 title、10 blocker、10 relation、terminal/abandoned、返工循环；
- 0/1,000/10,000 timeline event 的 empty/pagination/virtualization。

result 必须记录最大可见 node/edge、Board card 和 Timeline row 数，以及至少三档视口截图。

## 完成定义

[Acceptance 03](acceptance-03-flow-visualization.md) 通过并生成 `result-03.md`。
