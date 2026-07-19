# Plan 02：多 FlowDefinition Studio

## 目标

提供可持久编辑、验证、比较、模拟和发布多个 FlowDefinition 的管理界面，并建立独立
FlowView。

## 依赖

Acceptance 00–01 通过。

## 实施范围

- Definition Catalog：active binding map、default、版本、实例数、关系引用影响；
- `.zero-core/flow/drafts` 的显式 save/delete，运行时忽略；
- state/transition graph editor 和属性表单；
- documents、milestones、gates、dependency/composition policy 编辑；
- 服务端 validate、immutable publish、单 binding activate；
- semantic version diff 与 transition simulator；
- FlowView label/color/group/order/layout/progress projection 的独立 revision/activate；
- unsaved/invalid/stale revision 冲突提示。

draft/FlowView 使用 management-only API 并通过 ProjectControlGit 提交；renderer 不直接
读写物理 `.zero-core`。Definition publish/activate 调用 Project Flow System 已有的同一
application service，不复制 validator 或建立 UI 专用 definition repository。

Work trigger 反向引用等 Agent Work Runtime 数据留待 Plan 04；本阶段不得把未知显示为
零引用或按旧 Worker schema 推导。

## 布局方案

Definition Studio 默认请求 shell focus mode，将 Project rail 收为 56px，但保留 context
bar 中的 Project identity。

### Editor

```text
┌ Definitions / definition / draft breadcrumb ─ Save · Validate · Publish · … ┐
├ Catalog 240px ─────┬ Graph/Form canvas (flex, min 560px) ─┬ Inspector 320px ┤
│ search + create    │ toolbar / zoom / validation markers  │ tabs            │
│ active bindings   │ states + transitions                  │ Properties      │
│ definitions       │                                       │ Documents       │
│ versions/drafts   │                                       │ Gates/Policy    │
│                   │                                       │ FlowView        │
├───────────────────┴───────────────────────────────────────┴─────────────────┤
│ status 32px：draft revision / validation summary / last saved                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- focus workspace ≥1180px 时 Catalog 240px、Inspector 320px、splitter 各 8px，canvas 获取剩余
  空间；canvas 不得小于 560px；
- toolbar 48px，Save/Validate 永远可见；Publish/Activate 在 validation/permission 允许时
  出现，次要动作进 overflow；
- Catalog definition row 44px、version/draft row 36px；20 definitions/50 versions 可搜索，
  长列表使用 virtualization；
- Inspector tab 不同时展开全部表单；属性、documents、milestones、gates/composition、
  FlowView 分组，tab 内容独立滚动；
- graph canvas 使用 pan/zoom，不推动整个页面横向滚动；选中 state/transition 同步
  Inspector 与 URL entity id。

### Standard/compact

- workspace `900–1179px`：Catalog 变 280px overlay drawer；canvas + 320px Inspector；
- workspace `<900px`：Catalog 与 Inspector 都是 drawer，canvas 占满；顶部提供明确的
  “Definitions”“Properties”按钮和当前选择摘要；
- `900 × 600` 下 toolbar 可换成两行但 Save/Validate 不进入 overflow；canvas 可视高度
  不低于 320px；
- graph、form、source preview 使用同一 selected entity，不渲染三份同时编辑的状态。

### Diff、Simulator 与发布

- version diff 使用完整 module route：宽屏 50/50 双栏，每栏最小 400px；compact 用
  Before/After tab + changed-path 列表，不制造横向页面滚动；
- transition simulator 使用宽屏 480px/标准 420px drawer；输入与模拟 event 固定上部，
  trace/result 在下部滚动，不覆盖 editor；
- publish preview 使用不超过 560px dialog，只显示摘要、validation 和影响；完整 diff
  通过 route 查看；
- stale revision/invalid draft banner 固定在 toolbar 下方，不遮住 canvas，也不把错误仅放
  toast。

### 容量与视觉证据

覆盖 1/3/20 Definition、1/10/50 version、30 states、100 transitions、20 milestones/gates、
60 字符名称和 200 行 validation error。在三档视口保存 Catalog open/closed、Inspector、
invalid、diff、simulator 和 publish preview 截图。

## 测试

至少使用 delivery、implementation-task、incident 三个同时 active 的 Definition；覆盖
draft 重连、invalid schema、发布冲突、独立 activate、既有 instance pin 和 view-only
修改不改变 semantic digest，并覆盖上述容量与三档视口。

## 完成定义

[Acceptance 02](acceptance-02-definition-studio.md) 通过并生成 `result-02.md`。
