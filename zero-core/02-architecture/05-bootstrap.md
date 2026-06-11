# 启动编排

> 后端启动涉及 14 个模块的初始化，被精心组织成 **6 个 phase**。理解这个 phase 图是理解整个 runtime 依赖关系的关键。

---

## 一、为什么需要"显式分阶段"

后端启动时要构造的依赖图：

```
SessionDB ──┬──> KeyValueStore
            ├──> MemoryStore
            ├──> MemoryNodeStore
            └──> AgentStore, ProviderStore, ... (依赖 SessionDB.getDb())

ToolRegistry ──> SessionDB.getKVStore()       ← 必须在 SessionDB 之后
              └──> runtime/tools (静态导入)

MCPManager ──> ToolRegistry (notifyChange 调用)   ← 必须在 ToolRegistry 之后
             └──> McpStore (动态发现外部配置)

AgentService ──> 几乎所有上面
              ├──> SessionDB
              ├──> KbStore
              ├──> ToolRegistry
              ├──> MCPManager
              └──> ProviderStore (setProviders)

SessionManager ──> AgentService
MetricsHooks ──> SessionManager
```

如果用**任意顺序的 import**，循环依赖会爆炸。显式 phase + 同步执行 + 错误传播是规避的唯一办法。

---

## 二、Phase 划分（`server/index.ts#startServer`）

```typescript
async function startServer(opts) {
  // ── Phase 0: SessionDB + Migrations ──────────────────
  const sessionDB = new SessionDB();
  runMigrations(sessionDB);

  // ── Phase 1: Hook Systems ────────────────────────────
  registerDurableHooks(sessionDB);
  registerToolExecutionHooks(sessionDB);
  registerAllRuntimeHooks(sessionDB);

  // ── Phase 2: Stores + WorkspaceConfig ───────────────
  const registry = new ToolRegistry(sessionDB.getKVStore());
  registerRuntimeTools(registry);
  const mcp = new MCPManager(registry);
  const agentStore = new AgentStore(sessionDB);
  const agentToolStore = new AgentToolStore(sessionDB);
  agentToolStore.cleanupOrphans();
  registerAgentToolEntries(agentToolStore, registry);
  const providerStore = new ProviderStore(sessionDB);
  const templateStore = new TemplateStore(sessionDB);
  const mcpStore = new McpStore(sessionDB);
  const kbStore = new KbStore(sessionDB);
  const kbDb = new KbDB();
  let workspaceConfig = loadWorkspaceConfig(sessionDB);

  // ── Phase 2b: Test Seed (only if env var set) ────────
  if (process.env.ZERO_CORE_TEST_FIXTURE) {
    seedTestEnvironment(sessionDB, agentStore, providerStore);
    workspaceConfig = loadWorkspaceConfig(sessionDB);
  }

  // ── Phase 3: AgentService ────────────────────────────
  const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, kbStore, registry, mcp);
  agentService.setAgentStore(agentStore);
  agentService.setAgentToolStore(agentToolStore);
  agentService.setProviders(providerConfigs, defaultModel, defaultProvider);

  // ── Phase 4: Restore Sessions + Recovery ─────────────
  await agentService.restoreAllSessions();
  if (scanIncompleteTurns(sessionDB).length > 0) {
    agentService.recoverIncompleteSessions();
  }

  // ── Phase 5: MCP Auto-detect ─────────────────────────
  const detected = await scanExternalMcpConfigs(workspaceConfig.workspaceDir);
  // ... 合并到 mcpStore, 自动连接

  // ── Phase 6: Mount Routers ────────────────────────────
  app.use("/api/config",        createConfigRouter(...));
  app.use("/api/agents",        createAgentRouter(...));
  // ... 13 个路由

  // ── Phase 7: WebSocket + Static ──────────────────────
  wss.on("connection", ...);
  if (serveStatic) app.use(express.static(rendererDir));

  // ── Phase 8: Listen ──────────────────────────────────
  await server.listen(port, ...);
  return { server, agentService };
}
```

---

## 三、为什么这个顺序

### SessionDB 必须先建

