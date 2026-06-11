# 三进程拓扑与模块划分

## 进程全景图

```
┌────────────────────────────────────────────────────────────────────┐
│                        用户视角                                    │
│                                                                    │
│  ┌──────────────────┐                  ┌──────────────────┐         │
│  │  Electron Window │                  │  Terminal (CLI)  │         │
│  │  (Renderer)      │                  │  src/cli.ts       │         │
│  └────────┬─────────┘                  └────────┬─────────┘         │
│           │ window.api (typed)                  │ readline            │
└───────────┼──────────────────────────────────────┼──────────────────┘
            │                                      │
            │ IPC                                 │ same-process
            ▼                                      ▼
┌────────────────────────────┐        ┌──────────────────────────────┐
│  Electron MAIN Process      │        │  Zero-Core Backend            │
│  src/main/index.ts         │        │  (Node.js 单一进程)           │
│                            │        │  src/server/index.ts         │
│  ┌──────────────────────┐  │        │                              │
│  │ BrowserWindow        │  │        │  ┌───────────────────────┐   │
│  │ preload/index.ts     │  │        │  │ Express + ws          │   │
│  │ main/ipc/*           │  │        │  │ Stores + Services     │   │
│  │  (47个 IPC 通道)     │  │        │  │ AgentLoop(s)          │   │
│  └──────────┬───────────┘  │        │  └───────────────────────┘   │
│             │              │        │            ▲                  │
│  ┌──────────▼───────────┐  │        └────────────┼──────────────────┘
│  │  IPC → HTTP 代理    │──┼── HTTP/WS ────────┘
│  │  src/main/ipc-proxy  │  │
│  └──────────┬───────────┘  │
│             │ child_process.spawn
│             ▼
│  ┌────────────────────────────┐
│  │  Backend 子进程             │
│  │  (system Node.js 或         │
│  │   Electron fork)            │
│  │  src/backend.ts             │
│  │  → startServer()            │
│  └────────────────────────────┘
│
└────────────────────────────────────────────────────────────────────┘

            ┌─────────────────────┐
            │  SQLite + 文件系统   │
            │  ~/.zero-core/        │
            │  - sessions.db        │
            │  - knowledge.db       │
            │  - logs/              │
            │  - webfetch/          │
            └─────────────────────┘
```

---

## 模块清单（按层）

### Layer 0: 共享契约（被任何层 import 类型）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/shared/` | 跨进程类型契约 | `types.ts`、`ipc-api.ts`、`preload-types.ts` |

### Layer 1: 跨层基础（runtime + server 都依赖）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/core/` | 配置 / 日志 / Hook / Tool 元数据 | `config.ts`、`logger.ts`、`hook-registry.ts`、`tool-registry.ts`、`kv-store-interface.ts` |

### Layer 2: 运行时核心（被 server 实例化）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/runtime/` | AgentLoop + Tool + Hook + Provider | `agent-loop.ts`、`types.ts`、`tools/*`、`hooks/*` |

### Layer 3: 服务层（HTTP API + 状态）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/server/` | Express + 全部 Store + 13 个 Router | `index.ts`、`agent-service.ts`、`session-db.ts`、13 个 `*-router.ts` |

### Layer 4: Electron 主进程（薄壳）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/main/` | 窗口 + 后端 spawn + IPC 代理 | `index.ts`、`backend-spawn.ts`、`ipc-proxy.ts`、`ipc/core.ts` |

### Layer 5: 预加载（contextBridge）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/preload/` | 把 IPC 暴露为 `window.api` | `index.ts`（单文件，218 行） |

### Layer 6: 渲染层（纯展示）

| 目录 | 角色 | 关键文件 |
|------|------|----------|
| `src/renderer/` | React + Zustand + 9 个页面 | `App.tsx`、60+ 组件、9 个 store |

---

## "为什么是三进程" 一图胜千言

