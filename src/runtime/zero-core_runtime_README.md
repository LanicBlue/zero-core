# runtime/

zero-core agent 执行运行时：会话、agent loop、provider、上下文构建、压缩、记忆、限速等核心机制。

## 核心功能

承载 agent 一次完整执行所需的全部运行时能力：

- 会话与循环：`session.ts`、`agent-loop.ts`、`turn-recorder.ts`、`checkpoint-manager.ts`、`pending-responses.ts` 维护对话状态、turn 持久化、断点恢复与待回响应。
- Provider 与并发：`provider-factory.ts`、`provider-concurrency-manager.ts`、`proxy-manager.ts`、`mock-language-model.ts` 负责 model 解析、跨 provider 并发与代理、测试 mock。
- 上下文工程：`context-message.ts`（动态 `<context>` 注入）、`compression-engine.ts`（L1 摘要 + L2 记忆节点）、`memory-recall.ts`（FTS5 召回）、`prompt-sections.ts`。
- 工具与子任务：`tools/`（内置工具）、`mcp-tools/`（MCP 风格扩展工具）、`task-registry.ts`、`subagent-delegation.ts` / `subagent-delegator.ts`、`agent-roles.ts`、`agent-utils.ts`。
- 限流与终端：`tool-rate-limiter.ts`、`concurrency-queue.ts`、`terminal-adapter.ts`。
- 钩子扩展点：`hooks/` 下集中注册 PreLLMCall / PostTurnComplete 等功能钩子。

## 输入

- 用户消息、SessionConfig（provider、模型、压缩/记忆/RAG/thinking 配置）、工作目录。
- DB / ISessionStore：消息、turns、记忆节点、checkpoint 的持久化后端。
- 外部回调：getRagContext、provider 选项、tool 注册表。

## 输出

- 流式 assistant 回复（文本 + tool-call blocks）。
- 持久化副作用：messages / turns / memory-node / checkpoint 表写入。
- 上下文构造产物：注入到 user 消息前的 `<context>` 块、压缩后的新 messages、记忆召回文本。

## 定位

`src/runtime/` 是 zero-core 的执行内核，向上对接 `server/`（HTTP/IPC、store）与 `renderer/`，向下对接 provider SDK（`ai`、Anthropic 等）与本地工具实现。所有"agent 怎么跑"的逻辑都在此层；UI 与存储协议不内嵌进 runtime。

## 依赖

- `ai` 及各 provider SDK（通过 `provider-factory` 解析）。
- `server/memory-node-store`、`server/` 提供的 store 接口。
- `core/logger`、`core/hook-registry`、`core/hook-types`。
- 子目录：`hooks/`、`tools/`、`mcp-tools/`。

## 维护规则

- 新功能优先以 hook 形式注册到 `hooks/index.ts`，不要往 `agent-loop.ts` 里塞内联代码（见 memory：AgentLoop 禁止内联功能代码）。
- 新增 store 列时同步 db-migration 的 *_COLUMNS，避免 fresh DB 缺列。
- 压缩/记忆/RAG 的阈值、prompt、节点类型集合变更需跨模块同步（compression-engine、memory-recall、context-message、mcp-tools/memory-node-tools、types.ts 注释）。
- 改动 provider 解析或并发管理后，必须跑 `build:lib`（tsc）验证类型，electron-vite build 不做类型检查。
