# 项目技术栈

## 工具链

zero-core 的开发与构建工具链围绕 Electron + TypeScript + Vite 构建，关键工具如下：

| 工具 | 用途 | 备注 |
|------|------|------|
| `electron-vite` | Electron 主/preload/renderer 三入口构建与 dev server | `npm run dev` / `npm run build` 走它；基于 Vite 6 |
| `tsc`（TypeScript 5.7） | 类型检查 + 构建 CLI 库产物 | `npm run build:lib` 跑 `tsc -p tsconfig.cli.json`；`electron-vite build` **不做**类型检查，提交前必须额外跑 `build:lib` 才能发现类型错误 |
| `electron-builder` | 打包桌面安装包（Windows / macOS） | `npm run build:win` / `build:mac`；配置在 `electron-builder.yml` |
| `node-gyp`（better-sqlite3 原生模块） | 针对当前 Electron 版本编译原生模块 | better-sqlite3 **必须**用 node-gyp 针对 Electron 41.6.0 重新编译，`electron-rebuild` 可能不生效；详见 memory `feedback-native-module-rebuild` |
| `tsx` | 直接运行 TypeScript 脚本（不走编译） | 用于 `scripts/check-handler-modules.ts`、`scripts/build-codegraph.ts` 等 |
| `vitest` | 单元测试 | `npm run test:unit`；配置在 `vitest.config.ts` |
| `playwright` | E2E 测试（驱动 Electron） | `npm run test:e2e`；通过 `ZERO_CORE_TEST_FIXTURE` 环境变量进入 mock provider 测试模式；配置在 `playwright.config.ts` |
| `electron-rebuild` | 尝试重编译原生模块 | 作为 fallback，better-sqlite3 实战首选 node-gyp |

### OpenPrd 工具链

本仓库由 OpenPrd harness 管理，开发流程的强约束通过 openprd 命令执行（不是手动改文档）：

| 命令 | 用途 | 触发时机 |
|------|------|---------|
| `openprd run . --context` | 重建状态并获取建议上下文 | 动手前先跑 |
| `openprd dev-check . <file...>` | 针对本轮 touched files 跑开发检查 | 代码修改完成后、最终回复前 |
| `openprd standards . --verify` | 文档标准（`docs/basic/`）就绪验证 | 宣称就绪前 |
| `openprd quality . --verify` | 质量门禁验证 | 宣称就绪前 |
| `openprd run . --verify` | 运行时就绪验证 | 宣称就绪前 |
| `openprd doctor .` | 综合健康检查 | freeze / handoff / commit / push 前 |

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

| 命令 | 用途 |
|------|------|
| `npm run dev` | 开发模式 |
| `npm run build` | 构建（lib + electron-vite） |
| `npm run build:win` | Windows 安装包 |
| `npm run test:unit` | 单元测试 |
| `npm run test:e2e` | E2E 测试 |
| `npm run check:handlers` | 检查处理器模块依赖 |
| `npm run serve` | HTTP/WS 服务器模式 |

## 维护规则

- 每次新增、移除或升级核心依赖后，必须检查并更新本文件
