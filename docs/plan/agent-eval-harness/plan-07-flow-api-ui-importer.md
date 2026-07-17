# Plan 07：Flow API、动态 UI 与旧 Requirement Importer

## 目标

让用户和 Agent 都能实际管理 Project Flow、Work 和 WorkRun；UI 根据 Project
FlowDefinition 动态呈现，不复用旧 Requirement 的硬编码状态列。提供显式、无损、
幂等的旧 Requirement importer，但不删除旧系统。

## 依赖

Acceptance 02–06 通过。

## 实施范围

### 1. REST / IPC

提供管理与运行接口：

- Project control status/initialize/repair preview；
- definitions validate/publish/list/version/active；
- instances list/get/create/transition/history；
- dependency add/remove/list/status/impact preview；
- composition split/merge preview/execute 与 lineage query；
- document metadata/read；
- works list/version/enable/manual fire；
- workRuns current/list/get/defer/prioritize/switch/cancel/retry；
- importer preview/execute/status。

identity、actor 和 Project scope 由 server 注入；renderer 参数不能伪造 Agent/user actor。

### 2. Agent-facing 三工具切换

保持现有工具级授权，不增加 action-level tool policy：

- 管理 Agent 的 `Project` 增加统一
  `config.validate/publish/activate/list/get`，以 `kind: flow|work` 管理完整不可变
  definition version；增加 `work.fire`，只创建 durable WorkRun。
- 普通 Project Agent 的 `Flow` 只管理 FlowInstance runtime，不提供 definition mutation；
  allowed transition 包括返工和废案，actor/gate/scope 由服务端校验。
- 普通 Project Agent 的 `Work` 原子切换为 WorkRun runtime：
  `current/list/get/defer/prioritize/switch/cancel/retry`。

Project config action 只接收通用 definition payload/ref，不为每个 Flow/Work 字段扩大扁平
schema；领域 validator 和 repository 保持独立。`Work` 不包含 create/update/delete/fire，
`Flow` 不包含 definition publish/activate。Work tool schema/prompt/registration/tool-policy
必须在本阶段同一提交中切换，不能短暂注册两个同名 Work 或保留按 feature flag 分流的双语义。
WorkRun mutation 由 CallerCtx 限制在当前 Agent Session，`switch` 两端必须同 Project、
同 Session；这是服务端 domain scope，不是 action-level grant。

### 3. 通用 Flow UI

在 Project 页面增加独立 Flow 视图：

- 列/筛选来自 active FlowDefinition.states；
- FlowInstance 卡片/详情显示固定 definition version、state、revision；
- allowed transitions 来自 FlowService，包括回边/循环；UI 不按状态列顺序隐藏“向左”
  transition；
- transition 操作按 definition input contract 动态显示并校验 reason 等字段，preview
  明确 from/to、actor 和 expected revision；
- 显示 prerequisite/dependent、required milestones、satisfied/blocked/unknown 和阻塞
  transition；支持同/跨 Project 依赖选择与 cycle preview；
- split preview 显示 policy、child definition/数量、固定文档输入和将创建的 dependency；
- merge preview 显示 source revisions/milestones、创建或既有 target、文档输入和冲突；
- 以 lineage 图或等价可导航视图显示 parent/children、merge sources/target，并明确
  composition 不等于 dependency；
- 文档、event history、相关 WorkRun 可查看；
- terminal abandoned 默认进入终止/归档筛选，显示 reason/actor/revision，保留文档与
  history；首版不显示恢复操作；
- control conflict/unavailable 有明确修复指引；
- 不把状态数组复制到 renderer 常量。

### 4. Work / WorkRun UI

- 查看 WorkDefinition trigger、Agent、workspace、enabled/version；
- manual fire；
- queued/deferred/running/waiting/succeeded/failed/cancelled 状态；
- defer reason/notBefore、priority/queueOrder、retry/cancel；
- Agent queue 视图支持 prioritize 和 safe switch，显示操作 actor/reason/revision；
- 展示 session/turn/worktree/trigger event 关联；
- UI reconnect 后从持久状态恢复，不只依赖 push。

首版可只提供受 schema 表单或文件编辑入口之一，但必须有 preview/validation，不能保存
无效 YAML 后让 runtime 才失败。

### 5. Requirement importer

显式流程：

```text
select Project/Requirement(s)
→ preview status/doc mapping + conflicts
→ execute with idempotency marker
→ verify source hash/count and target FlowInstance
```

默认模板映射同名状态；未知状态、缺文档、重复目标、definition mismatch 必须阻止或要求
明确选择。import 复制内容并记录 provenance，不删除、改状态或双写旧 Requirement。

### 6. 旧 UI 边界

旧 Requirement 页面/API 可以继续存在，但命名为 legacy Requirement，不调用新 Flow
Service。新 Flow UI 不 import `RequirementStatus`。何时设旧系统只读/删除由后续用户
决策，不在本阶段偷偷完成。

## 测试

Unit/API/E2E 覆盖三工具授权矩阵、Project config schema、动态 3/7/自定义状态、正反向/
废案 transition、返工 reason、transition conflict、reconnect、manual Work、
queue updates、dependency graph/cycle/missing target、split/merge preview/
idempotency/lineage/cross-Project rejection、control conflict、import preview/execute/
repeat/partial failure 和旧数据不变。

## 完成定义

[Acceptance 07](acceptance-07-flow-api-ui-importer.md) 全部通过并生成 `result-07.md`。
