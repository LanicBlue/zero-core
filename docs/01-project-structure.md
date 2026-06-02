# 01 · 项目结构与构建

## 顶层目录

```
zero-core/
├── src/                  # 生产源码（198 文件 / 29 子目录）
├── tests/e2e/            # Playwright E2E（仅 2 个 spec）
├── scripts/dev.js        # dev 启动脚本
├── docs/                 # 本文档
├── dist/                 # tsc 输出（库形式，给 npm 发布用）
├── out/                  # electron-vite 输出（main/preload/renderer）
├── release/              # electron-builder 打包产物（NSIS / portable）
├── build/                # 空目录（占位）
├── resources/            # 空目录（占位）
├── env-dump.txt          # 调试残留，应删除
├── package.json
├── tsconfig.json         # 根 references（不参与编译）
├── tsconfig.cli.json     # 库构建（Node16/ES2022 → dist/）
├── tsconfig.node.json    # 主进程 + preload（ESNext，noEmit）
├── tsconfig.web.json     # renderer（ESNext + React，noEmit）
├── vite.config.ts        # 库的 vite 配置（与 electron-vite 并存）
├── electron.vite.config.ts
├── electron-builder.yml
└── playwright.config.ts
```

## src/ 子目录

| 目录 | 文件数 | 角色 | 关键入口 |
|------|--------|------|----------|
| `src/core/` | 18 | 配置、context、tool policy、prompt | `config.ts`, `context-manager.ts`, `default-prompt.ts` |
| `src/main/` | 20 | Electron 主进程 | `index.ts` |
| `src/main/ipc/` | 12 | IPC handlers | `ipc.ts`, `core.ts`, `typed-ipc.ts` |
| `src/preload/` | 1 | Electron preload | `index.ts`（156 个 IPC 桥） |
| `src/renderer/` | 41 | React UI | `App.tsx` → `AppLayout.tsx` |
| `src/renderer/store/` | 10 | Zustand stores | `chat-store.ts`, `agent-store.ts` 等 |
| `src/runtime/` | 74 | Agent runtime | `agent-loop.ts`, `provider-factory.ts`, `tools/` |
| `src/runtime/tools/` | 多 | 工具实现 | `bash.ts`, `file-read.ts`, ... |
| `src/runtime/mcp-tools/` | 多 | 内置 MCP 风格工具 | `fetch`, `memory`, `sequential-thinking` |
| `src/server/` | 36 | 服务层（持久化、session、recovery） | `agent-service.ts`, `session-db.ts`, `mcp-manager.ts` |
| `src/server/mcp-servers/` | 多 | 内置 MCP 服务器实现 | |
| `src/shared/` | 5 | 跨进程共享类型 | `types.ts`, `ipc-api.ts` |

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
- **Preload**：contextIsolation 桥，显式暴露 156 个 IPC 调用
- **Renderer**React 19 + Vite，ESM 输出

## 构建管线

### 两套构建并存

```
npm run build
  ├─ build:lib   → tsc -p tsconfig.cli.json → dist/   (npm 库)
  └─ electron-vite build                          (Electron app)
       ├─ main      → out/main/index.cjs
       ├─ preload   → out/preload/index.cjs
       └─ renderer  → out/renderer/index.html + assets/
```

**问题**：库构建（`dist/`）和应用构建（`out/`）产出于不同路径，但都从 `src/` 编译。修改源码后必须两个都重 build 才同步。`dist/` 的存在主要是为了 npm 发布（`package.json` 里有 `main: ./dist/index.js`），但目前看实际 npm 使用场景不明确。

### 打包

```
electron-builder → release/
  ├─ NSIS installer
  └─ portable exe
```

`electron-builder.yml` 配置基于 `out/` 和 `dist/` 共同打包。

### 测试

```
npm run test:e2e
  ├─ npm run build        (依赖 out/ 产物)
  └─ playwright test      (tests/e2e/*.spec.ts)
```

## TypeScript 配置矩阵

| 配置 | 模块系统 | 目标 | 用途 | emit |
|------|----------|------|------|------|
| `tsconfig.json` | - | - | 项目引用聚合 | 否 |
| `tsconfig.cli.json` | Node16 | ES2022 | 库构建 | → `dist/` |
| `tsconfig.node.json` | ESNext/Bundle | - | 主进程类型检查 | 否（electron-vite emit） |
| `tsconfig.web.json` | ESNext/Bundle | - | renderer 类型检查 | 否（electron-vite emit） |

**陷阱**：三套配置意味着 `npm run build` 不一定能捕获所有类型错误。建议在 CI 中跑 `tsc --noEmit -p tsconfig.node.json` 和 `tsc --noEmit -p tsconfig.web.json`。

## 依赖关键项

### 生产
- **Electron 41.6.0**
- **React 19.2.6**
- **`@ai-sdk/*`**：openai、anthropic、google（gemini）
- **`@modelcontextprotocol/sdk`**
- **`better-sqlite3`**（必须用 node-gyp 针对 Electron 编译，[见相关 memory](../C:/Users/Administrator/.claude/projects/c--Users-Administrator-Documents-workspace-agent-zero-core/memory/feedback-native-module-rebuild.md)）
- **`zustand`**
- **`uuid`**

### 开发
- **`@playwright/test`**
- **`electron-vite`**、**`electron-builder`**
- **`vite`**（同时给库和 renderer 用）

## 应清理的杂项

| 路径 | 问题 |
|------|------|
| `env-dump.txt` | 上一轮调试残留 |
| `src/renderer/components/workspace/` | 空目录 |
| `build/` | 空目录 |
| `resources/` | 空目录 |
| `dist/` 与 npm 发布 | 如果不实际发布 npm 包，可以删掉 `build:lib` 步骤 |
