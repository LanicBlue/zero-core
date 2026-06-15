# 产品逻辑说明

# Zero-Core — PRD

Zero-Core 是一个本地优先的 AI Agent 运行时，提供 Electron 桌面应用和独立 HTTP/WebSocket 服务器两种部署模式。核心能力是通过工具链和多模型支持，让 AI Agent 在本地环境中自主执行任务。

## 核心定位

- **Agent 运行时**：完整的 Agent 执行引擎，支持工具调用、子任务委派、错误恢复
- **本地优先**：所有数据存储在本地 SQLite，无需云服务
- **多模型支持**：通过 Vercel AI SDK 统一接入 Anthropic、OpenAI、Google 等模型

## 问题与目标

### 要解决的问题

- **通用 AI Agent 缺乏本地可控的执行环境**：开发者用 ChatGPT / Claude.ai 时，Agent 没有文件系统、终端、浏览器等真实执行能力，只能给建议不能动手。
- **Agent 与真实工作流脱节**：把 Agent 当一次性问答用，不会持久化、不会恢复中断、不会跨会话积累记忆；复杂任务一旦中断就丢失。
- **多模型/多 Provider 配置碎片化**：每个 Provider 有自己的 SDK、限速、错误处理，开发者要为每个模型重写胶水代码。
- **工具调用缺乏治理**：要么全自动（危险）、要么全手动（繁琐）；并行工具结果容易混淆；工具滥用没有限速和审计。
- **多 Agent 协作无章法**：要做一个 PM/Lead/Archivist 这种角色化的工作流，没有现成框架支撑需求拆解、状态流转、知识沉淀。
- **MCP 生态碎片化**：MCP 服务器配置散落在各 CLI 工具里，没有统一发现和托管。

### 目标

- 提供一个本地优先的 Agent 运行时，让 Agent 能在用户真实环境（文件、终端、浏览器）中自主执行。
- 通过工具策略 + 限速 + Hook 三层治理，把「自动化」和「可控」调和到一个可用的中间状态。
- 通过检查点 + 中断恢复 + 持久化记忆，让 Agent 任务可中断、可恢复、可累积。
- 把 multi-agent 工作流（PM 发现需求、Lead 实现、Archivist 归档）做成运行时一等公民，而非靠 prompt 硬塞。
- 统一 MCP / 内置工具 / Agent-as-Tool 三种工具来源，开发者一处配置全局可用。

### 非目标

- 不做云托管、多租户、权限隔离（本地单用户）。
- 不做模型训练、微调。
- 不替代 IDE，定位是 Agent 运行时而非代码编辑器。

## 用户故事

- **作为开发者**，我想为不同任务配置不同角色的 Agent（Coder / Writer / Reviewer / Architect），并在它们之间切换，这样不同任务用最合适的角色和 prompt。
- **作为开发者**，我想给 Agent 配置工具白名单和读写范围（`readScope`），这样 Agent 只能碰我授权的目录和工具，不会误删项目外文件。
- **作为开发者**，我想配置 per-tool 限速（`minInterval` / `maxConcurrent`），这样调用第三方 API 的工具不会因并发过高被封。
- **作为开发者**，我想在 Agent 执行中断（崩溃 / 关机）后，重启能自动恢复未完成的 turn，这样长任务不丢。
- **作为开发者**，我想把多个 Agent 编排成项目工作流（Analyst 发现需求 → Lead 拆解实现 → Archivist 归档），并看到需求从 found 到 closed 的状态流转，这样多 agent 协作有据可查。
- **作为开发者**，我想在本地浏览器登录后，让 WebFetch 工具复用 cookie 抓取登录态页面，并把大结果自动存盘，这样抓站不需要重写鉴权。
- **作为开发者**，我想用 CLI（`zero-core --model ... --provider ...`）在终端直接跑 Agent，不必每次开桌面应用。
- **作为开发者**，我想把外部 MCP 服务器（Claude Code / Cursor 等配置的）自动发现并导入，这样不重复配置。
- **作为运维**，我想用 HTTP/WS 模式把 zero-core 跑成服务，远程客户端通过 `/api/*` 和 `/ws` 接入，这样不依赖桌面 GUI。

## 验收标准

- **Agent 执行引擎**
  - 流式输出正常显示，工具调用通过 `toolCallId` 在并行场景下正确匹配 block，不出现结果错位。
  - 瞬态错误按指数退避自动重试；上下文超限时自动裁剪并继续，不直接失败。
  - 中断后重启，`recovery.ts` 能扫描并恢复未完成 turn，恢复后状态正确。
  - Agent 删除时关联的 agent-tool 条目被级联清理，重启时孤儿记录被 `cleanupOrphans()` 清掉。
