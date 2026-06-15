# 前端开发规范

## 适用范围

本文规范适用于 `src/renderer/` 下的全部 React 前端代码，覆盖桌面 Electron 渲染进程与 HTTP/WS 服务模式下浏览器加载的同一份渲染产物。具体范围：

- **组件层**：`src/renderer/components/` 下所有 `.tsx` 页面与组件（agents、chat、dashboard、kb、layout、mcp、settings、tools、workspace、common）。
- **状态层**：`src/renderer/store/` 下 10 个 Zustand store。
- **类型层**：`src/renderer/types/` 前端本地类型；跨层共享类型走 `src/shared/`。
- **样式层**：`src/renderer/styles/` 全局样式与主题。

不适用：主进程（`src/main/`）、运行时（`src/runtime/`）、服务层（`src/server/`）、CLI（`src/cli.ts`）—— 这些层不引入 React / Zustand，遵循各自的层规范。前端与这些层交互必须通过 preload 暴露的 IPC API 或 HTTP/WS，禁止在前端直接 import 后端模块。

## 界面结构

zero-core 前端采用「图标侧边栏 + 主工作区」的单壳布局，主工作区按当前页面切换内容：

- **外壳**：`AppLayout.tsx` 是顶层容器，挂载 `IconSidebar`（左侧图标导航）和 `ResizableLayout`（三栏可调主区）。
- **导航**：`IconSidebar` 切换页面路由（由 `page-store.ts` 管理 activePage），不使用 URL 路由，状态全部在内存 store。
- **主工作区**：`ResizableLayout` 提供三栏可拖拽布局 —— 左侧聊天面板、中间文件树、右侧文档查看器；Chat / Agents / Tools 等页面复用该壳并填充各自内容。
- **全局事件分发**：`AppLayout.tsx` 统一订阅 `onAgentEvent`，按 `data.type`（`text_delta` / `thinking_delta` / `tool_start` / `tool_end` 等）分发到对应 store，组件不直接订阅 IPC。
- **主题**：`theme-store.ts` 管理深浅主题切换，全局样式在 `styles/` 下。

页面 → 组件目录 → 主要组件的对应关系见下文「页面结构」表。

## 交互规范

### IPC 与事件流

- **统一订阅点**：所有 `onAgentEvent` 监听集中在 `AppLayout.tsx`，组件不重复订阅；新增事件类型时扩展 AppLayout 的 dispatcher，而非在每个组件里加监听。
- **工具调用 block 匹配**：用 `toolCallId`（不是工具名）匹配 block，并行调用同一个工具两次也能正确显示各自结果；`addToolCall` / `updateToolCall` 都必须带 `toolCallId`。
- **流式更新**：`text_delta` 增量追加到当前 assistant 消息，`thinking_delta` 单独走思维链区块，不混入正文。

### 状态管理

- **Zustand 单向**：所有跨组件状态走 Zustand store，不用 React Context 做状态分发（Context 只用于纯依赖注入）。
- **store 职责单一**：一个 store 一个领域（chat 管消息、agent 管 Agent CRUD、page 管导航），不要在 `chat-store` 里塞页面导航逻辑。
- **副作用边界**：发 IPC / fetch 的副作用放在 store action 或 AppLayout dispatcher，组件保持纯展示；组件内 effect 只做订阅和清理。

### 组件拆分

- **大表单拆 Section**：Agent 编辑器拆为 5 个 Section（Basic、Prompt、Tools、Expose、Permissions），共享 `agent-editor-types.ts`；Settings 拆 6 个子组件。新增复杂表单遵循同样模式。
- **可复用组件下沉**：跨页面复用的组件放 `components/common/`，不放页面专属目录。
- **类型共享**：跨 Section 的类型放 `agent-editor-types.ts` 这类共享类型文件，不重复定义。

### 用户反馈

- **长任务反馈**：流式执行期间展示进行中的工具调用 block 和思维链，不阻塞 UI；任务完成后通过 store action 刷新结果。
- **错误展示**：工具调用 `error` 状态在 block 上显示失败原因，不让错误吞掉；IPC 错误通过 AppLayout dispatcher 统一处理。
- **确认类操作**：破坏性操作（删除 Agent、清空会话）走 Electron 原生 dialog（`dialog-handlers.ts`），不用自造弹窗。

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
