# 代码规模与模块体量

> 实际统计自 `src/`。用于评估代码体积、复杂度和维护成本。

---

## 一、整体规模

| 指标 | 数值 |
|------|------|
| TS/TSX 源文件总数 | ~210 |
| 源码行数（含注释、空行） | ~30,000+ |
| `src/` 子目录 | 6（core / runtime / server / main / preload / renderer）+ shared |
| npm 运行时依赖 | 24 |
| npm 开发依赖 | 19 |

---

## 二、按目录切分

```
src/
├── core/      15 文件   ~2,400 行  ─ 跨层通用：配置、logger、hook、tool-registry
├── runtime/   33 文件   ~6,000 行  ─ AgentLoop 核心 + tools + hooks
├── server/    45 文件  ~11,000 行  ─ 状态层：Stores + Routers + DB + KB/MCP
├── main/      21 文件   ~2,200 行  ─ Electron 主进程：IPC 代理 + 后端 spawn
├── preload/    1 文件     218 行  ─ contextBridge 单一文件
├── renderer/  60+ 文件  ~9,000 行  ─ React UI + 9 个 Zustand store
├── shared/     5 文件   ~1,200 行  ─ 类型契约：IpcChannelDefs、preload-types
```

**注意**：server/ 占了 36% 代码量，因为它承担了 13 个数据表的所有 CRUD + 13 个 REST 路由。

---

## 三、最大文件 Top 15（行数近似）

| 文件 | 行数 | 模块 | 角色 |
|------|------|------|------|
| `server/template-store.ts` | ~846 | server | 内置 9 个 prompt 模板 + 模板 CRUD |
| `server/session-db.ts` | ~633 | server | 主 DB：sessions/messages/turns/tool_executions/turn_state |
| `runtime/agent-loop.ts` | ~560 | runtime | **核心**：流式执行 + 重试 + 增量 checkpoint |
| `server/agent-service.ts` | ~635 | server | **核心**：Agent 注册表 + 并发 + 子 agent 委派 |
| `server/sqlite-store.ts` | ~297 | server | 通用 CRUD 泛型（核心基础设施） |
| `main/ipc/core.ts` | ~352 | main | 后端子进程 IPC 协调（启动 phase 编排） |
| `main/ipc-proxy.ts` | ~262 | main | IPC → HTTP 路由映射 |
| `server/agent-store.ts` | ~114 | server | Agent 配置 CRUD（薄壳，复杂性在模板） |
| `runtime/subagent-delegation.ts` | ~326 | runtime | 子 agent 委派 API factory |
| `main/index.ts` | ~222 | main | Electron 入口：spawn backend / IPC / 窗口 |
| `core/agent-utils.ts` | ~107 | core | 错误分类 + thinking tag 解析 |
| `runtime/agent-loop.ts` | ~560 | runtime | （重复列出） |
| `runtime/types.ts` | ~351 | runtime | **28 个事件类型 + 10 个配置类型**（契约核心） |
| `shared/types.ts` | ~374 | shared | 跨进程数据模型 + 输入类型 |
| `core/tool-registry.ts` | ~212 | core | 工具元数据 + 工具配置 KV 持久化 |

**信号**：
- `template-store.ts` 之所以大，是因为内置了 **9 个高完整度 prompt 模板**（Coder / Reviewer / Writer / Translator / Analyst / Tutor / Creative / Researcher / Collector），每个 ~70 行
- `session-db.ts` 大是 5 个表 schema + turn_state 状态机 + tool_executions 审计 + message/turn 双轨设计累积的合理结果

---

## 四、模块边界强度

| 边界 | 类型 | 强度 |
|------|------|------|
| `core/ ↔ runtime/` | 同进程内 import | 强（runtime 高度依赖 core） |
| `runtime/ ↔ server/` | 反向：server 依赖 runtime | 强（`agent-service.ts` 直接 `import { AgentLoop }`） |
| `server/ ↔ shared/` | 类型 only | 弱（纯 type import） |
| `main/ ↔ server/` | 通过 HTTP/WS | 强隔离（这是设计的核心） |
| `main/ ↔ runtime/` | **运行时** spawn backend 进程 | 中（main 在 webfetch:login 中 import 了一处 cookie-jar） |
| `renderer/ ↔ main/` | IPC 契约 | 强隔离（preload-types.ts 单一来源） |
| `renderer/ ↔ server/` | 永不直接 import | 完美隔离（始终经 IPC 跳板） |

**关键观察**：
- server/ 依赖 runtime/ 是**反直觉的**：因为 AgentLoop 必须在后端进程实例化
- main/ 唯一直接 import 了 `runtime/mcp-tools/cookie-jar.js` —— 是 webfetch:login 在 IPC handler 中需要它
- 跨进程边界只通过：`HTTP POST` (Express) + `WebSocket` (ws) + `IPC.handle` (Electron) 三种

---

## 五、循环依赖分析

`session-db.ts` 持有 `MemoryStore / MemoryNodeStore / KeyValueStore` 的实例，让 Store 类在**回调中再注入**（如 `recordToolExecution({ sessionId, agentId, ... })`），这巧妙避免了 store ↔ hook 之间的循环依赖。

观察到的潜在循环点（在 `core.ts#loadCoreModules` 中通过**显式分阶段**（Phase 0-6）解决）：
- ToolRegistry ↔ MCPManager
- AgentService ↔ SessionManager
- IPC handlers ↔ runtime services

→ 详见 `02-architecture/05-bootstrap.md`

---

## 六、测试覆盖现状

| 类型 | 状态 | 位置 |
|------|------|------|
| 单元测试 | **几乎为零** | `tests/` 目录除 fixture 外无实质内容 |
| 集成测试 | 仅 1 个 fixture 文件 | `tests/fixtures/`（mock provider 用） |
| E2E | 有 Playwright 配置 | `playwright.config.ts`；fixture 路径通过 `ZERO_CORE_TEST_FIXTURE` 注入 |

**核心机制**：`core/test-seed.ts#seedTestEnvironment()` —— 在测试模式下，env 变量指定 fixture JSON 文件，自动创建 mock provider + agent + workspace config，让 E2E 可以完全脱离真实 LLM。

→ 详见 `07-evolution/04-testing-strategy.md`

---

## 七、构建产物

| 命令 | 产物 |
|------|------|
| `npm run build:lib` | `dist/` —— lib 模式产物（CLI 用） |
| `npm run build` | `out/main/index.cjs` + `dist/`（完整打包） |
| `npm run build:win` | `release/Zero-Core-0.1.0-x64-setup.exe` + portable |
| `npm run build:mac` | `release/Zero-Core-0.1.0-x64.dmg` |
| `npm run build:linux` | `release/Zero-Core-0.1.0-x64.AppImage` |

**关键**：`build:lib` 走 `tsconfig.cli.json`（Node16 模块），`build` 走 electron-vite（CJS + 三入口）。
