# 产品定位与运行形态

## 一句话定位

> Zero-Core 是一个**本地优先**（local-first）的 AI Agent 桌面运行时。它把 LLM 对话、文件系统操作、MCP 工具协议、RAG、知识库、记忆系统、子 Agent 委派、可观测性等能力，**封装成一个可双形态发布**（Electron 桌面 + CLI 终端）的 Agent 执行环境。

它**不是一个聊天客户端**，而是一个可让模型直接操作你工作目录的"执行体"。

---

## 用户与场景

### 主要用户

| 角色 | 典型使用方式 |
|------|--------------|
| **个人开发者** | 让 Agent 在本地项目目录里读、改、跑、查、补文档 |
| **研究员 / 写作者** | 用内置模板（Writer / Reviewer / Researcher / Tutor）切任务 |
| **高级用户** | 配多个 Provider、写自定义 Persona / 模板、挂 MCP 服 |

### 典型任务

- 跨文件改一行 → 触达 Grep → Edit → Syntax-check 链路
- 在大型 codebase 里探索 → 委派子 Agent 并行查找
- 长期项目里保持上下文 → L1 摘要 + L2 记忆节点
- 接外部工具（Z.AI Web Search / GitHub / Notion）→ MCP

---

## 运行形态：双入口

代码层面只有**一个核心**（`runtime/AgentLoop` + `server/AgentService` + 全部 Stores），但**入口有两个**：

| 入口 | 启动命令 | 进程拓扑 | 终端用户 |
|------|----------|----------|----------|
| **桌面 App** | `npm run build:mac/win/linux` | Electron main + 子 Node.js 后端 + Renderer | 普通用户 |
| **CLI** | `node dist/cli.js` 或 `zero-core` | 单一 Node.js 进程 | 终端用户 / 自动化 |

源码里这两个入口各自只有一个 `main()` 函数：

- `src/main/index.ts` → `app.whenReady()` → 创建窗口 / spawn 后端 / 注册 IPC 代理
- `src/cli.ts` → 同进程启动 `startServer()` + `AgentLoop` + `TerminalAdapter`

详见 `02-architecture/01-topology.md`。

---

## 核心能力矩阵

| 能力 | 体现 |
|------|------|
| **多 LLM Provider** | OpenAI / Anthropic / Google / Ollama / Mock；Provider 粒度的并发限流 |
| **完整工具集** | Shell、Read、Write、Edit、Grep、Glob、Agent 子委派、Task 生命周期、Wait、AskUser、TodoWrite、WebSearch、WebFetch、Memory、SequentialThinking、Assistant |
| **MCP 协议** | stdio / SSE / streamable-http 三种 transport；Z.AI 4 个官方预设；自动扫描 Claude Desktop / Cursor / VSCode 配置 |
| **RAG** | 文件分块（paragraph-aware，800/200 token 滑动）、SQLite + Float32 存向量、OpenAI / Ollama 双 embedder 余弦相似度搜索 |
| **记忆** | 旧：知识图谱 (entity/relation)；新：**wiki 风格**记忆节点 (subject/type/content) + FTS5 全文 + 主体 (MOC) + 边 |
| **子 Agent 委派** | 阻塞 / 非阻塞 / 自动后台 / Bash 后台；event-driven Wait 唤醒 |
| **压缩** | L1 (摘要) + L2 (memory node 提取) 两段式 |
| **可观测** | 会话生命周期状态机、Welford 在线平均、Token 精确 / 估算两路、Hook 事件总线、日志（按日轮转 + 保留策略） |
| **多 Agent** | AgentStore / AgentToolStore；Agent 工具可调用别的 Agent |
| **可扩展** | 29 个 Hook 事件点 + 4 类注册入口（durable / runtime feature / metrics / tool execution） |
| **可发布** | NSIS / Portable / DMG / AppImage 4 个目标 |

---

## 与同类项目的关系（架构参照系）

Zero-Core 的形态与"主流"在多个维度上**收敛**：

- **Claude Code / Anthropic** → 启发了 Hook 事件系统、Session 生命周期、KnowledgeBase 反 AI
- **Cursor / Continue.dev** → MCP 工具集成、IDE-style file/grep glob
- **Aider** → "context attachment" 模式（在 user msg 前注入 context 而不是改 system）
- **LangChain / Vercel AI SDK** → 使用 `ai` 包做流式 + 工具调用编排

但**关键区别**：

| 区别 | 含义 |
|------|------|
| **运行时即真相** | DB 是 checkpoint，不是 source of truth。这让"换设备、换 UI、接 CLI"几乎无成本 |
| **Hook 驱动扩展** | 29 个事件点 × 多个注册器 = 不动 AgentLoop 也能加 memory recall / RAG / 压缩 / 工具审计 |
| **三进程拓扑** | 解决了 better-sqlite3 在 Electron ABI 下原生模块不兼容问题（详见 `06-decisions/01-electron-architecture.md`） |

---

## 反模式：它**不是**什么

明确说明一些它**没有**做的事，以减少预期偏差：

- ❌ 不是 SaaS —— 全部状态在 `~/.zero-core/`，没有云同步
- ❌ 不是 IDE 插件 —— 但与 IDE 工具集（Shell/Read/Edit/Grep）一致
- ❌ 不是 RAG 平台 —— RAG 只是其中一项能力
- ❌ 不是多租户 Server —— 单用户本地运行时
- ❌ 不是 agent 框架 SDK —— 内部不暴露为 npm lib（虽然 `package.json#exports` 导出了 index，但仅 lib 模式）

---

## 给新人的 30 秒全景

```
用户在 Renderer 输入消息
    ↓ (window.api.chat:send)
Electron main 转发
    ↓ HTTP POST /api/chat/send
Backend 子进程 Express 路由
    ↓ agentService.sendPrompt
AgentLoop.run(userMessage)
    ↓ Vercel AI SDK streamText
LLM Provider
    ↓ 流式事件
AgentLoop.processStreamEvents
    ↓ emit(StreamEvent)
    ├─ 推回 Electron main（via WebSocket /ws）
    │     ↓
    │  Renderer 实时渲染 text / tool / thinking 块
    ├─ 持久化 turn 块到 SQLite（via turn-hooks）
    └─ 触发 29 个 hook 事件（metrics / compression / memory / RAG / tool audit）
        ↓
        当 turn 结束：触发 SessionStart/PostTurnComplete/Stop/SessionEnd
```

整个应用就是：**一个流式事件流 + 一组挂在这个流上的处理器**。
