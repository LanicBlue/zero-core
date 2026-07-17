# Zero-Core 产品边界

> 本文描述当前产品，不把 `docs/design/` 或 `docs/plan/` 中的目标状态写成已实现能力。

## 定位

Zero-Core 是一个本地优先的 AI Agent 工作台。主要产品形态是 Electron 桌面应用，模型可在用户授权的本地环境中调用文件、终端、Web、MCP、Wiki、工作流和子代理工具，并把会话与执行状态持久化到本机。

## 当前用户价值

- 为不同 Agent 配置 Provider、模型、提示词、Skill 和工具策略。
- 在桌面 UI 中运行流式会话并查看工具调用、任务树、输入队列和错误。
- 让 Agent 读写工作区、执行命令、检索 Web、调用 MCP server。
- 委派子代理或后台任务，并查询、终止、恢复或收尾任务。
- 管理 Project、Requirement、Cron、Wiki 等本地工作流数据。
- 在异常退出后恢复部分未完成会话、任务、归档和工作流状态。

## 已实现能力

### 模型与 Provider

- OpenAI、Anthropic、Google Gemini。
- OpenAI-compatible endpoint 与 Ollama。
- Provider/模型配置持久化、模型列表获取、代理配置和 thinking 选项。

### 工具

当前内置注册表包含 22 个工具：

```text
Shell, Read, Write, Edit, Grep, Glob, Subagent, Task, Wait,
WebSearch, AskUser, TodoWrite, WebFetch, SequentialThinking,
Orchestrate, Project, Work, AgentRegistry, Cron, Wiki, Flow, Platform
```

外部 MCP 工具在运行时合并。工具启用由 Agent tool policy 控制，文件系统和 Shell 工具是无显式配置时的默认基础集合。

### 会话与执行

- AI SDK 流式 step/tool loop。
- 通过 `toolCallId` 区分并行工具调用。
- session、step、滚动摘要、工具执行与 checkpoint 持久化。
- main/delegated loop 各自的 HookRegistry 接线。
- 输入队列、子代理委派、后台任务和 workbench。
- 上下文压缩、会话归档与启动恢复。

### 桌面与服务

- Electron main / preload / renderer 分层。
- 独立 Node 后端进程提供 Express REST 与 WebSocket。
- 主进程提供 IPC→HTTP 代理和 WS→IPC 事件桥。
- `src/cli.ts` 与 `src/serve.ts` 提供 headless 入口源码，但当前完整产品接线和主要 E2E 覆盖集中在桌面模式。

### 本地数据

- SQLite 保存结构化状态。
- Wiki、附件、大工具输出、归档、日志和 Skill 使用本地文件。
- 默认数据根 `~/.zero-core`，可通过 `ZERO_CORE_DIR` 改写。

## 当前不再成立的旧能力描述

- 不存在 `Agent-as-Tool` 映射/独立工具暴露机制；委派统一通过 `Subagent`。
- 不存在 MemoryRead/MemoryWrite 内置工具；知识/记忆主线使用 Wiki 与压缩上下文。
- TaskStart/TaskGet/TaskList/TaskKill/TaskFinish/TaskResume 不再是多个独立工具；由 `Task` action 合并。
- 当前不是“17 个内置工具”。
- 当前没有 `npm start` 或 `npm run serve`。
- OpenPrd verify 命令不是现行工程门禁。

## 非目标与边界

- 当前是本地单用户应用，不提供多租户云服务或服务器级权限隔离。
- 不训练或微调模型。
- 不承诺所有外部 Skill/MCP/脚本都安全；本地执行能力本身具有高权限风险。
- 不替代完整 IDE。
- `docs/plan/wiki-system-redesign/` 是未来重构计划，不代表当前数据库和 API 已完成切换。

## 质量基线

提交前按变更范围运行：

```bash
npm run typecheck
npm run test:unit
npm run check:links
```

涉及 Electron 集成、IPC、窗口或完整用户流程时再运行：

```bash
npm run test:e2e
```

构建安装包必须使用对应平台的 `build:win`、`build:mac` 或 `build:linux`，以保证 `better-sqlite3` ABI 正确。
