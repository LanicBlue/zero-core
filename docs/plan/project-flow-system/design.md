# Design：Project Flow System

本设计服从跨 effort 的
[Agent Project Automation 架构合同](../agent-project-automation.md)，本文只固定本 effort
的所有权和交付边界。

## 1. 所有权

本 effort 拥有：

- Project 控制目录、manifest、外层 exclude 和内层 Git transaction；
- FlowDefinition repository、validator、version 与 active binding；
- FlowInstance、transition、milestone、dependency、related relation、composition 和
  event/outbox；
- Flow API、Project 的 `kind: flow` 配置入口和 Agent-facing Flow 工具。

本 effort 不拥有 WorkDefinition/WorkRun、Session supervisor、VFS/worktree、renderer
管理体验或 Requirement importer。

## 2. 多 FlowDefinition 模型

一个 Project 可以同时启用多个 FlowDefinition：

```text
ProjectFlowCatalog
├── defaultDefinitionId?
└── activeBindings
    ├── delivery            → version + digest
    ├── implementation-task → version + digest
    └── incident            → version + digest
```

active binding 按 `definitionId` 独立维护，不存在 Project 级唯一 `activeDefinition`。
创建 FlowInstance 时应显式指定 definition；只有省略时才使用
`defaultDefinitionId`。实例固定 `definitionId + version + digest`，后续 active switch
只影响新实例。

FlowDefinition semantic contract 不包含画布坐标、颜色、折叠状态或进度权重。这些展示
信息属于 `project-management-ui` 的 FlowView，不能改变 semantic digest。

## 3. Flow 关系

三种关系必须分开存储和查询：

- `dependency`：有向 DAG，引用 prerequisite milestone，可以参与 transition gate；
- `composition`：split/merge 的不可变 lineage DAG，不自动形成 gate；
- `related`：无方向或带标签的非阻塞关联，只用于导航和上下文，不参与 cycle/gate。

核心不能把 related 或 lineage 暗中提升为 dependency。跨 Project 首版支持 dependency
和 related；split/merge 仍限同 Project。

## 4. 工具边界

- 管理 Agent 的 Project 提供通用 `config.validate/publish/activate/list/get`；本 effort
  注册并处理 `kind: flow`。
- 普通 Project Agent 的 Flow 提供 instance runtime action，不包含 definition mutation。
- 身份、Project scope 和 actor 由 CallerCtx 注入；领域 actor/gate 校验不是 action-level
  工具授权。

本 effort 不注册 Work runtime action，也不为了后续 WorkDefinition 提前做空壳行为。

## 5. 完成边界

只有本目录全部 acceptance 与 Final 通过，`project-flow-system` 才能作为
`agent-work-runtime`、`project-management-ui` 和 `agent-eval-harness` 的已实现前置。
