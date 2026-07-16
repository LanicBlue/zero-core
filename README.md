# zero-core

> AI Agent 运行时 —— 基于 Electron,可配置工具 / MCP / 多 provider / 可扩展 skill 体系。

zero-core 是一个本地优先的 AI Agent 工作台:把大模型接入一个带工具调用、子代理委派、会话持久化与可视化界面的运行时。你在里面定义 agent、给它挂工具和 skill、然后像和一个会干活的助手对话一样让它完成真实任务。

## 特性

- **多 provider**:OpenAI / Anthropic / Google / OpenAI 兼容 / Ollama,通过 AI SDK 接入,一个 agent 可切换模型。
- **可配置工具体系**:文件读写、Bash、Grep/Glob、Wiki、子代理委派等内置工具,工具策略(白/黑名单、自动批准、并行/串行)按 agent 配置。
- **MCP**:标准 Model Context Protocol 客户端,接入任意 MCP server 扩展能力。
- **Skill 体系(渐进式披露)**:skill 是带 `SKILL.md` 的目录,系统提示只注入 name + description,agent 按需经 `[skills]/<id>/` 虚拟通道读取正文与脚本。**`skill-creator` 开箱即有**(内置,首次启动自动 seed 到 `~/.zero-core/skills/`),用来创建/迭代新 skill。
- **会话持久化**:better-sqlite3 存步骤/会话/工具执行,支持流式渲染、压缩摘要、归档。
- **Electron 桌面应用**:主进程 + 预加载 + React 渲染层;后端是独立 fork 的 Node 子进程(Express + WebSocket),主进程桥接 IPC ↔ HTTP/WS。
- **CLI / headless**:除桌面应用外,核心运行时也可作为库或 CLI 使用(`dist/cli.js`)。

## 快速开始

### 环境要求

- Node.js ≥ 20.6
- Windows / macOS / Linux(主开发环境为 Windows + Electron 41)

### 安装

```bash
git clone https://github.com/LanicBlue/zero-core.git
cd zero-core
npm install
```

> better-sqlite3 是原生模块,`npm install` 会按系统 Node 版本编译。Electron 打包时由 electron-builder 重新编译给 Electron ABI。

### 开发

```bash
npm run dev      # 检查 dist/ 是否需要重建 → electron-vite dev 启动 Electron
```

### 构建

```bash
npm run build          # typecheck + electron-vite build
npm run build:lib      # 仅编译核心库到 dist/(tsc + 复制内置 skill 资产)
npm run build:win      # Windows 安装包(nsis + portable)
npm run build:mac      # macOS dmg
```

### 测试

```bash
npm run test:unit      # vitest 单测
npm run test:e2e       # 先 build 再跑 Playwright(Electron)
npm run typecheck      # tsc 类型检查(cli + web + node)
```

## 配置

- **数据根**:默认 `~/.zero-core`(db/core.db、wiki、skills、attachments 等)。可用 `ZERO_CORE_DIR` 覆盖。
- **provider / 工具策略 / 代理** 等在应用内 Settings 配置,持久化到配置库。
- 环境变量示例见 [`.env.example`](.env.example)(复制为 `.env` 使用,`.env` 已 gitignore)。

## Skill 体系

skill 放在以下目录(扫描优先级:数组靠后覆盖前者,`~/.zero-core/skills` 最高):

| 目录 | 来源 | 可写 |
| --- | --- | --- |
| `~/.claude/skills` | Claude 生态 | 只读 |
| `~/.agents/skills` | agents 生态 | 只读 |
| `~/.codex/skills` | codex 生态 | 只读 |
| `~/.zero-core/skills` | zero-core 应用 | **可写**(Skills 页可新建/编辑) |

- 每个 skill 是一个目录:`SKILL.md`(带 `name` / `description` frontmatter)+ 可选 `scripts/` / `references/` / `assets/`。
- agent 通过 `[skills]/<id>/SKILL.md` 这样的虚拟路径读取,运行时解析到真实磁盘路径并沙箱化(不能 `../` 越界)。
- **`skill-creator` 是内置 skill**:首次启动后端时自动 seed 到 `~/.zero-core/skills/skill-creator`,开箱即有,用它来创建和迭代你自己的 skill。

## 项目结构

```
zero-core/
├── src/
│   ├── main/        # Electron 主进程(窗口、后端子进程生命周期、IPC 桥)
│   ├── preload/     # 预加载(安全暴露 API 给渲染层)
│   ├── renderer/    # React UI(store、组件、样式)
│   ├── server/      # 后端:Express + WebSocket、各 store、DB、router
│   ├── runtime/     # agent loop、hooks、provider、子代理委派、会话
│   ├── core/        # 配置、system prompt 组装、工具注册表
│   └── tools/       # 内置工具实现(文件/Bash/Grep/Glob/Wiki + skill 路径解析)
├── tests/           # vitest 单测 + Playwright e2e
├── scripts/         # 构建/开发辅助
├── docs/            # 架构文档、设计/计划/归档、可视化
└── electron.vite.config.ts / electron-builder.yml
```

架构细节见 [docs/arch/](docs/arch/),入门导览见 [docs/basic/](docs/basic/)。

## License

[MIT](LICENSE) © Lanic
