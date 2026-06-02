# 01 · 项目结构与构建

> 最近重写：2026-06（清理过期数据 + 反映拆分后的目录布局）

## 顶层目录

```
zero-core/
├── src/                  # 生产源码（212 文件 / 29 子目录 / ~24.5k 行）
├── tests/
│   ├── e2e/              # Playwright Electron E2E（2 个 spec + helper）
│   └── unit/             # vitest 单测（5 个 test 文件 / 85 测试）
├── scripts/
│   ├── dev.js            # dev 启动脚本
│   └── check-handler-modules.ts  # IPC handler modules 数组 AST 校验
├── docs/                 # 本文档
├── dist/                 # tsc 输出（库形式，给 npm 发布用）
├── out/                  # electron-vite 输出（main/preload/renderer）
├── release/              # electron-builder 打包产物（NSIS / portable）
├── package.json          # type: module，bin: zero-core → dist/cli.js
├── tsconfig.json         # 根 references（不参与编译）
├── tsconfig.cli.json     # 库构建（Node16/ES2022 → dist/）
├── tsconfig.node.json    # 主进程 + preload（ESNext，noEmit）
├── tsconfig.web.json     # renderer（ESNext + React，noEmit）
├── vite.config.ts        # 库的 vite 配置（保留，给 dist/ npm 发布路径）
├── electron.vite.config.ts
├── electron-builder.yml
├── playwright.config.ts
└── vitest.config.ts
```

**已删的杂项**（2026-06）：`env-dump.txt`（调试残留）、`openclaw.plugin.json`（不再走 Pi Agent 插件方向）。`test-results/`、`.env` 已加入 `.gitignore`。

## src/ 子目录

| 目录 | 文件数 | 角色 | 关键入口 |
|------|--------|------|----------|
| `src/core/` | 19 | 配置、context、tool policy、prompt、constants | `config.ts`, `constants.ts`, `default-prompt.ts`, `tool-registry.ts` |
| `src/main/` | 23 | Electron 主进程 | `index.ts`, `test-setup.ts` |
| `src/main/ipc/` | 20 | IPC handlers + reactive ctx + module readiness | `ipc.ts`, `core.ts`, `typed-ipc.ts`, `types.ts` |
| `src/preload/` | 1 | Electron preload | `index.ts`（85 个 IPC 桥接方法） |
| `src/renderer/` | 51 | React UI（含 store 10、components 8 子目录） | `App.tsx` → `AppLayout.tsx` |
| `src/renderer/store/` | 10 | Zustand stores | `chat-store.ts`（单源）等 |
| `src/runtime/` | 40 | Agent runtime | `agent-loop.ts` (784 行), `provider-factory.ts`, `subagent-delegation.ts` |
| `src/runtime/tools/` | 21 | 工具实现 | `bash.ts`, `file-read.ts`, `web-search.ts`, `todo-write.ts`, `agent-tool.ts` 等 |
| `src/runtime/mcp-tools/` | 4 | 内置 MCP 风格工具 | `fetch`, `memory`, `sequential-thinking` |
| `src/server/` | 36 | 服务层（持久化、session、recovery、API routers） | `agent-service.ts`, `session-db.ts`, `mcp-manager.ts`, `recovery.ts` |
| `src/server/mcp-servers/` | 1 | 内置 MCP 服务器实现 | |
| `src/shared/` | 5 | 跨进程共享类型 | `types.ts`, `ipc-api.ts`, `file-utils.ts` |

## 进程模型

```
┌─────────────────┐   ┌─────────────────┐
│  Main (CJS)     │   │  Renderer (ESM) │
│  out/main/      │◄──►│  out/renderer/  │
│  index.cjs      │   │  index.html     │
└────────┬────────┘   └────────┬────────┘
         │ IPC (preload bridge)│
         ▼                     ▼
┌─────────────────┐   ┌─────────────────┐
│  Preload (CJS)  │   │  React 19       │
│  out/preload/   │   │  Zustand stores │
│  index.cjs      │   │                 │
└─────────────────┘   └─────────────────┘
```

- **Main**：Node.js + Electron，CJS 输出，加载所有 server / runtime 模块
- **Preload**：contextIsolation 桥，显式暴露 85 个 IPC 调用 + 4 个事件订阅（`onAgentEvent`、`onSessionLifecycle`、`onAppReady`、`onToolsChanged`）
- **Renderer**：React 19 + Vite，ESM 输出

## 构建管线

### 双构建并存（保留，供 npm 发布路径）

```
npm run build
  ├─ build:lib   → tsc -p tsconfig.cli.json → dist/   (npm 库)
  └─ electron-vite build                          (Electron app)
       ├─ main      → out/main/index.cjs
       ├─ preload   → out/preload/index.cjs
       └─ renderer  → out/renderer/index.html + assets/
```

`dist/` 用于 npm 发布（`package.json` 里 `main: ./out/main/index.cjs`、`bin: ./dist/cli.js`、`exports: ./dist/index.js`）。CLI 模式（`zero-core` 命令）和 HTTP server 模式都依赖 `dist/`，所以 build:lib 不能删。

### 打包

```
electron-builder → release/
  ├─ NSIS installer
  └─ portable exe
```

`electron-builder.yml` 配置基于 `out/` 和 `dist/` 共同打包。

### 测试

```
npm run test:unit    # vitest run — 5 个 test 文件 / 85 测试
npm run test:e2e     # npm run build + playwright test
npm run check:handlers  # AST 校验 IPC handler 的 modules 数组
```

## TypeScript 配置矩阵

| 配置 | 模块系统 | 目标 | 用途 | emit |
|------|----------|------|------|------|
| `tsconfig.json` | - | - | 项目引用聚合 | 否 |
| `tsconfig.cli.json` | Node16 | ES2022 | 库构建 | → `dist/` |
| `tsconfig.node.json` | ESNext/Bundle | - | 主进程类型检查 | 否（electron-vite emit） |
| `tsconfig.web.json` | ESNext/Bundle | - | renderer 类型检查 | 否（electron-vite emit） |

**注意**：根目录跑 `tsc --noEmit -p tsconfig.json` 能覆盖整个项目类型检查。CI 推荐 `npm run build:lib` + `tsc --noEmit -p tsconfig.json`。

## 依赖关键项

### 生产
- **Electron 41.6.0**
- **React 19.2.6**
- **`@ai-sdk/*`**：openai、anthropic、google（gemini）
- **`@modelcontextprotocol/sdk`**
- **`better-sqlite3`** 12.10 — 必须用 node-gyp 针对 Electron 编译，[见相关 memory](../C:/Users/Administrator/.claude/projects/c--Users-Administrator-Documents-workspace-agent-zero-core/memory/feedback-native-module-rebuild.md)
- **`zustand`** 5.0
- **`zod`** 4.4
- **`uuid`** 14.0

### 开发
- **`@playwright/test`** — E2E
- **`vitest`** 4.1 — 单测
- **`tsx`** — 跑 scripts/check-handler-modules.ts
- **`electron-vite`**、**`electron-builder`**
- **`vite`**（库构建用）

## 仍可清理的（非阻塞）

| 路径 | 状态 |
|------|------|
| `src/renderer/components/workspace/` | 空目录，git 不追踪，磁盘无害 |
| `build/`、`resources/` | 空目录，同上 |