- 所有 Store 都吃 `SessionDB.getDb()`（拿 `better-sqlite3.Database` 实例）
- `KeyValueStore` 直接 `new KeyValueStore(db)`，要在 SessionDB 之后

### Hook 系统在 Phase 1 注册

- HookRegistry 是**单例**（`HookRegistry.getInstance()`）
- Durable/ToolExec Hooks 必须在任何可能触发 hook 的代码（AgentService、ToolFactory）实例化**之前**注册
- Runtime Hooks（compression / memory / RAG）同样在 AgentLoop 实例化前注册

### ToolRegistry 先于 MCPManager

- MCPManager 在 `connect()` 时调用 `registry.register(...)` 和 `registry.notifyChange()`
- 必须在 ToolRegistry 构造完之后

### AgentService 最后

- 拿全部 stores + registry + mcp
- `setProviders` 注入 provider 列表
- `restoreAllSessions` 从 DB 重建 in-memory 的 AgentLoop 实例池

### Restore 在 Routers 之前

- `restoreAllSessions` 会调用 `setSession` 等触发 hook
- 如果 Routers 还没挂，可能收到部分恢复的事件
- 实际上当前实现是 `await agentService.restoreAllSessions()` 在 routers 之前，所以事件无 UI 接收

### MCP auto-detect 在 AgentService 之后

- auto-detect 创建 McpStore 记录 + 触发 mcp.connect() → emit "mcp:status" 事件
- 此时 AgentService 已就绪，事件能被正确分发

---

## 四、Main 的 Phase 编排（`main/ipc/core.ts#loadCoreModules`）

main 这边**也**有自己的 phase 编排，因为 main 启动后端要：

