# 前端开发规范

## 适用范围

本文档适用于 zero-core 的 React 前端开发，包括组件、交互和样式。

## 界面结构

**页面组织**：
- `ChatPanel` - 主聊天界面
- `AgentsPage` - Agent 管理页面
- `ToolsPage` - 工具配置页面
- `SettingsPage` - 应用设置页面
- `McpSettingsPage` - MCP 服务器配置页面
- `KnowledgeBasePage` - 知识库管理页面
- `DashboardPage` - 仪表板页面

**状态管理**：
- `chat-store.ts` - 聊天和会话状态
- `page-store.ts` - 页面导航状态
- `interaction-store.ts` - 交互状态（todos 等）

## 交互规范

**常见操作**：
- 发送消息：Ctrl+Enter 或点击发送按钮
- 创建 Agent：填写表单后保存
- 配置工具：选择工具 → 修改配置 → 保存

**反馈处理**：
- 加载状态：显示 spinner 或 loading 文本
- 成功：短暂显示"已保存"提示
- 错误：显示错误消息和重试选项

**空状态**：
- 无会话时：显示"创建新会话"提示
- 无工具时：显示"暂无工具"提示

## 维护规则

- 每次新增界面模式、组件规范或交互规则后，必须检查并更新本文件
