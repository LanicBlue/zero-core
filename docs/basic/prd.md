# Zero-Core — PRD

Zero-Core 是一个本地优先的 AI Agent 运行时，提供 Electron 桌面应用和独立 HTTP/WebSocket 服务器两种部署模式。核心能力是通过工具链和多模型支持，让 AI Agent 在本地环境中自主执行任务。

## 核心定位

- **Agent 运行时**：完整的 Agent 执行引擎，支持工具调用、子任务委派、错误恢复
- **本地优先**：所有数据存储在本地 SQLite，无需云服务
- **多模型支持**：通过 Vercel AI SDK 统一接入 Anthropic、OpenAI、Google 等模型

## 功能范围

### Agent 执行引擎
- 流式执行 + 工具调用循环（最大 200 步）
- 并行工具调用，通过 `toolCallId` 精确匹配结果，避免并行调用结果混淆
- 重试机制：瞬态错误自动重试（指数退避），上下文过长自动裁剪
- 对话检查点（CheckpointManager）+ 中断恢复
- 子任务委派（前台同步 / 后台异步，SubagentDelegator）
- 系统提示词动态组装（base + tool_policy + rag_context）
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
