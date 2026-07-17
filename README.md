# zero-core

> 本地优先的 AI Agent 工作台：Electron 桌面端、独立 Node 后端、可配置工具、MCP、多 Provider 与 Skill。

zero-core 把模型接入本地文件、终端、Wiki、任务委派和持久化会话。桌面模式下，Electron 主进程负责窗口与桥接，业务后端运行在单独的 Node 子进程中，React 渲染层通过 IPC → HTTP/WebSocket 与后端通信。

## 当前能力

- OpenAI、Anthropic、Google、OpenAI-compatible 与 Ollama Provider。
- 22 个当前内置工具，包括文件/终端、Web、子代理、任务、工作流、Wiki 和平台工具；实际注册表以 [`src/tools/index.ts`](src/tools/index.ts) 为准。
- 外部 MCP server 扫描、配置与动态工具接入。
- 基于 `SKILL.md` 的 Skill 扫描、读取、创建和安装。
- SQLite 会话、消息、任务、工作流和工具审计；Wiki 与附件等内容同时使用本地文件。
- 流式输出、工具调用、中断恢复、上下文压缩和子代理委派。

## 环境要求

- Node.js ≥ 24.14.0；仓库的 [`.nvmrc`](.nvmrc) 是推荐版本。
- npm。
- Windows、macOS 或 Linux。当前依赖 Electron 43，并包含 `better-sqlite3` 原生模块。

Windows 上不支持更旧的 Node 24 版本：Node 24.12.0 的 `fs.rmSync` 可能在删除非 ASCII 路径时导致进程原生崩溃，测试启动时会主动拒绝不满足版本要求的运行时。

## 安装与开发

```bash
git clone https://github.com/LanicBlue/zero-core.git
cd zero-core
npm install
npm run dev
```

`npm run dev` 会在需要时先生成 `dist/`，随后启动 `electron-vite` 开发模式。开发模式的后端使用系统 `node`，因此当前 shell 的 Node 版本必须满足上述要求。

## 验证与构建

```bash
npm run typecheck       # cli / web / node 三套 TypeScript 配置
npm run test:unit       # Vitest 单元测试
npm run test:e2e        # build 后运行 Electron Playwright 测试
npm run check:links     # 检查 Markdown 本地链接
npm run build           # typecheck + Electron 三入口构建
npm run build:lib       # 生成 dist/ CLI/后端库并复制内置 Skill
```

平台安装包：

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

三个打包命令都会先把 `better-sqlite3` 重编译为 Electron ABI，打包结束后再恢复为系统 Node ABI。不要用普通 `npm run build` 代替安装包命令。

## 运行入口

| 入口 | 源文件 | 当前用途 |
| --- | --- | --- |
| Electron 桌面端 | `src/main/index.ts` | 主要产品入口，由 `npm run dev` 或打包产物启动 |
| 后端子进程 | `src/backend.ts` | Electron 自动拉起，使用随机本地端口 |
| CLI | `src/cli.ts` | `npm run build:lib` 后运行 `dist/cli.js` |
| 独立 HTTP/WS | `src/serve.ts` | 库级入口；当前 `package.json` 没有 `serve` npm script |

CLI 与独立服务入口存在，但桌面端是当前完整接线、测试覆盖最充分的运行方式。

## 配置与数据

- 数据根默认为 `~/.zero-core`，可用 `ZERO_CORE_DIR` 覆盖。
- 主配置文件为 `~/.zero-core/zero-core.json`；项目目录也可提供 `zero-core.json` 或 `.zero-core.json`。
- Provider、Agent、工具策略等主要通过桌面应用配置。
- 环境变量说明见 [`.env.example`](.env.example)。

典型数据包括 `sessions.db`、`wiki/`、`skills/`、`attachments/`、`archives/`、`tool-outputs/`、`logs/` 和项目/工作流 worktree。WebFetch 目前有一条绕过 `ZERO_CORE_DIR` 的旧路径，详见架构文档。

## Skill 来源

扫描优先级从低到高如下；同名 Skill 由后面的来源覆盖：

| 目录 | 来源 | 应用是否可写 |
| --- | --- | --- |
| `~/.claude/skills` | Claude 生态 | 否 |
| `~/.agents/skills` | Agent 生态 | 否 |
| `~/.codex/skills` | Codex 用户 Skill | 否 |
| `~/.codex/skills/.system` | Codex 内置 Skill | 否 |
| `~/.zero-core/skills` | zero-core | 是 |

内置 `skill-creator` 会在后端首次启动时 seed 到 `~/.zero-core/skills/skill-creator`。

## 代码结构

```text
src/
├── core/       # 配置、提示词、Hook/工具注册表、日志
├── main/       # Electron 主进程、后端生命周期、IPC 代理
├── preload/    # contextBridge API
├── renderer/   # React UI 与 Zustand 状态
├── runtime/    # AgentLoop、Session、恢复/并发运行时
├── server/     # Express/WS、服务、Store、迁移与后台工作流
├── shared/     # 跨进程类型和契约
├── tools/      # 内置工具、MCP 平台工具和 Outline
├── backend.ts  # Electron 后端子进程入口
├── serve.ts    # 独立 HTTP/WS 入口
└── cli.ts      # 终端入口
```

文档总入口见 [`docs/README.md`](docs/README.md)，当前事实速览见 [`docs/basic/README.md`](docs/basic/README.md)。`docs/plan/` 描述未来方案，`docs/archive/` 仅是历史实施记录，不能作为当前行为依据。

## License

[MIT](LICENSE) © Lanic
