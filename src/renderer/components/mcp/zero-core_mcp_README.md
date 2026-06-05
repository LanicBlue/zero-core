# mcp

## 核心功能
MCP（Model Context Protocol）服务器管理页面组件，提供 MCP 服务器的添加、配置、启停和状态监控 UI。

## 输入
mcp-store 中的 MCP 服务器列表和状态

## 输出
MCP 服务器管理 UI 页面（添加、配置、启停、状态监控）

## 定位
src/renderer/components/mcp/ — 渲染进程 MCP 管理 UI 层

## 依赖
../../store/mcp-store.ts；react

## 维护规则
- 新增 MCP 配置字段需同步更新 McpServerCard.tsx 和 server/mcp-manager.ts
- 服务器状态显示变更需检查 mcp-store.ts 的状态更新逻辑
