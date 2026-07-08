# sub-1:workbench 通道(per-step 注入基础设施)

> 依赖:无(独立,低风险,先行)。对应 design §1.3 落地改动 3、§4.3。

## 目标

新增 per-step **workbench** 注入通道(每 step 重渲染 + dirty 检查,非累积、不持久),把 todos 从 context 块迁过来,顺带修 todos mid-turn stale bug。

## 范围 / 改动

- **`src/runtime/workbench.ts`(新)**:`renderWorkbench(sessionId, agentId)` 拼 `<workbench>` 块(sub-1 含 todos;后续 sub 加 task/wait)。空返 null(调用方跳过注入)。
- **`src/runtime/agent-loop.ts` executeStream**:
  - 每 step 渲染 workbench 并**追加成 user 消息到 `stepMessages` 末尾**(非持久,不入 `messages` 数组 → 不累积)。
  - **append 而非 prepend**:turn 内 step 2+ 的最新消息常是 tool result(数组结构),prepend 字符串会破坏格式;append format-safe(与现有 task-control `[control]` 同机制)。原 design 写的"prependContext 不分 role"取消 —— prependContext 不改(仍只用于 context 块 step-1,彼时 last 是 user,role 守卫有效)。
  - 注入**每 step**(无 dirty skip —— workbench 紧凑,tokens 可忽略;若后续 task/wait 内容变大再加 dirty)。
- **todos 迁移**:`buildContextMessage`([context-message.ts](../../../src/runtime/context-message.ts))去 `todosContext` param + `## Task List (your todos)` 段;todos 改走 workbench。

## 不在本 sub

- task 状态 / wait 状态进 workbench(sub-4/5 接)。
- system / context 重构(sub-2)。
- 本 sub 的 workbench 只放 todos(其余空)。

## 风险

- prependContext 改不分 role 后,要确认不会在 step 2+ 重复堆叠(去旧再拼,而非追加)。
- dirty 检查的"变"判定要覆盖 todos 写入(sub-4 的 task 状态变更同理)。

## 验收

见 `acceptance-1.md`。
