# Acceptance 02：多 FlowDefinition Studio

对应 [Plan 02](plan-02-definition-studio.md)。

- [ ] 同一 Project 的三个 active Definition 可独立查看、编辑和切换版本。
- [ ] default 切换不覆盖其他 binding，create preview 显示将使用的 definition。
- [ ] draft 重启/重连后保留，但不影响 runtime。
- [ ] 图编辑、表单、YAML/JSON preview 使用同一服务端 validator。
- [ ] 版本 diff 覆盖 state/transition/milestone/gate/policy 的语义变化。
- [ ] simulator 不提交实例/event/WorkRun。
- [ ] FlowView 修改不改变 semantic digest 或既有 instance definition ref。
- [ ] draft/FlowView 由 management-only API 写入内层 Git，renderer 不访问物理控制目录。
- [ ] renderer 无固定 RequirementStatus/Flow state union。
- [ ] Studio 位于 Flows/Definitions，不创建第二个 Project selector 或页面壳层。
- [ ] Work trigger 反向引用在上游未完成时明确 unavailable，不按旧 schema 猜测。

## 布局与容量

- [ ] 宽屏 focus mode 使用 240px Catalog + min 560px canvas + 320px Inspector；Project
  identity 和 Save/Validate 始终可见。
- [ ] 900–1179px Catalog 变 drawer；<900px Catalog/Inspector 都变 drawer，canvas 不产生
  页面横向滚动。
- [ ] `900 × 600` canvas 可视高度至少 320px，toolbar 即使换行也不隐藏 Save/Validate。
- [ ] Catalog 的 20 Definition/50 version 可搜索/virtualize；30 states/100 transitions
  可 pan/zoom 和选择。
- [ ] Inspector 分 tab 独立滚动，不同时把全部长表单铺进 module content。
- [ ] Diff 宽屏 50/50、compact Before/After tab；Simulator 使用 480/420px drawer；完整
  diff 不进 modal。
- [ ] stale/invalid/200 行 validation error 有稳定 banner/detail，不只显示 toast。
- [ ] 三档视口的 Catalog、Inspector、invalid、diff、simulator、publish preview 有视觉证据。
