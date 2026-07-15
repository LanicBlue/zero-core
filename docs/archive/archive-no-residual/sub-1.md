# sub-1:terminal 解耦删行 + 同步打 mark(D1)

- **决策**:D1 = A2(terminal 同步 `markArchivedTransient(childSessionId)` + fire 归档 + **立即删行**;归档未触发/crash 时启动 recovery 兜底)
- **依赖**:无(独立于 sub-2 的接线收口;sub-1 只改已接线的 createLoopForSession 路径行为)
- **关联**:[design.md §D1](./design.md)

## 目标

任务进入 `completed`/`failed` 终态时,把 `delegated_tasks` 行删除 + 给子 session 打 `archived=1` mark,从慢归档(memory turn 秒~分钟级)解耦——**行立即消失**(不再 re-seed 回 UI),子 session 的归档走现有二级缓冲管线,crash/未触发由启动 `recoverInterruptedArchives` 兜底。

## 改动

### 1. [src/runtime/subagent-delegator.ts](../../../src/runtime/subagent-delegator.ts) `fireOnTaskTerminal`

重排为:**terminal bookkeeping(无条件)→ memory 保留(按接线)**。

```
fireOnTaskTerminal(taskId, status):
  row = config.db?.getDelegatedTask(taskId)
  if (!row?.sessionId) return              // 无子 session,无事可做
  childSessionId = row.sessionId
  childAgentId = row.targetAgentId
  childModelId = row.modelId
  // ① terminal bookkeeping —— 只需 db,无条件执行(零遗留不依赖接线)
  config.db?.markArchivedTransient(childSessionId)   // idempotent;自愈检查点
  config.db?.deleteDelegatedTask(taskId)             // 立即删行,不再 re-seed
  // ② memory 保留 —— best-effort,按接线 fire(未接线则靠 recovery 重 export,丢 memory turn)
  if (this.onTaskTerminal) {
    try { ret = this.onTaskTerminal(taskId, status, childSessionId, childAgentId, childModelId)
          if (Promise) void ret.catch(log+swallow)
    } catch (log+swallow)
  }
```

- 关键不变式:**① 在 ② 之前同步完成**。即便 ② 的 archive 异步段从未跑/崩,① 已留 mark → recovery 兜底。
- `markArchivedTransient` + `deleteDelegatedTask` 都是已存在 db 方法(复用,无 schema 改)。
- `killed` 路径不动(不进 fireOnTaskTerminal;行删由 `abandonTask`/`acknowledgeTask` 已覆盖)。

### 2. 回调签名加宽(透传 agent/model,不再回读行)

行已在 ① 删除,② 的归档不能再 `getDelegatedTask` 回读。把 agent/model 透传:

- [src/runtime/types.ts:659](../../../src/runtime/types.ts#L659) `SessionConfig.archiveDelegatedSession`:
  `(taskId, status, childSessionId, childAgentId?, childModelId?) => ...`
- [src/runtime/subagent-delegator.ts:137](../../../src/runtime/subagent-delegator.ts#L137) `SubagentDelegatorDeps.onTaskTerminal`:同上加宽。
- [src/server/agent-service.ts:979](../../../src/server/agent-service.ts#L979) `archiveDelegatedSession(taskId, childSessionId, childAgentId?, childModelId?)`:用入参替代 [L987-989](../../../src/server/agent-service.ts#L987-L989) 的 `getDelegatedTask` 回读。

### 3. 注释更新

[fireOnTaskTerminal 注释 L253-258](../../../src/runtime/subagent-delegator.ts#L253-L258) 现自相矛盾(「cron/main 不 set onTaskTerminal」vs「dispatches sub-agents DOES archive」)——改成准确描述:① bookkeeping 无条件;② archive 按 onTaskTerminal 接线(sub-2 让所有派发 loop 都接)。

## 不做(out of scope)

- sendProjectPrompt 漏接 `archiveDelegatedSession` → **sub-2** 收口。
- 父归档级联子 session → **sub-3**。
- 存量孤儿 sweep → **sub-4**。

## 风险

- **行删除后 TaskGet**:用户已 get 过结果;行删后 TaskGet 返回 not-found(或从 registry 读)。registry 仍持有 TaskInfo 直到 acknowledge/cleanup-TTL。可接受(终态 task 不必跨重启留在 UI)。
- **mark 与管线重复 mark**:管线 ② 也调 markArchivedTransient,idempotent,no-op。无冲突。
