# runtime/tools/

agent 内置工具实现与注册中心：文件读写、搜索、bash、子 agent、任务管理、代码大纲等基础能力。

## 核心功能

- 注册与工厂：`tool-factory.ts`（buildTool 统一构造）、`index.ts`（工具汇总导出）。
- 文件操作：`file-read.ts`、`file-write.ts`、`file-edit.ts`、`file-read-helpers.ts`。
- 搜索：`glob.ts`、`grep.ts`、`web-search.ts`。
- 执行：`bash.ts`、`terminal-adapter`（上层）。
- 子 agent 与任务：`agent.ts` / `agent-tool.ts`、`orchestrate-tool.ts`、`task-list.ts`、`task-status.ts`、`task-stop.ts`、`subagent-delegation`（上层）。
- 交互与状态：`ask-user.ts`、`todo-write.ts`、`wait.ts`。
- 代码理解：`outline/`（多语言大纲提取）、`syntax-check.ts`。
- 领域工具：`wiki-tools.ts`、`requirement-tools.ts`、`mcp-tool.ts`（MCP 桥接）。

## 输入

- 工具入参（各工具自带 zod schema）：路径、pattern、命令、query、子任务描述等。
- 执行上下文 `ctx`：工作目录、db、sessionId、provider 配置、tool registry。

## 输出

- 工具结果字符串或结构化文本（文件内容、搜索命中、命令输出、大纲树等）。
- 副作用：文件读写、子进程执行、子 agent 会话创建、todo / task 状态更新。

## 定位

`src/runtime/tools/` 是 agent 的"手脚"，由 agent-loop 在 tool-call block 中调度；通过 `tool-factory` 统一注册到工具表，向上对接 agent-loop，向下调用 fs / 子进程 / 子 agent / store。与 `mcp-tools/` 互补：本目录是基础能力，`mcp-tools/` 偏集成型扩展。

## 依赖

- `zod`、`tool-factory`。
- `runtime/session`、`runtime/subagent-delegation`、`runtime/agent-roles`（子 agent 工具）。
- `runtime/tools/outline/`（大纲子模块）。
- Node fs / child_process、第三方（glob/ripgrep 等通过封装）。

## 维护规则

- 新增工具必须走 `buildTool`，并补全 `meta`（category、isReadOnly、isDestructive、isConcurrencySafe）以便限速与权限判定。
- 破坏性工具（写/删/执行）需声明 `isDestructive`，并配合 `tool-rate-limiter` 与上层审批策略。
- 大纲类语言扩展统一在 `outline/` 注册，不要把 extractor 散落到本目录。
- 改动工具入参 schema 时注意 agent prompt 中关于该工具的描述需同步更新。