```
┌──────────────────────────────────┐
│  Renderer (Chromium + V8)         │   ← 用户直接接触
│  拥有 Node API 受限               │      (Node integration: false)
└──────────────┬───────────────────┘
               │ IPC (handler / invoke)
┌──────────────▼───────────────────┐
│  Main (Node.js + Chromium 控制)   │   ← 沙箱：只能写窗口+少量原生调用
│  持 BrowserWindow / app           │      (不直接做业务)
└──────────────┬───────────────────┘
               │ child_process.spawn / fork
┌──────────────▼───────────────────┐
│  Backend (纯 Node.js)              │   ← 业务：Agent / Store / API
│  持 Express + ws + Stores          │      (能 fork 自 Node 或 Electron)
└──────────────────────────────────┘
```

**为什么不能合并**：
1. **better-sqlite3 ABI 冲突** —— Electron 用的 Node ABI 与系统 Node 不同；混在同一进程 = 段错误
2. **后端独立发布 CLI** —— 同一份 `server/index.ts` 也能在 CLI 形态下独立运行
3. **main 崩溃不污染业务** —— 即使主进程挂掉，CLI 形态的 `zero-core` 仍能继续工作

详见 `06-decisions/01-electron-architecture.md`。

---

## 跨进程通信矩阵

| 通信方向 | 机制 | 用途 | 触发点 |
|----------|------|------|--------|
| Renderer → Main | `ipcRenderer.invoke(channel)` | 调用型（请求-响应） | 47 个 IPC 通道 |
| Renderer → Main | `webContents.send(channel, payload)` | 推送型（事件） | `agent:event` |
| Main → Renderer | `webContents.send(channel, payload)` | 主进程向渲染器推 | window controls 反馈 |
| Main → Backend | `http.request` | 调用型 | 47 个 IPC 通道的代理（http://localhost:port） |
| Main ↔ Backend | `WebSocket /ws` | 双向流（stream events） | AgentService.subscribe → 广播给所有 ws 客户端 |
| Main → Backend | `child_process.stdin` | 控制消息（shutdown） | 后端优雅退出 |
| Main → Backend | `child_process.stdout` | 就绪握手 | `{"type":"ready","port":N}` |
| Renderer → Backend | （间接经 Main） | 无直接路径 | 永远不直接 |

**关键观察**：
- Renderer 与 Backend **永不直接通信**。所有流量都过 Main。
- Main 不持有业务状态。Main 的 IPC 通道是**纯代理**（47/49 走 HTTP，2 个本地处理：dialog 选目录 / webfetch 登录窗口）
- Backend 的 WebSocket 才是**真正的流式通道**。HTTP 用于请求-响应，WS 用于增量事件

---

## 目录树（去除 node_modules）

```
zero-core/
├── package.json              # 24 运行时 + 19 dev 依赖
├── tsconfig.json             # project references
├── tsconfig.cli.json         # lib 模式（CLI 用）
├── tsconfig.node.json        # main / preload
├── tsconfig.web.json         # renderer
├── electron.vite.config.ts   # main/preload/renderer 三入口
├── vite.config.ts            # renderer 独立 dev server
├── electron-builder.yml      # NSIS/Portable/DMG/AppImage
├── playwright.config.ts      # E2E
├── vitest.config.ts          # 单元（暂未广泛使用）
│
├── src/
│   ├── index.ts              # Lib public API
│   ├── backend.ts            # 后端 spawn 入口
│   ├── serve.ts              # `zero-core serve` 子命令
│   ├── cli.ts                # CLI 入口
│   │
│   ├── core/                 # ── 跨层基础设施
│   ├── runtime/              # ── AgentLoop 核心
│   ├── server/               # ── HTTP/WS + Stores
│   ├── main/                 # ── Electron 主进程
│   ├── preload/              # ── contextBridge
│   ├── renderer/             # ── React UI
│   └── shared/               # ── 类型契约
│
├── scripts/                  # check-handler-modules, build-codegraph
├── tests/                    # fixtures/（mock provider）
├── build/                    # electron-builder 资源
├── resources/                # 图标等
├── docs/                     # 历史 docs
└── openprd/                  # OpenPRD 业务规范（项目自带的元规范）
```
