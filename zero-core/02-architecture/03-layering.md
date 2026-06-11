# 分层与依赖方向

> 从实际 `import` 语句倒推出来的依赖图，不是从规范推出来的。

---

## 一、依赖图（按层）

```
                    ┌─────────────────┐
                    │    shared/       │   ← 类型契约层
                    │  (types only)    │      不依赖任何业务代码
                    └────────▲────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        │                    │                    │
┌───────┴──────┐    ┌────────┴───────┐    ┌───────┴──────┐
│   core/      │    │   shared/      │    │   preload/  │
│ (config,log, │    │ (file-utils,    │    │ (类型 only)  │
│  hook-reg,   │    │  github-tmpl)   │    └──────▲───────┘
│  tool-reg)   │    │                 │           │
└──────▲───────┘    └────────▲────────┘           │
       │                     │                    │
       │                     │                    │
       │            ┌────────┴────────┐           │
       │            │                 │           │
       │            │                 │           │
┌──────┴───────────────────────┐  ┌─────┴────────────────┐
│           runtime/             │  │     renderer/        │
│ (AgentLoop, tools, hooks,      │  │  (React + Zustand)   │
│  provider-factory, types)      │  │                       │
└──────────▲─────────▲────────────┘  └───────────▲───────────┘
           │         │                            │ window.api
           │         │                            │ (typed)
           │         │                            │
           │    ┌────┴────────────────┐   ┌────────┴────────┐
           │    │      server/        │   │      main/      │
           │    │ (HTTP/WS + Stores   │   │  (Electron 主)  │
           └────┤  + Routers)        │   │  (IPC 代理)     │
                │                    │   └─────────▲───────┘
                │                    │             │ child_process
                │                    └─────────────┘
                │
                └─────── 后端进程内 ────────────── spawn ──→  backend 子进程
```

**实线**：编译期 import 关系
**虚线**：运行时跨进程通信

---

## 二、逐层规则

### shared/ —— 类型契约层

- **只导出类型**（`export type` 或 `export interface`），不导出实现
- 零运行时副作用（没有 `console.log`、没有模块级 state）
- 唯一的运行时导出是 `buildTree` 等纯函数工具
- 三层都能依赖它（main、preload、renderer 都 import 它的类型）

### core/ —— 跨层基础

**职责**：
- `config.ts`：TypeBox schema + 加载（global / project / runtime override 三层合并）
- `logger.ts`：分级日志 + console + file 双 sink（按日轮转）
- `hook-registry.ts`：29 个事件点的注册中心
- `tool-registry.ts`：工具元数据 + 配置 KV 持久化
- `kv-store-interface.ts`：让 core 不依赖 server 的实现
- `persona.ts` / `default-prompt.ts`：模板与角色定义

**依赖规则**：
- ✅ 依赖 shared/ 的类型
- ❌ 严禁依赖 runtime/ 或 server/
- ❌ 严禁依赖 node 原生 fs（除 logger / device-context 之外）

**观察到的违规**：`core/device-context.ts` 直接 `import` `node:os`、`node:child_process`。这是合理的"读取硬件信息"职责，但应该被标注——它把 core 的一部分绑死到 node。

### runtime/ —— Agent 核心

**职责**：
- `agent-loop.ts`：流式执行循环
- `types.ts`：28 个事件 + 10 个配置类型（**整个应用的契约核心**）
- `tools/`：16 个内置工具 + 工具工厂
- `hooks/`：4 个 hook 注册器（turn / compression / memory / RAG）
- `provider-factory.ts`：LLM provider 工厂 + 并发限流
- `session.ts` / `subagent-delegator.ts`：会话和子 agent

**依赖规则**：
- ✅ 依赖 core/、shared/
- ✅ 依赖 node 原生（fs、child_process、crypto）
- ❌ 严禁依赖 server/
- ❌ 严禁依赖 main/ 或 preload/ 或 renderer/

**关键设计**：`runtime/agent-loop.ts` 通过 `ISessionStore` 接口（位于 `runtime/session-store-interface.ts`）消费 DB，**实现位于 server/ 的 `session-db.ts`**。这让 runtime 可以独立测试（mock 一个 ISessionStore 即可）。

### server/ —— 状态层

**职责**：
- `index.ts`：Express + ws 启动
- `agent-service.ts`：Agent 注册表 + 子 agent 委派
- `session-db.ts`：主 SQLite 实例
- 13 个 `*-store.ts`：通用 `SqliteStore<T>` 泛型的具体化
- 13 个 `*-router.ts`：Express 路由
- `*hooks.ts`：3 个 hook 注册器（durable / tool-execution / recovery）

