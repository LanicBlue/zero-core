# sub-4:① session 观测暴露

> ① 暴露面。Platform `sessions` resource(agent 自省)+ IPC(③ 看板消费)。对应 design ①。无新功能依赖(用现有 runStates/getRuntimeTaskTree/recorder)。

## 任务

### Platform `sessions` resource(文本格式)

- 加 resource 值 `'sessions'`,参数 `sessionId?`。
- **List(无 id)**:遍历 `agentStore.list()` → 每个 agent 的 active/main session(`session_kind='chat'`)→ 合并 `runStates`(isBusy/waiting → status:running|waiting|idle)+ lastActivity。文本,相对时间("last 2s ago")。每行:`状态点 · agentId · sessionId(short) · status · 相对时间 · turns`。
- **Detail(sessionId)**:
  - **task tree**:`getRuntimeTaskTree(sessionId)`([agent-service.ts:446](../../../src/server/agent-service.ts#L446))原样输出(与 TaskList 同源)。
  - **最近 N=3 step**:经 recorder/`getRecentToolCalls`([agent-loop.ts:568](../../../src/runtime/agent-loop.ts#L568))同源抽取,每 step `{stepSeq, toolCalls:[{name, argsBrief}], status, time}`(**无 tokens**)。

### IPC(给 ③)

- `sessions:parents` → 父 session List 数据(JSON,供看板左栏;看板侧不显 sessionId)。
- `sessions:detail` { sessionId } → Detail 数据(task tree + 最近3step)。

## 范围

- 只读暴露,无写操作。Platform 文本 + IPC JSON 两面同源数据。
- 数据来自现有 runStates/getRuntimeTaskTree/recorder + SessionMetrics(turns/lastActivity)。

## 风险

- 父 agent 判定:`agentStore.list()` 全是父?需过滤有 active/main chat session 的(子 agent/subagent 角色可能也在表里)。实现者确认 agent 清单过滤。
- 相对时间格式与 ③ 一致。

## 验收

见 `acceptance-4.md`。
