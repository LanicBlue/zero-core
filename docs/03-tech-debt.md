# 03 · 技术债清单

按严重程度分级：🔴 高（影响正确性 / 已暴露 bug）／🟡 中（影响可维护性）／🟢 低（清理类）。

## 🔴 高优先级

### 1. SQLite migration 列同步问题（已自愈，架构层面部分缓解）

**状态**：✅ 2026-06-02 已实现 self-heal（[sqlite-store.ts ensureTable](../src/server/sqlite-store.ts#L75)）— 构造时检测缺失列并自动 ALTER ADD COLUMN。

**症状**：曾因 [AGENT_TOOL_COLUMNS 漏 auto_background_timeout](../src/server/db-migration.ts#L33) 导致 fresh DB 启动崩溃。

**根因**：每个 SqliteStore 的 `COLUMNS` 数组和 [db-migration.ts](../src/server/db-migration.ts) 里对应的 `*_COLUMNS` 数组是**两份独立定义**，靠人工同步。`safeAddColumn` 在表不存在时静默失败，所以 fresh DB 完全靠 migration 的 COLUMNS 列表创建表。

**当前状态**：现在 [SqliteStore.ensureTable](../src/server/sqlite-store.ts#L75) 在 CREATE TABLE 之后会读 table_info，对每个声明的列做 ALTER ADD COLUMN if missing。这意味着即使 migration 的 *_COLUMNS 落后，store 自己会补齐。

**仍需做**：长期目标是让 db-migration.ts 直接 import 各 store 的 COLUMNS 常量，彻底消除双源。当前 self-heal 是 safety net，不是根除。

### 2. IpcContext 全 `any`，typedHandle 是假类型安全（已修复）

**状态**：✅ 2026-06-02 R6 已完成 — [src/main/ipc/types.ts](../src/main/ipc/types.ts) 15 个字段全部改成真类型，连带修复 3 个被 `any` 掩盖的 bug（kb:add-files 返回类型、config:get-theme null 语义、logs:get-config globalLevel 推断），并补全 preload 的 `onSessionLifecycle` 类型声明。

**根因回顾**：原本 IpcContext 字段全是 `any`，handler 写 `_ctx.agentToolStore.getByAgentId(id)` 编译器不报错，但运行时若 `agentToolStore` 未就绪会 undefined。[typed-ipc.ts](../src/main/ipc/typed-ipc.ts) 的泛型只在 handler 函数签名层面给类型，没要求 ctx 字段也有类型。

**仍需做**：`registerCrud` 的 `store: () => ctx.agentStore as any` 强转保留 — 因 CrudStore 接口的 `update(id, Update)` 与实际 store 的 `update(id, Partial<Omit<...>>)` 不兼容。需要后续重构 CrudStore 接口或 store 签名。

### 3. handler 声明的依赖不准确 ✅ 已修（2026-06-02 R2）

**状态**：✅ 2026-06-02 已修正所有已知的 modules 数组漏报，并加自动化检查脚本 [scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts)（`npm run check:handlers`）。

**之前症状**：曾存在 [chat-handlers.ts:9](../src/main/ipc/chat-handlers.ts#L9) `chat:send` 声明 `["agentService", "workspaceConfig"]` 但实际还访问 `providerStore`、`agentStore`。`chat:abort` 声明 `[]` 但访问 `agentService`。

**根因**：typedHandle 不强制校验，靠开发者自觉。

**修法**：AST 脚本扫每个 `typedHandle(name, modules, handler)` 调用，对比声明的 modules 数组和 handler 内 `ctx.*` 访问。同时检查 `registerCrud({ module, store: () => ctx.X })`。新加 handler 漏写会立刻 fail。

### 4. `activeSessionId` 同步路径脆弱（已修复）

**状态**：✅ 2026-06-02 R5 已完成 — 移除 chat-store 的 `messages` 和 `isStreaming` 双源字段，改为 derived selector（`selectActiveMessages` / `selectIsStreaming`）。所有 setter 只写 `messagesBySession` 和 `streamingSessions`，不再维护镜像状态。

**根因回顾**：原本 [chat-store.ts](../src/renderer/store/chat-store.ts) 维护 `messagesBySession + messages` 双状态，每个 setter 都要判断 `isActive = sessionId === activeSessionId` 决定是否同步 `messages`。容易漏写导致用户消息不渲染、text_delta 在 activeSessionId 切换时静默丢弃等问题。

**踩过的坑**：selector 写成 `?? []` 字面量会触发 React error #185（无限重渲染），因为每次调用产生新数组引用。修法是模块级常量 `EMPTY_MESSAGES`。

### 5. 单元测试几乎为零（部分缓解）

**状态**：⚠️ 2026-06-02 引入 vitest，覆盖纯逻辑模块（85 个测试）。SQL/runtime 大模块仍未覆盖。

**已完成**（见 [R9](04-recommendations.md#r9)）：chat-store（23 个 + dual-state 不变量断言）、agent-utils（26 个）、default-prompt（4 个）。mutation 测试验证 chat-store 测试能真实捕获 dual-state 回归。

**未覆盖**：
- `db-migration.ts` / `recovery.ts` / `kb-search.ts` 等 SqliteStore 用户 — better-sqlite3 编译给 Electron 的 Node 版本（NODE_MODULE_VERSION 145），vitest（普通 Node 137）无法加载。需 E2E 兜底。
- `agent-loop.ts` — 依赖太多（AI SDK、子进程、tool registry），单测 ROI 低。

**修复建议**：见 [04-recommendations.md](04-recommendations.md) 测试章节。

### 6. `any` 在 public API 上

**最严重的几处**：
- [src/main/ipc/types.ts](../src/main/ipc/types.ts) — 整个 IpcContext — ✅ R6 已修
- [src/shared/ipc-api.ts:139](../src/shared/ipc-api.ts#L139) `"todos:get": { result: any[] }` — ⚠️ 标 TODO，等 todos 功能补完时一起改
- [src/runtime/agent-utils.ts:48](../src/runtime/agent-utils.ts#L48) `parseThinkingTags(): any[]` — ✅ 2026-06-02 已改为 `ThinkingBlock[]`
- `files:tree` 返回 `any` — ✅ 2026-06-02 已改为 `FileTreeNode[]`

**总数据**：378 处 `any`（215 `: any` + 163 `as any`）。

**top 5 文件**：
1. `agent-loop.ts` — 28
2. `template-handlers.ts` — 27
3. `main/ipc/core.ts` — 22
4. `mcp-handlers.ts` — 18
5. `main/ipc/types.ts` / `kb-handlers.ts` — 各 16

### 7. 错误吞噬（部分已修）

**状态**：⚠️ 2026-06-02 已处理真正静默 + 标 "ignore" 但属于真实错误的几处。其他 best-effort 路径（file-log-sink、rename backup、glob skip 等）保持原样，已有注释说明意图。

**91 个 catch 块**。已修：
- [src/runtime/agent-loop.ts:334](../src/runtime/agent-loop.ts#L334) retry 时删 turn 失败 → `log.warn("loop", ...)`
- [src/main/ipc/template-handlers.ts:54](../src/main/ipc/template-handlers.ts#L54) GitHub cache 保存失败 → `log.warn("ipc", ...)`
- [src/renderer/components/agents/AgentEditor.tsx:266](../src/renderer/components/agents/AgentEditor.tsx#L266) UI 自动保存失败 → `console.error`
- [src/server/session-manager.ts:140](../src/server/session-manager.ts#L140) metrics 持久化失败 → `log.warn("session", ...)`
- [src/server/mcp-manager.ts:134](../src/server/mcp-manager.ts#L134) MCP transport close 失败 → `log.warn("mcp", ...)`

**仍需关注**：
- [src/main/ipc/core.ts:248](../src/main/ipc/core.ts#L248) MCP reconnect 错误吞噬 — fire-and-forget，建议至少 log
- [src/main/index.ts:75](../src/main/index.ts#L75) chcp 设置失败 — 合理 best effort，保留

## 🟡 中优先级

### 8. god 文件

| 文件 | 行数 | 问题 |
|------|------|------|
| [AgentEditor.tsx](../src/renderer/components/agents/AgentEditor.tsx) | 304 (was 688) | ✅ 2026-06-02 已拆 — state 留 orchestrator，5 个 section + ConfirmModal + agent-editor-types.ts |
| [agent-loop.ts](../src/runtime/agent-loop.ts) | 784 | 单 turn 执行 + retry + streaming + tool 调度 |
| [SettingsPage.tsx](../src/renderer/components/settings/SettingsPage.tsx) | 119 (was 667) | ✅ 2026-06-02 已拆 — 6 个 satellite 组件（ProviderCard / ProviderEditor / DeviceContextSettings / GuidelinesSettings / WorkspaceSettings / ThemeSettings）|
| [ChatPanel.tsx](../src/renderer/components/layout/ChatPanel.tsx) | 431 | 可接受，但 session 切换 + 输入 + 消息渲染可拆 |
| [session-handlers.ts](../src/main/ipc/session-handlers.ts) | 6 个独立操作（已拆出 message-handlers） | ✅ 2026-06-02 已拆 |
| [template-handlers.ts](../src/main/ipc/template-handlers.ts) | 47 (was 188) | ✅ 2026-06-02 已拆 — 7 CRUD handler 留原文件，github preview/import 拆到 [github-template-handlers.ts](../src/main/ipc/github-template-handlers.ts) |

### 9. AppLayout 的 `onAgentEvent` switch 巨大 ✅ 已修（2026-06-02 R8）

[AppLayout.tsx onAgentEvent](../src/renderer/components/layout/AppLayout.tsx) 改为 dispatcher map，新增 event type 只动 handlers object，不动主体。

### 10. 双构建系统

`tsc` (dist/) + `electron-vite` (out/) 并存。`dist/` 用于 npm 发布，但实际是否发布 npm 不明。

**修复建议**：如果不发 npm，删除 `build:lib` 脚本和 `tsconfig.cli.json`，简化构建。

### 11. 预加载暴露面太宽

[preload/index.ts](../src/preload/index.ts) 暴露 156 个 IPC 方法，无 capability 分级。任何渲染进程代码都能调用任何 IPC。

**修复建议**：
- 短期：保持现状（context isolation 已提供基本保护）
- 长期：把 preload API 按模块切分，按页面 / 角色分级暴露

### 12. 硬编码 URL 和 magic number ✅ 已完成（2026-06）

主要 URL 与常量已抽到 [src/core/constants.ts](../src/core/constants.ts)：
- `EXEC_MAX_BUFFER_BYTES` (10 MB) — 替换 6 处 maxBuffer
- `OUTPUT_TRUNCATION_CHARS` (50_000) — 替换 3 处输出截断
- `DEFAULT_URLS.{ollama, searxng, openai}` — 替换 KB / search / provider 默认 URL
- `DEV_SERVER_URL` — 替换 main/index.ts 中的 vite dev URL

未抽的（暂留）：
- `200`（agent loop max steps）— 已通过 SessionConfig 暴露给配置，不算硬编码
- 各类超时（1500/2000/5000/10000ms）— 散落于 UI 动画 / 重试逻辑，分类抽常量收益低
- MCP SSE / API server 默认端口 — 这两条路径暂未启用

### 13. Provider 类型与 UI 选项不匹配

[provider-factory.ts](../src/runtime/provider-factory.ts) switch 没有 `minimax` / `glm` / `deepseek` 等中国厂商。用户实际只能选 `openai-compatible`。这导致：
- thinking / reasoning 字段在 openai-compatible 路径下不会自动启用
- 错误码分类不针对具体厂商
- UI 上选 MiniMax/GLM 时实际类型仍是 openai-compatible，配置不直观

**修复建议**：
- 短期：UI 层给 MiniMax / GLM / DeepSeek 等加 preset（自动填 baseUrl + 启用 reasoning）
- 长期：加原生 case，支持厂商特有功能

## 🟢 低优先级（清理类）

### 14. 残留文件（部分已清）

**状态**：✅ 2026-06-02 已删除 `env-dump.txt`，`test-results/` 已加入 `.gitignore`。

**仍需关注**：
- `src/renderer/components/workspace/`（空目录）
- `build/`、`resources/`（空目录 — git 不追踪空目录，磁盘上无害）

> 已删除：`env-dump.txt`（2026-06-02 调试残留）、`openclaw.plugin.json`（2026-06-02，原计划做成 Pi Agent 插件，现已独立 harness，不再需要）。

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
| 单元测试 | 85 |
| 硬编码 URL | 0（核心默认值已抽常量） |
