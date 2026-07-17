# Issue:external-subagent-mcp

- **状态**:② design(讨论细化)
- **提出**:2026-07-08
- **类型**:改进(架构 / 集成)
- **依赖**:[`../../archive/tool-decoupling/`](../../archive/tool-decoupling/)(工具纯函数化是地基,已合并)

> **实现状态（2026-07-16）**：问题仍在 design 阶段。当前 MCP 能力是 zero-core 作为 client 连接外部 server，不包含把内部工具作为 MCP host 暴露给 Claude Code/Codex。

## 问题

subagent 当前只有一种:内部 AgentLoop(`subagent-delegator` 起子 loop)。无法把任务委派给**外部 agent**(Claude Code、Codex 等),也无法把内部工具(Wiki / Platform 读 / 文件类)暴露给它们用。

目标方向(待 design 细化):外部 agent 作为 subagent 的可选项;经 **MCP** 把选定内部工具暴露给它们;parent agent 委派时带 scope(项目沙箱 + 工具集 + 读写限制)。

## 现状 / 真相源 / 影响面

### subagent 现状
- `subagent-delegator.ts`:delegate 起内部 AgentLoop(同进程),工具经 ctx 调。
- 无"外部 target"概念;无外部进程/API 委派路径。

### 工具暴露现状
- 工具 `execute(input, ctx)` 只被内部 AgentLoop 调(经 `buildTool` wrapper)。
- UI 走 REST(独立入口)。
- **无 MCP server**:外部 agent 无法经协议调内部工具。
- 工具依赖 per-loop ctx(见 tool-decoupling issue)→ 外部 agent 没有 ctx,当前架构喂不进去。

### 外部 agent 能力
- Claude Code / Codex 等**原生支持 MCP client**:连 MCP server 即可调其暴露的工具。
- 各家启动方式(Claude Code `-p` headless + MCP、Codex CLI/API)在实现时定。

### 影响面
- 不能用外部 agent 当 subagent(无法借力 Claude Code / Codex 的能力做子任务)。
- 不能把内部 wiki / 文件 / 平台数据共享给外部 agent(它们只能在自己的沙箱里跑,看不到本项目上下文)。

## 下一步

进② design 细化方案(`/effort design`)。**先决条件:tool-decoupling 落地**(工具纯函数化 + exposable 标记 + callerCtx.scope 字段),否则 MCP host 喂不进工具。design 要定:
- MCP server 形态(暴露哪些工具、协议层、与 REST/UI 的关系)。
- scope token(parent 委派时签发、外部 agent 持 token 连 MCP、server 按 token 解析沙箱)。
- exposable 工具集(app 级/读类可暴露;session 作用域 TodoWrite/Task/Wait 不可)。
- subagent-delegator 外部 target(启动 Claude Code/Codex + 配 MCP endpoint + scope)。
- 安全(外部 agent 沙箱、读写限制、token 生命周期)。
