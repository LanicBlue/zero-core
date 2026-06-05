# 前端开发规范

## 适用范围

本文档适用于 zero-core 的 React 前端开发，包括组件、交互和样式。

## 界面结构

**页面组织**：
- `ChatPanel` - 主聊天界面
- `AgentsPage` - Agent 管理页面
- `ToolsPage` - 工具配置和统计分析页面（含统计 Tab：调用概况、错误率、AI 诊断）
- `SettingsPage` - 应用设置页面
- `McpSettingsPage` - MCP 服务器配置页面
- `KnowledgeBasePage` - 知识库管理页面
- `DashboardPage` - 仪表板页面（会话指标、Provider 用量、活跃会话）

**组件目录**：
- `agents/` - Agent 管理（列表、编辑、工具配置）
- `chat/` - 聊天界面（消息列表、输入框）
- `common/` - 共享 UI 组件
- `dashboard/` - 仪表板（指标卡片、实时刷新）
- `kb/` - 知识库管理
- `layout/` - 布局（侧边栏、导航）
- `mcp/` - MCP 设置
- `settings/` - 设置页面
- `tools/` - 工具页面（配置 Tab + 统计 Tab）
- `workspace/` - 工作区组件

**状态管理（10 个 Zustand store）**：
- `chat-store.ts` - 聊天和会话状态
- `page-store.ts` - 页面导航状态
- `interaction-store.ts` - 交互状态（todos 等）
- `agent-store.ts` - Agent 状态
- `agent-tool-store.ts` - Agent 工具状态
- `provider-store.ts` - Provider 状态
- `template-store.ts` - 模板状态
- `kb-store.ts` - 知识库状态
- `mcp-store.ts` - MCP 状态
- `theme-store.ts` - 主题状态

## 交互规范

**常见操作**：
- 发送消息：Ctrl+Enter 或点击发送按钮
- 创建 Agent：填写表单后保存
- 配置工具：选择工具 → 修改配置 → 保存
- 查看工具统计：Tools 页面 → 统计 Tab → 查看概况卡片和工具列表
- AI 错误分析：工具统计页 → 选择工具 → 点击 AI 分析 → 查看诊断报告

**反馈处理**：
- 加载状态：显示 spinner 或 loading 文本
- 成功：短暂显示"已保存"提示
- 错误：显示错误消息和重试选项

**空状态**：
- 无会话时：显示"创建新会话"提示
- 无工具时：显示"暂无工具"提示
- 无统计数据时：显示"暂无执行记录"提示

## 维护规则

- 每次新增界面模式、组件规范或交互规则后，必须检查并更新本文件
