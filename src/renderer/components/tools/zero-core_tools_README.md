# tools 目录说明书

## 核心功能

Agent 工具（Agent-exposed Tool）管理页面（ToolsPage）：展示与配置通过 Agent 暴露为可调用工具的清单。

## 输入

- `../../store/agent-tool-store`
- `window.api` 的 tool 相关接口（如有）

## 输出

- 渲染的工具管理页面 DOM

## 定位

渲染进程功能模块，被 AppLayout 路由到 tools 页面时加载。

## 依赖

- react
- `../../store/agent-tool-store`
- `../../../shared/types`
- `../common`（通用组件）

## 维护规则

- 工具元数据（名称、描述、参数 schema）字段变化时同步本页展示。
- 新增工具操作（启用/禁用/编辑）需要扩展 ToolsPage 交互。
