# 项目技术栈

## 工具链

zero-core 的开发与构建工具链围绕 Electron + TypeScript + Vite 构建，关键工具如下：

| 工具 | 用途 | 备注 |
|------|------|------|
| `electron-vite` | Electron 主/preload/renderer 三入口构建与 dev server | `npm run dev` / `npm run build` 走它；基于 Vite 6 |
| `tsc`（TypeScript 5.7） | 类型检查 + 构建 CLI 库产物 | `npm run build:lib` 跑 `tsc -p tsconfig.cli.json`；`electron-vite build` **不做**类型检查，提交前必须额外跑 `build:lib` 才能发现类型错误 |
| `electron-builder` | 打包桌面安装包（Windows / macOS） | `npm run build:win` / `build:mac`；配置在 `electron-builder.yml` |
| `node-gyp`（better-sqlite3 原生模块） | 针对当前 Electron 版本编译原生模块 | better-sqlite3 **必须**用 node-gyp 针对 Electron 41.6.0 重新编译，`electron-rebuild` 可能不生效；详见 memory `feedback-native-module-rebuild` |
| `tsx` | 直接运行 TypeScript 脚本（不走编译） | 用于 `scripts/build-codegraph.ts`（重建 code-graph 可视化数据）、`scripts/test-tool-output.ts` 等 |
| `vitest` | 单元测试 | `npm run test:unit`；配置在 `vitest.config.ts` |
| `playwright` | E2E 测试（驱动 Electron） | `npm run test:e2e`；通过 `ZERO_CORE_TEST_FIXTURE` 环境变量进入 mock provider 测试模式；配置在 `playwright.config.ts` |
| `electron-rebuild` | 尝试重编译原生模块 | 作为 fallback，better-sqlite3 实战首选 node-gyp |

### 工程常规门禁（替代旧 OpenPrd 流程）

> 历史上本仓库由 OpenPrd harness 管理，通过 `openprd run/dev-check/standards/quality/doctor` 等
> 命令强制开发流程；**当前已停用 OpenPrd 流程**，改用工程常规命令。下表是日常开发真正要跑的
> 门禁（命令名见 `package.json` 的 `scripts`），取代旧版"openprd 触发时机"那张表：

| 命令 | 用途 | 触发时机 |
|------|------|---------|
| `npm run typecheck` | 三套 tsconfig（cli / web / node）全量类型检查 | 提交前必跑（`electron-vite build` 内部已含） |
| `npm run build:lib` | `tsc -p tsconfig.cli.json` 单独跑一遍，**捕捉** `electron-vite build` **不做的类型检查** | 提交前必跑（章程级硬约束：`electron-vite build` 不验证类型，详见 memory `feedback-build-verification`） |
| `npm run test:unit` | vitest 单元测试 | 改完运行时/store/router 后 |
| `npm run test:e2e` | Playwright E2E（含 `npm run build`，跑构建产物） | 改完 IPC / 渲染 / 集成路径后 |
| `npm run build:codegraph` | 重建 `docs/visualization/code-graph-data.json` + `code-graph.html` | 改了 `src/` 模块树（增删文件、改 import 边）后 |
| `npm run check:handlers` | 检查处理器模块依赖一致性 | 改了 main↔server handler 接线后 |

> 注：旧 OpenPrd 表里的 `standards:verify` / `quality:verify` / `run:verify` 没有对应的
> npm 脚本，那套门禁已下线。文档标准靠人审 + `docs/` 一致性自检；质量门禁靠
> `typecheck` + `build:lib` + `test:unit` + `test:e2e`。

### 构建产物布局

- `out/` — `electron-vite build` 产物（`out/main`、`out/preload`、`out/renderer`），桌面模式入口 `main` 指向 `out/main/index.cjs`。
- `dist/` — `tsc -p tsconfig.cli.json` 产物（CLI 库 + 服务层），`bin.zero-core` 指向 `dist/cli.js`，`exports` 指向 `dist/index.js`。
- `release/` — `electron-builder` 打包的安装包。
- `build/` — electron-builder 资源中间产物。

