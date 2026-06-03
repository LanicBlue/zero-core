# 05 · 已知 Bug 与潜在问题

> 最近重写：2026-06（B3/B4/B8/B9/B11/B12 已修）

## 已修复（2026-06 这一轮）

### B1. fresh DB 上 AgentToolStore 构造崩溃 ✅

**根因**：`AGENT_TOOL_COLUMNS` 数组漏了 `auto_background_timeout`，但 AgentToolStore 的 COLUMNS 有。fresh DB 上 `safeAddColumn` 在表不存在时静默失败。

**修复**：补齐 AGENT_TOOL_COLUMNS + R1 SqliteStore self-heal（构造时 ALTER ADD COLUMN if missing）。

### B2. 初始 agent 选择后 activeSessionId 永远 null ✅

**根因**：`refreshSessionData` 调 `sessionsActivate` 但没拿返回值的 sessionId，没调 `setActiveSessionId`。

**修复**：sessions:activate 返回 sessionId，refreshSessionData 调 setActiveSessionId。加 `data-session-id` 属性让 E2E 能等就绪。

### B3. recovery 不清理 stuck pending turn ✅

**位置**：[session-db.ts cleanOldTurnState](../src/server/session-db.ts)

**修复**：cutoff 改为删除所有早于 24h 的行（不再按 phase 过滤）。pending 不再累积，重启时不再尝试 resume 僵尸 turn。

### B4. MCP reconnect 失败静默 ✅

**位置**：[core.ts MCP reconnect](../src/main/ipc/core.ts)

**修复**：`.catch(() => {})` 改为 `.catch((err) => log.warn("mcp", ...))`。

### B5. chat-store 在 activeSessionId null 时丢弃事件 ✅

R5 单源化解决。`selectActiveMessages` / `selectIsStreaming` 不再有"双状态同步"race。

### B8. KV migration 单个失败不报错 ✅

**位置**：[db-migration.ts KV migrations](../src/server/db-migration.ts)

**修复**：每个 migration 单独 try/catch + `log.warn("migration", ...)`。单个失败不阻断后续。

## 已知问题（未修，非阻塞）

### B6. provider-factory 不支持 MiniMax / GLM 原生

**位置**：[provider-factory.ts](../src/runtime/provider-factory.ts)

**症状**：MiniMax / GLM 走 openai-compatible 路径，缺失厂商特定 reasoning 支持 + 错误码分类。UI 上 provider 类型也没这两个选项。

**影响**：体验问题，不是崩溃。

**建议**：R7 preset。**用户已判定不值得做**，需要时再回来。

### B7. test-setup.ts 默认创建的 agent 名为 "TestAgent"

**位置**：[test-setup.ts:78](../src/main/test-setup.ts#L78)

**症状**：E2E 测试只有一个 agent，多 agent 场景覆盖不到。

**建议**：未来加多 agent E2E 时扩展 seed 函数。

### B9. error 处理在首条消息失败时无处显示 ✅

**根因**：updateAssistantText 查找已有的 assistant 消息来附加错误文本，但第一条消息失败时还没有 assistant 消息。

**修复**：chat-store 加 lastError 状态 + setError/clearError actions。AppLayout error handler 同时调 setError。ChatPanel 渲染 ErrorBanner 组件（5 秒自动消失 + 手动关闭）。


### B11. refreshSessionData 调用顺序导致 session 列表为空 ✅

**根因**：refreshSessionData 先调 sessionsList（此时 DB 还没 session），再调 sessionsActivate（此时才创建 session）。列表用的是过期数据。

**修复**：调换顺序，先 sessionsActivate 确保 session 存在，再 sessionsList 获取列表。

### B12. 删除活跃 session 后消息不加载 ✅

**根因**：handleDeleteSession 用 clearMessages 清空消息，但没有调用 sessionsActivate 加载新 session 的消息历史。

**修复**：改为调用 sessionsActivate(agentId, newSessionId)，让后端发 session_init 事件加载消息。

### B10. testing fixture 单 agent 单 response

**位置**：[tests/e2e/](../tests/e2e/)

**症状**：E2E 只覆盖单 agent 单 response + A → B → A 切换。

**已覆盖（R11）**：多轮对话（3 轮连续消息）、error banner（出现/关闭/自动消失）、session 删除（活跃 + 非活跃 session）。
**仍未覆盖**：工具调用链路、Thinking / reasoning 流式、Recovery（kill + restart）、MCP tool 调用、KB 检索、agent 编辑后续聊。

**建议**：见 R11。

## 之前发生过但已修的（防止重复）

| 编号 | 问题 | 修复 |
|------|------|------|
| 历史-1 | `ELECTRON_RUN_AS_NODE` 环境变量从父 shell 继承，导致 Electron 启动为 Node 进程 | [test-app.ts](../tests/e2e/helpers/test-app.ts) 启动前显式 unset |
| 历史-2 | DevTools 窗口被 `firstWindow()` 抓成主窗口 | [index.ts](../src/main/index.ts) test mode 下不开 DevTools |
| 历史-3 | test mode 用 dev server URL 导致 connection refused | [index.ts](../src/main/index.ts) test mode 走 loadFile |
| 历史-4 | better-sqlite3 NODE_MODULE_VERSION 不匹配 | 必须用 node-gyp 编译，[见 memory](../C:/Users/Administrator/.claude/projects/c--Users-Administrator-Documents-workspace-agent-zero-core/memory/feedback-native-module-rebuild.md) |

## 排查 cheat sheet

### 启动崩 — 看这几个地方

1. `out/main/index.cjs` 是否最新（`npm run build`）
2. `ZERO_CORE_DIR` 是否指向预期位置（默认 `~/.zero-core`）
3. SQLite 文件是否存在且列齐全（`.tables` + `.schema <table>`）
4. better-sqlite3 是否针对当前 Electron 版本编译

### 跑不动 — IPC 没响应

1. `typedHandle` 的 modules 数组是否声明完整（`npm run check:handlers`）
2. `moduleReadiness` 是否 resolve 了对应模块（看启动日志）
3. preload 是否暴露了对应 channel（[preload/index.ts](../src/preload/index.ts)）

### 流式不工作 — 看 onAgentEvent

1. AppLayout 的 dispatcher 是否处理了 event type
2. chat-store action 是否在 activeSessionId null 时 noop（应该返回 state）
3. session_init 是否在 streaming 开始前到达

### handler modules 数组校验

```bash
npm run check:handlers
```

输出会列出所有不匹配的 handler（声明了 X 但实际访问了 Y）。
