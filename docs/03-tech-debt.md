# 03 · 技术债清单

按严重程度分级：🔴 高（影响正确性 / 已暴露 bug）／🟡 中（影响可维护性）／🟢 低（清理类）。

## 🔴 高优先级

### 1. SQLite migration 列同步问题（架构层面未根除）

**症状**：刚修了 [AGENT_TOOL_COLUMNS 漏 auto_background_timeout](../src/server/db-migration.ts#L33) 导致 fresh DB 启动崩溃。

**根因**：每个 SqliteStore 的 `COLUMNS` 数组和 [db-migration.ts](../src/server/db-migration.ts) 里对应的 `*_COLUMNS` 数组是**两份独立定义**，靠人工同步。`safeAddColumn` 在表不存在时静默失败，所以 fresh DB 完全靠 migration 的 COLUMNS 列表创建表。

**影响范围**：现在 7 个 store 都是这个模式（agents、agent_tools、providers、templates、mcp_servers、kb_entries、memory）。任何新增列都可能复现这个 bug。

**修复建议**：
- 短期：让 migration 文件直接 import store 的 COLUMNS 常量，消除双源
- 长期：把 schema 定义和 SqliteStore 类绑定，migration 自动派生

### 2. IpcContext 全 `any`，typedHandle 是假类型安全

**症状**：[src/main/ipc/types.ts](../src/main/ipc/types.ts) 15 个字段全是 `any`，handler 写 `_ctx.agentToolStore.getByAgentId(id)` 编译器不报错，但运行时 `agentToolStore` 可能是 undefined。

**根因**：[typed-ipc.ts](../src/main/ipc/typed-ipc.ts) 的泛型只在 handler 函数签名层面给类型，没要求 ctx 字段也有类型。

**修复建议**：
- 给 IpcContext 字段加真类型（`agentStore: AgentStore` 等）
- 升级 typedHandle 让它在编译期校验 modules 数组和实际访问的 ctx 字段一致

### 3. handler 声明的依赖不准确

**症状**：[chat-handlers.ts:9](../src/main/ipc/chat-handlers.ts#L9) `chat:send` 声明 `["agentService", "workspaceConfig"]` 但实际还访问 `providerStore`、`agentStore`。`chat:abort` 声明 `[]` 但访问 `agentService`。

**根因**：typedHandle 不强制校验，靠开发者自觉。

**影响**：模块没 ready 时 IPC 调用直接 crash（已经发生过 — Phase 2b 测试 seed 异常时）。

**修复建议**：lint 规则 + 准确声明。

### 4. `activeSessionId` 同步路径脆弱

**症状**：[chat-store.ts](../src/renderer/store/chat-store.ts) 双状态（messagesBySession + messages），任何 addMessage / updateAssistantText 都要判断 `isActive = sessionId === activeSessionId`。

**根因**：rendering 优化带来的双源。

**刚暴露的 bug**：refreshSessionData 不 setActiveSessionId → 用户消息不渲染。已修，但同样的模式还有：
- text_delta 在 activeSessionId null 时静默丢弃（updateAssistantText 也用 isActive 判断）
- session_init 的 messages 在 activeSessionId 不匹配时静默丢弃

**修复建议**：
- 单源化：只用 `messagesBySession[activeSessionId]`，删除 `messages` 字段，renderer 直接 select
- 或：保留 `messages` 但在 setter 里强制 invariant（activeSessionId 改变后立即同步）

### 5. 单元测试几乎为零

**症状**：仅 2 个 E2E 烟测，runtime、recovery、MCP、KB、tool 调用、迁移**全无自动化测试**。

**高风险路径**：
- agent-loop 重试 + context pruning 逻辑
- recovery 中断恢复
- migration 跑在 fresh DB 上的所有路径
- chat-store reducer（任何回归都会影响 UI）

**修复建议**：见 [04-recommendations.md](04-recommendations.md) 测试章节。

### 6. `any` 在 public API 上

**最严重的几处**：
- [src/main/ipc/types.ts](../src/main/ipc/types.ts) — 整个 IpcContext
- [src/shared/ipc-api.ts:139](../src/shared/ipc-api.ts#L139) `"todos:get": { result: any[] }`
- [src/runtime/agent-utils.ts:48](../src/runtime/agent-utils.ts#L48) `parseThinkingTags(): any[]`

**总数据**：378 处 `any`（215 `: any` + 163 `as any`）。

**top 5 文件**：
1. `agent-loop.ts` — 28
2. `template-handlers.ts` — 27
3. `main/ipc/core.ts` — 22
4. `mcp-handlers.ts` — 18
5. `main/ipc/types.ts` / `kb-handlers.ts` — 各 16

### 7. 错误吞噬

**91 个 catch 块**，大量 `catch {}`。典型问题位置：
- [src/main/ipc/core.ts:248](../src/main/ipc/core.ts#L248) MCP reconnect 错误吞噬
- [src/main/ipc/template-handlers.ts:54](../src/main/ipc/template-handlers.ts#L54) GitHub cache 保存失败静默
- [src/runtime/agent-loop.ts:334](../src/runtime/agent-loop.ts#L334) retry 时删 turn 失败静默
- [src/main/index.ts:75](../src/main/index.ts#L75) chcp 设置失败静默（虽然是合理的 best effort）

**修复建议**：至少 `log.warn` 一行，不要全静默。

## 🟡 中优先级

### 8. god 文件

| 文件 | 行数 | 问题 |
|------|------|------|
| [AgentEditor.tsx](../src/renderer/components/agents/AgentEditor.tsx) | 688 | create/edit/多 section 全在一个组件 |
| [agent-loop.ts](../src/runtime/agent-loop.ts) | 784 | 单 turn 执行 + retry + streaming + tool 调度 |
| [SettingsPage.tsx](../src/renderer/components/settings/SettingsPage.tsx) | 667 | provider/theme/device/guidelines 多个 section |
| [ChatPanel.tsx](../src/renderer/components/layout/ChatPanel.tsx) | 431 | 可接受，但 session 切换 + 输入 + 消息渲染可拆 |
| [session-handlers.ts](../src/main/ipc/session-handlers.ts) | 9 个独立操作 | 可拆 message-handlers + session-handlers |
| [template-handlers.ts](../src/main/ipc/template-handlers.ts) | 188 + GitHub import | 可拆 github-handlers |

### 9. AppLayout 的 `onAgentEvent` switch 巨大

[AppLayout.tsx:62-104](../src/renderer/components/layout/AppLayout.tsx#L62) 一个 switch 处理 8+ event type。每加一个事件类型都要改这里。

**修复建议**：dispatcher 模式 — event name → handler function map。

### 10. 双构建系统

`tsc` (dist/) + `electron-vite` (out/) 并存。`dist/` 用于 npm 发布，但实际是否发布 npm 不明。

**修复建议**：如果不发 npm，删除 `build:lib` 脚本和 `tsconfig.cli.json`，简化构建。

### 11. 预加载暴露面太宽

[preload/index.ts](../src/preload/index.ts) 暴露 156 个 IPC 方法，无 capability 分级。任何渲染进程代码都能调用任何 IPC。

**修复建议**：
- 短期：保持现状（context isolation 已提供基本保护）
- 长期：把 preload API 按模块切分，按页面 / 角色分级暴露

### 12. 硬编码 URL 和 magic number

**URLs**：
- `http://localhost:5173`（dev server）
- `http://localhost:11434`（Ollama 默认）
- `http://localhost:3000`（MCP SSE 默认）
- `http://localhost:8080`（SearXNG 默认）
- `http://localhost:3210`（API server 默认）

**magic number**：
- `200`（agent loop max steps）
- `10 * 1024 * 1024`（background process max buffer）
- `50000`（output truncation）
- 各种 `1500ms / 2000ms / 5000ms / 10000ms` 超时

**修复建议**：抽到 `core/config.ts` 或 `core/constants.ts`。

### 13. Provider 类型与 UI 选项不匹配

[provider-factory.ts](../src/runtime/provider-factory.ts) switch 没有 `minimax` / `glm` / `deepseek` 等中国厂商。用户实际只能选 `openai-compatible`。这导致：
- thinking / reasoning 字段在 openai-compatible 路径下不会自动启用
- 错误码分类不针对具体厂商
- UI 上选 MiniMax/GLM 时实际类型仍是 openai-compatible，配置不直观

**修复建议**：
- 短期：UI 层给 MiniMax / GLM / DeepSeek 等加 preset（自动填 baseUrl + 启用 reasoning）
- 长期：加原生 case，支持厂商特有功能

## 🟢 低优先级（清理类）

### 14. 残留文件

- `env-dump.txt`（根目录，上轮调试残留）
- `openclaw.plugin.json`（用途不明）
- `src/renderer/components/workspace/`（空目录）
- `build/`（空目录）
- `resources/`（空目录）

### 15. 空状态 / loading / error 不一致

部分组件有完整 empty state（ChatPanel），部分没有（agent list、template list）。loading skeleton 几乎全无。

### 16. 内联样式

[TodosList.tsx](../src/renderer/components/chat/TodosList.tsx)、[McpServerCard.tsx](../src/renderer/components/mcp/McpServerCard.tsx)、[SettingsPage.tsx](../src/renderer/components/settings/SettingsPage.tsx) 都有内联样式（progress bar width 等）。可抽到 CSS。

### 17. 命名混用

- 表名 snake_case（合理，SQL 惯例）
- TS 文件 kebab-case（合理）
- 但 IPC 频道既有 `chat:send` 也有 `sessions:list`，前缀规则不统一（`agents:list` vs `agent-tools:list` vs `chat:send`）

### 18. 类型重复定义

部分类型在 `src/shared/types.ts` 之外还有散落（如 `src/runtime/types.ts`、`src/main/ipc/types.ts`）。shared 应该是单一来源，其它应该 import。

## 统计

| 维度 | 数值 |
|------|------|
| 总文件数（src/） | 198 |
| `any` 出现 | 378 |
| catch 块（含空 catch） | 91 |
| TODO/FIXME 注释 | ~5（数量少说明文档习惯好，但也可能未标注） |
| E2E 测试 | 2 |
| 单元测试 | 0 |
| 硬编码 URL | 9 |