## 运行环境

- **语言**：TypeScript
- **运行时**：Node.js >= 20.6.0
- **平台**：Windows、macOS、Linux（Electron 跨平台）
- **构建工具**：electron-vite（Vite）
- **包管理器**：npm

## 核心依赖

**框架和 UI**：
- `electron` — 桌面框架
- `react@^19.2.6` — React 19
- `react-dom` — React DOM
- `zustand@^5.0.13` — 状态管理
- `react-markdown` + `remark-gfm` + `rehype-raw` — Markdown 渲染
- `shiki` — 语法高亮

**AI 集成**：
- `ai@^6.0.180` — Vercel AI SDK（streamText, tool）
- `@ai-sdk/anthropic@^3.0.77` — Anthropic
- `@ai-sdk/openai@^3.0.63` — OpenAI
- `@ai-sdk/google@^3.0.73` — Google
- `@modelcontextprotocol/sdk@^1.29.0` — MCP SDK

**数据存储**：
- `better-sqlite3@^12.10.0` — SQLite（需 node-gyp 针对 Electron 版本编译）

**工具和实用**：
- `zod@^4.4.3` — 数据验证
- `typebox` — JSON Schema 验证
- `jsdom` — DOM 模拟（WebFetch HTML 处理）
- `turndown` — HTML 转 Markdown
- `pdf-parse` — PDF 解析
- `uuid@^14.0.0` — ID 生成
- `undici@^8.3.0` — HTTP 客户端

**测试**：
- `vitest` — 单元测试
- `playwright` — E2E 测试

## 构建命令

> 全部来自 `package.json` 的 `scripts`，与上文"工程常规门禁"是同一份事实。

| 命令 | 实际执行 | 用途 |
|------|---------|------|
| `npm run dev` | `node scripts/dev.js` | 开发模式（拉起 electron-vite dev server + 主进程） |
| `npm run typecheck` | `tsc -p tsconfig.cli.json && tsc -p tsconfig.web.json && tsc -p tsconfig.node.json` | 三套 tsconfig 全量类型检查（不产 out/） |
| `npm run build` | `npm run typecheck && electron-vite build` | 类型检查 + 桌面三入口构建（**不是** lib + electron-vite；lib 产物由 `build:lib` 单独产） |
| `npm run build:lib` | `tsc -p tsconfig.cli.json` | CLI 库 + 服务层 `dist/` 产物（`bin.zero-core` 指向 `dist/cli.js`） |
| `npm run build:win` | `npm run build && electron-builder --win` | 类型检查 + 构建 + Windows 安装包 |
| `npm run build:mac` | `npm run build && electron-builder --mac` | 同上，macOS |
| `npm run preview` | `electron-vite preview` | 预览 `out/` 构建产物 |
| `npm run test:unit` | `vitest run` | 单元测试（一次性） |
| `npm run test:unit:watch` | `vitest` | 单元测试 watch 模式 |
| `npm run test:e2e` | `npm run build && playwright test` | 先 build 再跑 Playwright E2E（驱动构建产物，不是 dev server） |
| `npm run build:codegraph` | `tsx scripts/build-codegraph.ts` | 重建 `docs/visualization/code-graph-data.json` + `code-graph.html`（27k 行级别，改 src/ 模块树后跑） |

> 注：旧表里的 `npm run serve`（HTTP/WS 服务器模式）与 `npm run check:handlers`（检查处理器模块依赖）
> 当前 `package.json` 的 `scripts` **都没有定义** —— 远程 server 模式入口是 `src/server/index.ts` 的
> `startServer()`，需要直接 `tsx src/server` 或自行加 script；handler 一致性检查的源文件
> `scripts/check-handler-modules.ts` 也不存在（`scripts/` 实际只有 5 个文件：
> `build-codegraph.ts` / `check-turns.cjs` / `dev.js` / `itest-step-storage.cjs` / `test-tool-output.ts`）。
> 本表已删去这两条过时项。

## 维护规则

- 每次新增、移除或升级核心依赖后，必须检查并更新本文件
