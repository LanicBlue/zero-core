# Plan 03：Flow API 与 Agent 工具切换

## 目标

在 Flow Engine 已稳定后暴露无 UI 假设的管理/运行 API，并原子切换 Project/Flow 工具。

## 依赖

Acceptance 00–02 通过。

## 实施范围

### 1. Flow Catalog API

提供 definitions list/get/version/active-bindings/default、instances
list/get/create/transition/history、dependencies、related、composition 与 lineage API。
Project active binding 是 `definitionId → version + digest` 的 map；create 未指定
definitionId 时才读取 default。

### 2. Project 配置入口

在 management-only Project 中加入通用
`config.validate/publish/activate/list/get`，本阶段只注册 `kind: flow` handler。
publish 创建不可变版本；activate 只更新指定 definitionId 的 binding；default 切换为
独立显式动作或配置字段，不能覆盖其他 binding。

### 3. Flow runtime 工具

Agent-facing Flow 原子切换为
`list/get/create/transition/history/dependencies.add/remove/list/status/related.add/remove/list/
split/merge/lineage`。不得保留 fixed ready/startBuild/verify action 或 definition mutation。

CallerCtx 注入 actor 与 Project scope；显式跨 Project dependency/related 仍需目标可见和
policy 授权。

### 4. 无 UI 合同

API 返回稳定 schema、allowed transitions、input contract、milestone 和关系数据，但不
保存颜色、画布坐标、状态列顺序或进度百分比。FlowView 由后续 UI effort 管理。

## 测试

覆盖多 definition binding、default、instance pin、并发 activate、Project/Flow 授权矩阵、
正反向/废案 transition、dependency/composition/related 隔离和 legacy Requirement 不变。

## 完成定义

[Acceptance 03](acceptance-03-flow-api-tool-cutover.md) 通过并生成 `result-03.md`。