- **工具系统**
  - 17 个内置工具在 Tools 页面可启用/禁用、可配置参数、可单测（`/api/tool-execute`）。
  - 限速生效：`minInterval` 内的重复调用被 FIFO 排队，`maxConcurrent` 满时阻塞新调用。
  - 工具策略优先级正确：`tools` map > `autoApprove` > `DEFAULT_ENABLED`。
  - PreToolUse hook 可阻断工具调用，阻断被记录为失败而非挂起。
- **多模型**
  - Anthropic / OpenAI / Google 三类 Provider 配置后，模型列表能聚合到 `/api/models`，Agent 能用其中任意一个执行。
  - Provider 缺 apiKey 时被跳过，不导致运行时崩溃。
- **多 agent 工作流**
  - Analyst 能从项目代码生成 wiki 和需求列表；Lead 能把 `ready` 状态的需求推进到 `plan` → `build`；Archivist 能在 `closed` 后归档知识。
  - Requirement 状态流转遵循白名单，非法转换被拒绝并返回合法后继提示。
  - 任意非空状态下 user 能 `cancelled`，特殊规则不依赖白名单匹配。
- **部署**
  - `npm start` 起桌面应用，`npm run serve` 起 HTTP/WS 服务并暴露 `/api/*` + `/ws`，`zero-core` CLI 能在终端跑通。
  - 启动时自动检测并导入外部 MCP 配置（Claude Code / Cursor 等），无配置时不报错。
- **文档与就绪**
  - `openprd standards . --verify`、`openprd quality . --verify`、`openprd run . --verify` 全部通过。
  - `docs/basic/` 是唯一基线文档路径，章节标题与 doctor 字面匹配一致。

## 功能范围

### Agent 执行引擎
- 流式执行 + 工具调用循环（最大 200 步）
- 并行工具调用，通过 `toolCallId` 精确匹配结果，避免并行调用结果混淆
- 重试机制：瞬态错误自动重试（指数退避），上下文过长自动裁剪
- 对话检查点（CheckpointManager）+ 中断恢复
- 子任务委派（前台同步 / 后台异步，SubagentDelegator）
- 系统提示词动态组装（base + tool_policy），RAG/memory 通过 hook 注入
- 思维链（thinking）支持

### 工具系统
- 17 个内置工具：Bash、Read、Write、Edit、Grep、Glob、WebSearch、WebFetch、AskUser、TodoWrite、Agent、TaskStatus、TaskList、TaskStop、Wait、MemoryRead、MemoryWrite、SequentialThinking
- 工具限速（ToolRateLimiter）：per-tool FIFO 队列，可配置 `minInterval` 和 `maxConcurrent`
- 工具策略（toolPolicy）：agent 级别的 `tools` map 启用/禁用、`autoApprove` 自动批准、`readScope` 读写范围控制
- MCP 工具集成（MCPManager）
- Agent-as-Tool：将 Agent 暴露为工具供其他 Agent 调用
- Outline 模式：Read 工具的结构化代码大纲视图（27 种语言），折叠/展开控制

### Web 能力
- WebSearch：Brave Search API 搜索，支持限速
- WebFetch：网页抓取 + Markdown 转换，SPA 自动检测并切换浏览器渲染，Cookie 管理，磁盘缓存，大结果自动存盘
- 浏览器渲染：Electron BrowserWindow 处理 JavaScript 渲染

### 模板系统
- 12 个内置模板：Coder、Writer、Translator、Reviewer、Analyst、Tutor、Creative、Researcher、Collector、DevOps、Product Manager、Architect
- 每个模板包含详细 system prompt（角色、规则、流程、成功标准、沟通风格）
- 模板合并：内置模板 systemPrompt 变更时自动更新已有记录

### 数据持久化
- SQLite（better-sqlite3）存储所有数据
- 会话历史、Agent 配置、工具配置、MCP 配置、知识库
- 对话检查点（turn_state 表）用于中断恢复
- Agent 删除时级联清理关联的 agent-tool 条目，启动时清理孤儿记录

### UI
- 三栏可调布局：聊天面板、文件树、文档查看器
- Agent 管理页面（创建、编辑、工具配置、暴露为工具）
- Tools 页面（工具列表、配置、统计、AI 分析、测试）
- Dashboard（会话指标、Token 用量）
- MCP 设置、Provider 设置、知识库管理
- 图标侧边栏导航

## 部署模式

| 模式 | 入口 | 适用场景 |
|------|------|---------|
| Electron 桌面 | `npm start` | 本地开发使用 |
| HTTP/WS 服务器 | `npm run serve` | 远程访问、集成 |

## 不包含

- 多用户管理、权限控制、云端部署

## 维护规则

- 每次功能边界变化后，必须检查并更新本文件
