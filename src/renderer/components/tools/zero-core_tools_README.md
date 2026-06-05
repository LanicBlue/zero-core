# tools

## 核心功能
工具管理页面组件，展示和配置 Agent 可用的内置工具与 MCP 工具。

## 输入
agent-tool-store 中的工具列表和状态

## 输出
工具管理 UI 页面（工具列表、启用/禁用配置）

## 定位
src/renderer/components/tools/ — 渲染进程工具管理 UI 层

## 依赖
../../store/agent-tool-store.ts；react

## 维护规则
- 新增工具类型需在此页面中添加展示
- 工具启用/禁用逻辑变更需同步检查 core/tool-policy.ts
