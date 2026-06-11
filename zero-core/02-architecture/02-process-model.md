# 进程生命周期与交互

## 进程角色一览

| 进程 | 触发器 | 寿命 | 子进程？ |
|------|--------|------|----------|
| **Electron Main** | 用户双击 Zero-Core.app | 应用会话 | spawn Backend |
| **Backend (Node.js)** | Main `app.whenReady` | 与 Main 同寿（before-quit 关闭） | 无 |
| **Renderer** | Main `createWindow` | 窗口关闭销毁 | 无 |
| **Login BrowserWindow** | 用户触发 webfetch:login | 关闭后销毁 | 无 |
| **SPA BrowserWindow** | webfetch render mode = browser | 抓取完成销毁 | 无 |
| **MCP stdio 子进程** | MCP 客户端 connect() | 断开或 disconnect() | 是 |
| **MCP sse/streamable-http** | 长连接 | 服务端断开 | 否（远程） |
| **CLI 进程** | `zero-core` / `node dist/cli.js` | 用户 Ctrl+C | 无 |

---

## 启动序列（桌面形态）

```
用户双击 Zero-Core
    │
    ▼
┌─────────────────────────────┐
│  Electron Main 进程启动       │
│  src/main/index.ts           │
└──────────────┬──────────────┘
               │ app.whenReady
               ▼
   ┌───────────────────────────┐
   │ 1. spawnBackend()          │  ← 关键：异步握手
   │    - 决定 spawn vs fork     │
   │    - dev  → spawn(node)     │
   │    - pkgd → fork(dist)      │
   │    - 等待 {type:"ready"}    │
   │    - 30s 超时                │
   └──────────┬────────────────┘
              │ port: 53217
              ▼
   ┌───────────────────────────┐
   │ 2. createWindow()           │  ← 标题栏/边框/尺寸
   │    - contextIsolation: true │
   │    - nodeIntegration: false │
   │    - webviewTag: true       │
   │    - preload: index.cjs     │
   └──────────┬────────────────┘
              │
              ▼
   ┌───────────────────────────┐
   │ 3. registerProxyHandlers()  │  ← 47 IPC 通道 → HTTP
   │ 4. registerLocalHandlers()  │  ← 3 个本地：window-* / dialog
   │ 5. connectEventBridge()     │  ← WS 重连机制
   └──────────┬────────────────┘
              │
              ▼
   ┌───────────────────────────┐
   │ 6. (dev) openDevTools()     │
   │ 7. 启动 tick 事件循环       │
   └───────────────────────────┘

   ┌── 后端并行启动 ──────────────────────────────────┐
   │  src/backend.ts → startServer()                  │
   │                                                   │
   │  Phase 0: spawn SessionDB + runMigrations         │
   │  Phase 1: register DurableHooks + ToolExecHooks   │
   │  Phase 2: 创建全部 9 个 Store                     │
   │  Phase 3: ToolRegistry                            │
   │  Phase 4: MCPManager                              │
   │  Phase 5: AgentService                             │
   │  Phase 5b: SessionManager + metrics hooks          │
   │  Phase 6: Recovery（扫描中断 turn）                │
   │  挂载 13 个 REST 路由                              │
   │  连接 WebSocket                                    │
   │  监听 --port                                      │
   │  → 输出 {"type":"ready","port":N}                 │
   └───────────────────────────────────────────────────┘
```

详见 `02-architecture/05-bootstrap.md`。

---

## 后端子进程的两种 spawn 模式

```typescript
// src/main/backend-spawn.ts
if (isPackaged) {
  // 用户机器可能没有 node → 用 Electron fork
  child = fork(backendPath, ["--port=0"], { stdio: ["pipe","pipe","pipe","ipc"] });
} else {
  // 开发模式 → 用系统 Node（better-sqlite3 编译给系统 ABI）
  child = spawn("node", [backendPath, "--port=0"], { stdio: ["pipe","pipe","pipe"] });
}
```

**关键问题**：better-sqlite3 是 **原生模块**（.node 文件），其二进制必须匹配 Node ABI。

| 环境 | Node ABI | Electron ABI | 解决方法 |
|------|----------|--------------|----------|
| Dev | 系统 Node | — | `npm install` 默认用系统 Node ABI |
| Packaged | — | Electron | `electron-builder#npmRebuild: true` 重新编译 |

**为什么 spawn vs fork 都要**：
- dev 模式 Electron 的 Node ABI ≠ 系统 Node ABI。如果 fork，better-sqlite3 加载失败 → 段错误
- packaged 模式用户机器可能没装 Node。如果 spawn 找不到 node，进程直接退出
- 解决：dev 用 spawn，packaged 用 fork，且 packaged 走 electron-builder 的 npmRebuild

---

## IPC 协议：47 个通道的代理

`src/main/ipc-proxy.ts` 维护一个 `R` 对象：channel → `{ method, path, buildReq }`。

```typescript
const R = {
  "agents:list":          { method: "GET",   path: "/api/agents",                  buildReq: () => ({}) },
  "agents:create":        { method: "POST",  path: "/api/agents",                  buildReq: (input) => ({ body: input }) },
  "chat:send":            { method: "POST",  path: "/api/chat/send",               buildReq: (text, agentId, sessionId) => ({ body: { text, agentId, sessionId } }) },
  "tools:list":           { method: "GET",   path: "/api/config/tools",            buildReq: () => ({}) },
  "kb:search":            { method: "POST",  path: "/api/kb/search",               buildReq: (kbIds, query) => ({ body: { kbIds, query } }) },
  // ... 共 47 个
};
```

**47 vs 49**：49 个 IPC 通道中，47 个走 HTTP 代理；2 个本地处理：
- `dialog:openDirectory` → `dialog.showOpenDialog`（主进程原生对话框）
- `webfetch:login` → 创建独立 BrowserWindow 完成 Cookie 捕获