**依赖规则**：
- ✅ 依赖 core/、runtime/、shared/
- ✅ 依赖所有存储相关（better-sqlite3、pdf-parse、turndown、jsdom）
- ❌ 严禁依赖 main/、preload/、renderer/

**观察到的反直觉**：`server/agent-service.ts` 直接 `import { AgentLoop }` from `runtime/`。这是**故意**的—— AgentLoop 必须被后端实例化；它不能跑到 main 进程去运行（那里只做 IPC 代理）。

### main/ —— Electron 主进程

**职责**：
- 窗口管理（BrowserWindow）
- 后端 spawn / shutdown
- IPC 代理（47 通道）
- WS 事件桥
- 2 个本地处理（dialog / webfetch 登录窗口）

**依赖规则**：
- ✅ 依赖 shared/（类型）
- ✅ 依赖 preload/（类型）
- ⚠️ 唯一一处**违反隔离**：`main/index.ts#registerLocalHandlers` 里 `importCookies` from `runtime/mcp-tools/cookie-jar.js` —— 这是 webfetch:login 在 IPC handler 中需要的
- ❌ 不应该依赖 server/ 的 store 类

**建议**：把 cookie-jar 从 `runtime/mcp-tools/` 移到 `shared/`，因为它实际是文件系统工具，没有 runtime 依赖。

### preload/ —— contextBridge

**单文件，218 行**。唯一导出 `ExposedAPI`，对应 `shared/preload-types.ts` 中的 `WindowApi`。

**规则**：
- 只能 import electron 和 shared/ 的类型
- 不能引用 server/ 或 runtime/（跨进程边界）

### renderer/ —— React UI

**职责**：
- 60+ React 组件
- 9 个 Zustand store
- Markdown / CodeBlock / LogViewer / 各种 Modal

**依赖规则**：
- ✅ 依赖 shared/（类型）
- ✅ 通过 `window.api` 间接依赖 IPC（即经 main/ 再到 server/）
- ❌ 严禁直接 import server/ 或 runtime/ 的代码

**关键观察**：`renderer/store/chat-store.ts` 注释说 "the runtime is the single source of truth"。状态层**只缓存** 后端推送的事件，不做**派生状态**之外的事。

---

## 三、依赖方向图（深入）

### server → runtime（强、故意）

```
server/agent-service.ts:
  import { AgentLoop } from "../runtime/agent-loop.js"
  import { buildAgentTools } from "../runtime/tools/agent-tool.js"
  import { buildMcpTools } from "../runtime/tools/mcp-tool.js"
  import { ConcurrencyQueue } from "../runtime/concurrency-queue.js"
```

**为什么 runtime 不能跑到 server 之上**：因为 runtime 的 `AgentLoop` 必须被实例化才能用，而只有 server 进程有 `SessionDB` 实例。

### server → main（禁止，通过 spawn 隔离）

不存在 import 关系。它们通过 `http://localhost:port` 和 `ws://localhost:port/ws` 通信。

### runtime → server（禁止，通过接口隔离）

runtime 不 import server 的实现类。它**只 import 接口**：
- `runtime/session-store-interface.ts`（实现位于 `server/session-db.ts`）
- `runtime/types.ts` 中不出现 server 的类型

### main → server（禁止，直接 import 都没有）

```typescript
// src/main/ipc/core.ts
const _distServer = join(__dirname, "../../dist/server");
// ... 但仅用 import(toFileURL(...)) 动态加载
```

main 通过**运行时动态 import** 加载 dist 后的 server/ 产物。这是个有趣的 trick —— main 包大小不直接包含 server 代码，但能 import 它的导出。

但**关键限制**：`loadCoreModules` 实际能调用的 server 导出必须能跨过 Electron ↔ Node ABI 边界。详见 `06-decisions/01-electron-architecture.md`。

### core → runtime（禁止）

`core/` 不 import `runtime/`。但 `core/test-seed.ts` 是个例外——它 import 的是 `server/session-db.ts` 等纯数据结构（这意味着 test-seed 应该归到 server/）。

### shared → 其他（禁止）

shared 是叶子层。不被任何"业务"层依赖——它**被依赖**。

---

## 四、违反规则的成本分析

| 违反 | 例子 | 后果 |
|------|------|------|
| core → runtime | 假设有 | runtime 改了，core 也得改；core 本应最稳定 |
| runtime → server 实现 | 假设有 | runtime 不可独立测试 |
| server → renderer | 假设有 | server 必须有 DOM 相关 |
| main → server（静态） | 当前是动态 import | OK，因为 dist 产物隔离 |
| renderer → server 直接 | 假设有 | 跨进程隔离失效 |

**结论**：当前分层整体**健康**。需要警惕的只有一个点：`core/test-seed.ts` 越界到了 server/ 的 store，但影响有限（test-seed 永远不在生产路径执行）。