1. 注册 IPC handlers（handlers 引用 _ctx 中的 services）
2. 加载后端模块（dist/server/*.js）
3. 实例化 services
4. 把 services 注入 _ctx
5. 通知所有等着的 handlers "服务就绪了"

```
Phase 0: 全部 dist 模块并行 import
   ↓
Phase 1: SessionDB + Migrations
   ↓
Phase 1b: Hooks + log config
   ↓
Phase 2: 8 个 Store + workspaceConfig
   ↓
Phase 2b: Test-mode seed
   ↓
Phase 3: ToolRegistry
   ↓
Phase 4: MCPManager
   ↓
Phase 5: AgentService
   ↓
Phase 5b: SessionManager + metrics hooks
   ↓
Phase 6: Recovery（扫描中断 turn）
```

每个 phase 失败都会**回退**（`moduleReadiness.rejectModules`），后续 phase **不执行**。

### 关键设计：`moduleReadiness` Promise-per-module

```typescript
// main/ipc/module-readiness.ts
const entries = new Map<ModuleName, {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  resolved: boolean;
  failed: boolean;
}>();

// typedHandle 注册时声明依赖
typedHandle("chat:send", ["agentService", "workspaceConfig", ...], async (ctx, ...) => { ... });
```

**效果**：
- handler 不需要 await "全部 ready"
- 每个 handler 只 await 它**真正需要**的 modules
- 失败时**精确报告**是哪个 module 失败（`getFailedModules`）

---

## 五、模块就绪的等待图

```
typedHandle("agents:list", "agentStore", handler)
                              │
                              └─→ ctx.whenReady("agentStore")  → 等待 promise resolve
                                                                │
                                                                └─ Phase 2 调 resolveModule("agentStore")

typedHandle("chat:send", ["agentService", "workspaceConfig", "providerStore", "agentStore"], handler)
                              │
                              └─→ Promise.all([
                                     ctx.whenReady("agentService"),     // 等 Phase 5
                                     ctx.whenReady("workspaceConfig"),  // 等 Phase 2
                                     ctx.whenReady("providerStore"),     // 等 Phase 2
                                     ctx.whenReady("agentStore"),         // 等 Phase 2
                                   ])
```

→ 这就是为什么 Phase 顺序必须**严格**：agentService 在 Phase 5 才就绪，handler 引用它意味着用户必须等到 Phase 5 才能 chat。

---

## 六、为什么 handler 在 services ready 之前就能注册

```typescript
// main/ipc.ts
export function registerIpc(win: BrowserWindow): void {
  setMainWindow(win);
  const ctx = getModuleState();
  setContextGetter(() => ctx);
  
  // 这 16 个 registerXxxHandlers 立即执行
  // 但它们只调用 typedHandle(channel, modules, handler)
  // handler 内部在调用时才 await ctx.whenReady(...)
  registerDialogHandlers(ctx);
  registerConfigHandlers(ctx);
  // ...
  
  // 后台异步启动 services
  loadCoreModules().then(async () => {
    await moduleReadiness.whenAllReady();
    ctx.modulesReady = true;
    win.webContents.send("app:ready", true);  // ← 通知渲染层
  });
}
```

**关键**：
- Handlers 注册是**同步**的，立即生效
- Services 是**异步**的，背景启动
- Renderer 调用 handler 时，handler 内部 `await whenReady(...)` 自动 block 直到 service 就绪
- Renderer 收到 `app:ready` 事件，UI 才显示 ready 状态

这意味着：
- 即使后端没启动完，UI 也能正常加载（loading screen）
- UI 调用 `agents:list` 在 ready 之前：handler 内部 await 几秒后返回（用户感觉是"卡了一下"）
- UI 调用 `app:ready`：直接返回当前状态（可能是 false）
- ready 之后：`app:ready` 返 true；后续 handlers 不再 block

---

## 七、Recovery 流程

```typescript
// server/index.ts Phase 6
const interrupted = scanIncompleteTurns(sessionDB);
if (interrupted.length > 0) {
  agentService.recoverIncompleteSessions();
}

// session-db.ts#scanIncompleteTurns
//   → SELECT * FROM turn_state WHERE phase != 'complete'
//   → 对每条 24h 以上的 turn_state 调 cleanOldTurnState
//   → 返回剩余的未完成 turn
```

```typescript
// server/recovery.ts
export function scanIncompleteTurns(db): Array<{sessionId, turnSeq, phase}> {
  db.cleanOldTurnState(24 * 60 * 60 * 1000);  // 24h 前清理
  return db.getIn
turnState
  return db.getIncompleteTurns();
}
```

```typescript
// server/recovery.ts
export function scanIncompleteTurns(db): Array<{sessionId, turnSeq, phase}> {
  db.cleanOldTurnState(24 * 60 * 60 * 1000);  // 24h 前清理
  return db.getIncompleteTurns();
}
```

**recoverIncompleteSessions 行为**（agent-service.ts）：
- 把每个未完成 turn 的 blocks 加载到对应 session 的 AgentLoop 中
- 触发 `SessionStart` hook（但传 `(resumed)` userMessage）
- AgentLoop 重新跑 → 续上中断的 turn

**为什么不自动 resume**：用户可能已经在干别的了。让 UI 显示"未完成 turn"列表，让用户决定是否续。

→ 详见 `06-decisions/03-runtime-as-source-of-truth.md`

---

## 八、CLI 形态的启动（无 phase）

CLI 形态不走 phase，因为：

1. 单进程（不需要 IPC 等待）
2. 用 `restoreAllSessions` 后直接进入 readline 主循环
3. 如果失败，整个进程退出，没有 UI 可回退

```typescript
// src/cli.ts
async function main() {
  const sessionDB = new SessionDB();
  runMigrations(sessionDB);
  const registry = new ToolRegistry(sessionDB.getKVStore());
  registerRuntimeTools(registry);
  // ... 直接全量构造
  // 没有等待，没有 fallback
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
```

---

## 九、Dev vs Packaged 启动差异

| 维度 | Dev | Packaged |
|------|-----|----------|
| Renderer 加载 | `loadURL("http://localhost:5173")` (Vite dev) | `loadFile("out/renderer/index.html")` |
| DevTools | `openDevTools({mode:"detach"})` | 不开 |
| 后端 spawn | `spawn("node", ...)`（系统 Node） | `fork(...)`（Electron fork） |
| Test fixture | `ZERO_CORE_TEST_FIXTURE` env 启用 seed | 同 |
| 日志级别 | 总是 debug（DEBUG=1 时） | 同 |

**dev 模式独有**：`isDev && !process.env.ZERO_CORE_TEST_FIXTURE` —— 测 fixture 模式下不开 DevTools，避免遮住 viewport。
