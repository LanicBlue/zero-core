# Project Management UI：实施路线图

> 状态：设计完成，尚未实施。
> 首个外部前置：`wiki-system-redesign` Final 合并与 `project-flow-system` Final。
> Plan 04 与 Final 另需 `agent-work-runtime` Final；Plan 00–03 可以先实施。
> 共同合同：[Agent Project Automation](../agent-project-automation.md)。

## 阶段

| 阶段 | Plan | Acceptance | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Upstream UI Reconciliation](plan-00-upstream-ui-reconciliation.md) | [Acceptance 00](acceptance-00-upstream-ui-reconciliation.md) | Wiki Final + Flow Final | 真实页面/API 基线、模块迁移图 |
| 01 | [Project Shell & Overview](plan-01-project-shell-overview.md) | [Acceptance 01](acceptance-01-project-shell-overview.md) | 00 | shell 线框、稳定导航、Overview、Wiki/Settings |
| 02 | [Definition Studio](plan-02-definition-studio.md) | [Acceptance 02](acceptance-02-definition-studio.md) | 01 | 三栏 editor、draft、diff、simulator、FlowView |
| 03 | [Flow Visualization](plan-03-flow-visualization.md) | [Acceptance 03](acceptance-03-flow-visualization.md) | 02 | Board/Graph/Timeline workspace、进度 |
| 04 | [Work & WorkRun UI](plan-04-work-and-workrun-ui.md) | [Acceptance 04](acceptance-04-work-and-workrun-ui.md) | 01–03 + Work Final | Definitions/Runs/Queue、drawer、switch |
| 05 | [Requirement Importer](plan-05-requirement-importer.md) | [Acceptance 05](acceptance-05-requirement-importer.md) | 02–03 | 分阶段 workspace、preview/execute、Legacy |
| 06 | [Hardening](plan-06-hardening.md) | [Acceptance 06](acceptance-06-hardening.md) | 01–05 + Work Final | 三档视口、压力 fixture、视觉回归、E2E |

全部阶段通过后执行 [Final Acceptance](acceptance-final.md)。

```text
wiki-system-redesign FINAL + merge ─┐
project-flow-system FINAL ──────────┴→ 00 → 01 → 02 → 03 ─┬→ 04 ─┐
                                                           └→ 05 ─┤→ 06 → FINAL
agent-work-runtime FINAL ─────────────────────────────────────────┘
```

Plan 01 应先保留尚未迁移的 legacy/Work 模块可访问，再由后续阶段替换；不得以一次性重写
整个 `ProjectPage.tsx` 的方式同时改变所有领域行为。

## 不变量

- Project shell 只编排模块，不成为领域 API 或持久真相源。
- renderer 不保存固定 Flow 业务状态 union。
- Wiki section 复用 Wiki Final 的真实管理能力，不复制 API/job 状态。
- FlowView 不改变 semantic digest 或 Flow runtime。
- dependency、lineage、related 使用不同视觉语义和可切换图层。
- 默认不伪造线性百分比；进度是派生展示。
- UI mutation 复用服务端 domain validator 和 CallerCtx，不信任 renderer actor。
- importer 永不自动运行或双写旧 Requirement。
- 所有关键 route 在 `1400 × 900`、`1024 × 768`、`900 × 600` 有明确布局和视觉证据。
- 非 Board/Graph 语义 viewport 不产生页面横向滚动；主操作不因窄屏消失。
