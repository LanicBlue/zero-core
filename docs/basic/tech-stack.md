# 项目技术栈

> 本文只记录当前仓库可验证的工具链与命令。版本以 `package.json` / `package-lock.json` 为准。

## 运行环境

| 项目 | 当前基线 |
| --- | --- |
| Node.js | ≥ 24.14.0；推荐版本见仓库根目录 `.nvmrc` |
| 包管理器 | npm |
| 语言 | TypeScript 5.7 |
| 桌面运行时 | Electron 43 |
| UI | React 19 + Zustand 5 |
| 构建 | electron-vite 5 / Vite 6 |
| 数据库 | better-sqlite3 12.11 |
| 单元测试 | Vitest 4 |
| E2E | Playwright 1.60，驱动 Electron 构建产物 |

Windows 使用 Node 24.12.0 时，`fs.rmSync` 删除非 ASCII 路径可能导致进程原生崩溃。项目把 24.14.0 作为最低版本，Vitest 配置也会在加载测试前校验运行时。

## 核心依赖

- AI SDK：`ai`、`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google`。
- MCP：`@modelcontextprotocol/sdk`。
- 服务与传输：Express（由依赖图提供）、`ws`、`undici`。
- 内容处理：`jsdom`、`turndown`、`pdf-parse`、`react-markdown`、`shiki`。
- 契约与校验：Zod 4、TypeBox。
- 本地持久化：`better-sqlite3`；附件、Wiki、大工具输出和归档还会写入数据根目录。

## npm 命令

下表逐项对应当前 `package.json`：

| 命令 | 实际用途 |
| --- | --- |
| `npm run dev` | 必要时运行 `build:lib`，再启动 `electron-vite dev` |
| `npm run typecheck` | 检查 cli / web / node 三套 tsconfig |
| `npm run build` | 先 typecheck，再构建 Electron main / preload / renderer |
| `npm run build:lib` | 用 `tsconfig.cli.json` 生成 `dist/`，再复制内置 Skill |
| `npm run preview` | 预览 Electron 构建产物 |
| `npm run test:unit` | 一次性运行 Vitest |
| `npm run test:unit:watch` | Vitest watch 模式 |
| `npm run test:e2e` | 先 `build`，再运行 Playwright |
| `npm run check:links` | 检查 Markdown 本地链接 |
| `npm run build:codegraph` | 重新生成 `docs/visualization/code-graph.html` 与 `code-graph-data.json`；静态分析和手工描述不保证等同运行时接线 |
| `npm run self-update*` | 自更新、打包模式更新或回退 |
| `npm run rebuild:native:*` | 在 Electron ABI 与系统 Node ABI 之间重编译原生模块 |

当前没有 `npm start`、`npm run serve` 或 `npm run check:handlers`。`src/serve.ts` 是独立服务的源码入口，但尚未暴露为 npm script。

## 构建产物

| 目录 | 来源 | 用途 |
| --- | --- | --- |
| `dist/` | `npm run build:lib` | CLI、后端子进程和库输出 |
| `out/` | `npm run build` | Electron main / preload / renderer 输出 |
| `release/` | `npm run build:<platform>` | 安装包或便携包 |
| `build/` | 仓库资源 | 图标和 electron-builder 资源；不是普通编译输出 |

## better-sqlite3 ABI

开发模式的后端由系统 Node 启动，因此需要 Node ABI 版本的 `better-sqlite3`。打包后的后端由 Electron fork，需要 Electron ABI 版本。

`build:win`、`build:mac` 和 `build:linux` 已按以下顺序封装：

1. `rebuild:native:electron`
2. `build`
3. `electron-builder`
4. `rebuild:native:node`

如果平台打包中途退出，重新运行 `npm run rebuild:native:node`，再执行 Node 侧测试或开发命令。

## 维护规则

- 升级依赖后，以 `package.json` 为准同步本页，不手写无法验证的精确行数或文件数。
- 新增/删除 npm script 时，同步 README 与本页。
- 修改打包链路时，同时核对 `electron-builder.yml` 和 `scripts/rebuild-native.cjs`。
