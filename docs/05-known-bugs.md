# 05 · 已知 Bug 与潜在问题

> 这里的 bug 不一定是 P0，但都是已经定位、还没完全处理的。

## 已修复（最近）

### B1. fresh DB 上 AgentToolStore 构造崩溃

**位置**：[db-migration.ts:33-51](../src/server/db-migration.ts#L33)

**症状**：`SqliteError: no such column: auto_background_timeout` in `new AgentToolStore(_sessionDb)`，启动失败。

**根因**：`AGENT_TOOL_COLUMNS` 数组（migration 文件）漏了 `auto_background_timeout`，但 [AgentToolStore COLUMNS](../src/server/agent-tool-store.ts#L25) 有。fresh DB 上 `safeAddColumn` 在表不存在时静默失败 → `CREATE TABLE IF NOT EXISTS` 用 migration 的列定义建表 → 缺列。

**修复**：补齐 AGENT_TOOL_COLUMNS。

**遗留风险**：架构问题未根除 — 见 [03-tech-debt.md §1](03-tech-debt.md#1-sqlite-migration-列同步问题架构层面未根除)。其它 store 同样模式，加列时容易复发。

---

### B2. 初始 agent 选择后 activeSessionId 永远 null

**位置**：[chat-store.ts](../src/renderer/store/chat-store.ts) + [ChatPanel.tsx:187-191](../src/renderer/components/layout/ChatPanel.tsx#L187)

**症状**：选 agent 后发消息，user 气泡和 assistant 气泡都不渲染。生产环境长期潜伏，E2E 测试才暴露。

**根因**：`refreshSessionData` 调用 `sessionsActivate` IPC 但没拿返回值的 sessionId，没调 `setActiveSessionId`。`session_init` 事件 handler 调 `initSession` 但 initSession 不会更新 activeSessionId。结果 activeSessionId 一直 null，chat-store 的 `isActive` 判断全失败，messages 永远空。

**修复**：sessions:activate 返回 sessionId，refreshSessionData 调 setActiveSessionId。还加了 `data-session-id` 属性让 E2E 能等就绪。

**遗留风险**：双状态架构（messagesBySession + messages）未根除。任何 store action 还在 `isActive ? ... : state.messages` 判断。如果未来又有路径漏 setActiveSessionId，类似 bug 会复现。

---

## 已知问题（未修）

### B3. recovery 不清理 stuck pending turn

**位置**：[agent-service.ts:391-398](../src/server/agent-service.ts#L391)

**症状**：`turn_state` 表里 status='pending' 但超过 24h 没活动的记录不会被自动清理。

**影响**：长时间运行后 `turn_state` 表可能堆积。重启时 recovery 会尝试 resume 这些旧 turn，可能错误。

**建议**：recovery 加一个"过期 pending 视为 failed"的清理逻辑。

### B4. MCP reconnect 失败静默

**位置**：[core.ts:248](../src/main/ipc/core.ts#L248)

```ts
_mcpManager.reconnectEnabled(_mcpStore.list()).catch(() => {});
```

**症状**：MCP server 配置错误（命令不存在、URL 不通）时，启动期 reconnect 失败被完全吞掉。用户不知道为什么 server 没启动。

**建议**：错误至少 `log.warn`，最好 broadcast 给 renderer 显示一个 banner。

### B5. chat-store 在 activeSessionId null 时丢弃事件

**位置**：[chat-store.ts](../src/renderer/store/chat-store.ts) 所有 action 的 `isActive = sessionId === state.activeSessionId` 判断

**症状**：如果 session_init 在 setActiveSessionId 之前到达（race），messages 字段不会被更新。

**影响**：B2 修复后大概率不再触发，但仍是潜在 race。

**建议**：见 R5 chat-store 单源化。

### B6. provider-factory 不支持 MiniMax / GLM 原生

**位置**：[provider-factory.ts:105-134](../src/runtime/provider-factory.ts#L105)

**症状**：用户实际跑 MiniMax / GLM 时走 openai-compatible 路径，缺失：
- 厂商特定 reasoning 支持
- 厂商特定错误码分类
- UI 上选 provider 类型时没有这两个选项

**影响**：体验问题，不是崩溃。但用户主力 provider 就是这两个。

**建议**：见 R7 加 preset。

### B7. test-setup.ts 默认创建的 agent 名为 "TestAgent"

**位置**：[test-setup.ts:78](../src/main/test-setup.ts#L78)

**症状**：E2E 测试只有一个 agent，多 agent 场景覆盖不到。

**建议**：未来加多 agent E2E 时扩展 seed 函数支持多 agent。

### B8. KV migration 单个失败不报错

**位置**：[db-migration.ts:175-177](../src/server/db-migration.ts#L175)

```ts
for (const { key, file } of kvMigrations) {
  kv.migrateFromJsonFile(key, join(zeroDir, file));
}
```

**症状**：循环里没有 try/catch，单个 migration 失败会终止后续 migration。或者反过来 — 一旦失败整个 KV migration 半完成，状态难恢复。

**建议**：每个 migration 单独 try/catch + log。

### B9. error 处理在 chat:send 的 sendPrompt

**位置**：[chat-handlers.ts:35-39](../src/main/ipc/chat-handlers.ts#L35)

```ts
svc.sendPrompt(text, agent, sessionId).catch((err: any) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send("agent:event", { type: "error", error: err.message, ... });
  }
});
```

**症状**：错误通过 `agent:event` 而不是 IPC return 传递。renderer 在 AppLayout 收到 error 事件后 `updateAssistantText(key, "\nError: " + error)`。

**问题**：
- 如果 user 还没发出第一条消息，没有 assistant 气泡可附加 — error 文本无处显示
- error 没在 UI 用 toast / banner 突出，用户可能漏看

**建议**：错误显示路径加一个独立的 error store + UI banner。

### B10. typing test fixture 单 agent 单 response

**位置**：[tests/e2e/](../tests/e2e/)

**症状**：E2E 只覆盖：
- 单 agent 单 response
- A → B → A 切换

**未覆盖**：
- 多次往返对话
- 工具调用链路
- Thinking / reasoning 流式
- Recovery（kill + restart）
- MCP tool 调用
- KB 检索
- agent 编辑后 session 续聊
- session 删除

**建议**：见 R11。

---

## 之前发生过但已修的（防止重复）

| 编号 | 问题 | 修复 |
|------|------|------|
| 历史-1 | `ELECTRON_RUN_AS_NODE` 环境变量从父 shell 继承，导致 Electron 启动为 Node 进程 | [test-app.ts](../tests/e2e/helpers/test-app.ts) 启动前显式 unset |
| 历史-2 | DevTools 窗口被 `firstWindow()` 抓成主窗口 | [index.ts](../src/main/index.ts) test mode 下不开 DevTools |
| 历史-3 | test mode 用 dev server URL 导致 connection refused | [index.ts](../src/main/index.ts) test mode 走 loadFile |
| 历史-4 | better-sqlite3 NODE_MODULE_VERSION 不匹配 | 必须用 node-gyp 编译，[见 memory](../C:/Users/Administrator/.claude/projects/c--Users-Administrator-Documents-workspace-agent-zero-core/memory/feedback-native-module-rebuild.md) |

---

## 排查 cheat sheet

### 启动崩 — 看这几个地方

1. `out/main/index.cjs` 是否最新（`npm run build`）
2. `ZERO_CORE_DIR` 是否指向预期位置（默认 `~/.zero-core`）
3. SQLite 文件是否存在且列齐全（`.tables` + `.schema <table>`）
4. better-sqlite3 是否针对当前 Electron 版本编译

### 跑不动 — IPC 没响应

1. `typedHandle` 的 modules 数组是否声明完整
2. `moduleReadiness` 是否 resolve 了对应模块（看启动日志）
3. preload 是否暴露了对应 channel（[preload/index.ts](../src/preload/index.ts)）

### 流式不工作 — 看 onAgentEvent

1. AppLayout 的 dispatcher 是否处理了 event type
2. chat-store action 是否在 activeSessionId null 时 noop
3. session_init 是否在 streaming 开始前到达
