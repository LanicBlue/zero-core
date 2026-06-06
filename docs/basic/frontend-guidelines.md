# 前端开发规范

## 页面结构

| 页面 | 组件目录 | 功能 |
|------|---------|------|
| Chat | `layout/` (ChatPanel) | 主聊天界面，流式文本、工具调用展示 |
| Agents | `agents/` (AgentsPage, AgentEditor) | Agent CRUD、工具配置、暴露为工具 |
| Tools | `tools/` (ToolsPage) | 工具列表、配置、统计、AI 分析、测试 |
| Dashboard | `dashboard/` | 会话指标、Token 用量 |
| Settings | `settings/` | 应用设置（6 个子组件） |
| MCP | `mcp/` | MCP 服务器管理 |
| Knowledge | `kb/` | 知识库管理 |
| Layout | `layout/` (AppLayout, IconSidebar, ResizableLayout) | 三栏布局 + 文件树 + 文档查看器 |

## 状态管理

10 个 Zustand store，`chat-store.ts` 为核心：

- `chat-store.ts` — 消息管理，工具调用通过 `toolCallId` 匹配 block（支持并行调用）
- `page-store.ts` — 页面导航
- `agent-store.ts` — Agent CRUD
- `agent-tool-store.ts` — Agent 工具绑定
- `provider-store.ts` / `template-store.ts` / `mcp-store.ts` / `kb-store.ts` — 对应资源管理
- `interaction-store.ts` — 交互状态（todos）
- `theme-store.ts` — 主题切换

## IPC 事件处理

`AppLayout.tsx` 中统一订阅 `onAgentEvent`，按 `data.type` 分发到对应 store 方法：

- `tool_start` → `addToolCall(sessionId, toolName, args, toolCallId)`
- `tool_end` → `updateToolCall(sessionId, toolName, status, result, toolCallId)`
- `text_delta` → `updateAssistantText()`
- `thinking_delta` → `updateThinking()`

## 组件规范

- Agent 编辑器拆分为 5 个 Section 组件（Basic、Prompt、Tools、Expose、Permissions），共享 `agent-editor-types.ts` 类型
- Settings 拆分为 6 个子组件
- 工具调用 block 通过 `toolCallId` 匹配（非工具名），确保并行调用正确显示

## 维护规则

- 每次新增页面、组件或交互模式变化后，必须检查并更新本文件
