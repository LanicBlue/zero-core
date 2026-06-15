# mcp 目录说明书

## 核心功能

MCP（Model Context Protocol）服务器管理 UI：McpSettingsPage 主页面提供服务器列表、添加表单（stdio/sse/streamable-http）、推荐预设一键添加、系统级配置扫描与定时状态刷新；McpServerCard 展示单服务器状态、连接/断开、详情展开与连接测试。

## 输入

- `../../store/mcp-store`（servers / loading / create / update / remove / connect / disconnect / testConnection / getStatus / scan / presets / addPreset）

## 输出

- 渲染的 MCP 设置页面与服务器卡片 DOM（含测试结果）

## 定位

渲染进程功能模块，被 AppLayout 路由到 mcp 页面时加载。

## 依赖

- react
- `../../store/mcp-store`（含 McpPreset 类型）
- `../../../shared/types`（McpServerConfig）

## 维护规则

- mcp-store 接口变化时同步本目录调用。
- 新增 transport 类型或预设字段需要扩展表单与卡片详情展示。
