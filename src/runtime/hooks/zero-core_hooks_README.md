# runtime/hooks/

agent loop 的功能扩展点：以 PreLLMCall / PostTurnComplete / Notification 等钩子形式挂载运行时副作用，保持 agent-loop 本身精简。

## 核心功能

- `index.ts`：统一注册入口 `registerAllRuntimeHooks(db?)`，按固定顺序挂载全部功能钩子。
- `turn-hooks.ts`：step-level turn 持久化，user turn 与 assistant steps 分别写独立行（turns 表的唯一写入点）。
- `notification-hooks.ts`：把已完成的后台任务以 `<task-notification>` 注入会话，并触发 Notification 观测钩子。
- `memory-hooks.ts`：PreLLMCall 自动 FTS5 召回记忆节点，注入 `## Recalled Memories`。
- `rag-hooks.ts`：PreLLMCall 调用 `config.getRagContext` 注入 `## Knowledge Base`。
- `provider-options-hooks.ts`：按 thinkingLevel 注入 Anthropic thinking budget 等 provider 选项。
- `compression-hooks.ts`：PostTurnComplete 触发渐进式压缩，并同步 messages 表与 turns 表、写入记忆节点。

## 输入

- Hook 上下文（agentId、sessionId、config、session、contextUsage、taskRegistry、providers 等）。
- 配置开关：SessionConfig.compression / memory / thinkingLevel / getRagContext。
- 上游数据：用户消息文本、TaskRegistry 完成任务、MemoryNodeStore 命中节点、RAG 召回文本。

## 输出

- 副作用：messages / turns / memory-node 表写入、session 内存态更新、Notification 事件触发。
- PreLLMCall 返回值合并：`memoryContext` / `ragContext` / `providerOptions` 等，供 context-message 与 LLM 调用消费。

## 定位

`src/runtime/hooks/` 是 runtime 层的横切关注点集中地，介于 `core/hook-registry`（机制）与 runtime 各功能模块（compression-engine、memory-recall、turn-recorder、task-registry）之间。所有功能副作用必须通过 hook 注册，不允许写回 agent-loop 内联逻辑。

## 依赖

- `core/hook-registry`、`core/hook-types`、`core/logger`。
- `runtime/compression-engine`、`runtime/memory-recall`、`runtime/turn-recorder`、`runtime/task-registry`、`runtime/session`、`runtime/types`、`runtime/session-store-interface`。
- `server/memory-node-store`、具备 step-level schema 的 DB。

## 维护规则

- 新增功能钩子必须在 `index.ts` 中按依赖顺序追加 `register*Hooks()` 调用。
- PreLLMCall 钩子的返回值合并顺序敏感（notification → memory → rag → providerOptions → compression），调整前需评估对上下文相互覆盖的影响。
- turn 表只允许通过 `turn-hooks` 写入；`compression-hooks` 重建 step 时也走 `replaceStepsFromMessages` 而非直接写。
- 关闭开关（enabled / autoRecall / thinkingLevel=none）的语义若调整，需同步 `types.ts` 中 SessionConfig 注释。