**为什么用查表而不是装饰器**：
- 47 个通道如果用装饰器注册，会散落在多个 handler 文件中，难统一治理
- 集中查表让"加通道 = 改一个表项 + 写路由 + 加 type" 三处即可

---

## WebSocket 事件桥

```typescript
// src/main/ipc-proxy.ts
export function connectEventBridge(win: BrowserWindow, port: number): void {
  function connect() {
    _ws = new WebSocket(`ws://localhost:${port}/ws`);
    _ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "reconnect") {
        // 重新发送 UI 状态，让重连后能"接续"未完成的流
        win.webContents.send("app:ready", true);
      }
      // 透传：StreamEvent → IPC agent:event
      win.webContents.send("agent:event", event);
    });
    _ws.on("close", () => setTimeout(connect, 2000));  // 自动重连
  }
  connect();
}
```

**为什么用 WS 而不是 IPC push**：
- IPC 只能"调用-响应"模式，事件推送需要走 `webContents.send`，但 main 不会自己产生事件
- 后端产生 `StreamEvent`，主进程**无法**主动收到
- 用 WS 桥接，后端 → main → renderer 三跳，事件流始终是推
- 重连机制：Renderer 切换窗口、前后端短暂失联都能自愈

**重连时发 `reconnect` 事件**：让 Renderer 重新查询 `getState()`，把当前流式进度重新渲染出来（因为事件是单向的，丢失的 delta 拿不回来）

---

## 后端优雅关闭

```
用户关闭主窗口
    │
    ▼
app.on("before-quit")
    │
    ▼
shutdownBackend()
    │
    ├── 1. stdin 写入 {"type":"shutdown"}    ← 优雅请求
    ├── 2. 等 5s                                   ← 正常退出
    │       │
    │       └── (5s 没退)
    ├── 3. SIGTERM                                 ← 强制
    ├── 4. 再等 3s
    │       │
    │       └── (3s 没退)
    └── 5. SIGKILL                                 ← 终极
```

**为什么 stdin 写入 JSON**：比 SIGTERM 温和——后端可以在 main 关闭时干净地：
- 把当前 turn 块落库
- 关闭 SQLite 句柄
- 关闭 MCP 客户端连接

---

## 进程间的状态共享

| 数据 | 存储位置 | 跨进程访问方式 |
|------|----------|----------------|
| 会话历史 | SQLite（`~/.zero-core/sessions.db`） | 后端独占读写；前端经 HTTP 查 |
| 工具配置 | SQLite kv_store | 同上 |
| LLM Provider 配置 | SQLite | 同上 |
| 模板 / Persona | SQLite | 同上 |
| **运行时 turn 块** | **后端内存（`AgentSession`）** | UI 通过 `getState()` 查询 |
| 任务状态 | `TaskRegistry`（后端内存） | 经 IPC `task-list` 查询 |
| WebSocket 连接 | Backend 内存 | main 转发，Renderer 订阅 |

**核心原则**：**运行时是真相**（"Runtime is the source of truth"）。
- DB 不是 state 仓库，是 **checkpoint 仓库**
- Renderer 不写状态，只订阅事件 + 经 IPC 触发后端 mutate
- 后端在内存里维护 `AgentLoop` 实例池，per-agent 活跃 session 列表

详见 `06-decisions/03-runtime-as-source-of-truth.md`。

---

## CLI 形态：单进程

```typescript
// src/cli.ts
async function main() {
  const sessionDB = new SessionDB();
  runMigrations(sessionDB);
  const registry = new ToolRegistry(sessionDB.getKVStore());
  registerRuntimeTools(registry);
  const agentStore = new AgentStore(sessionDB);
  // ...
  const workspaceConfig = loadWorkspaceConfig(sessionDB);
  const agentService = createAgentService(workspaceConfig.workspaceDir, sessionDB, ...);
  // ...
  const loop = new AgentLoop(sessionConfig, providers, {
    onEvent: (event) => adapter.handleEvent(event),  // 适配到 ANSI 终端
  });
  // readline 主循环
}
```

**特点**：
- **没有 IPC** —— 全部 in-process 调用
- **没有 Renderer** —— `TerminalAdapter` 替代 Renderer 渲染 stream events
- **没有 WebSocket** —— 直接 emit 到 adapter
- 适合脚本化、CI/CD 嵌入、SSH 远程操作

---

## 失败模式

| 失败点 | 行为 | 恢复机制 |
|--------|------|----------|
| 后端启动超时（30s） | `spawnBackend()` reject | 用户看到错误对话框 |
| 后端运行崩溃 | child.on('exit') → `spawnBackend().catch(...)` 自动重启 | 重连 WS，让 UI 重新拉状态 |
| WebSocket 断开 | `setTimeout(connect, 2000)` 重连 | 重新触发 `reconnect` 事件 |
| MCP stdio 进程崩溃 | `try { connect() }` 失败 → 标记 disconnected | 用户可在 UI 重连 |
| better-sqlite3 ABI 不匹配 | 进程退出（uncaughtException） | npm rebuild 后重装 |
| Renderer 崩溃 | 窗口关闭 | 主进程继续运行（用户重开窗口即可） |
| 流式响应中断（abort） | `AbortController` → `S
| 流式响应中断（abort） | `AbortController` → `Stop` hook | UI 显示已收到的部分 |
| 工具执行超时 | 20s/300s 取决于工具 | 部分结果返回，hook 记录超时 |

**关键设计**：**任何单点崩溃都不会污染其他进程的状态**。后端是 SQLite 的唯一持有者；主进程是无状态代理；Renderer 是纯展示。
