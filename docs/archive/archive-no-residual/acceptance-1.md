# acceptance-1:terminal 解耦删行 + 同步打 mark

> 独立验收清单(verify agent 据 [sub-1.md](./sub-1.md) 写测试,不信任 implementer 自述)。

## 单元测试(real SessionDB on temp file + real SubagentDelegator)

1. **completed → 行立即删 + 子 session 打 mark**:seed 一条 delegated_tasks(status=running,sessionId=child-X)+ 子 session 行。delegator `complete(taskId, result)` 触发 fireOnTaskTerminal。断言:
   - `db.getDelegatedTask(taskId)` === undefined(行已删)。
   - 子 session `archived === 1`(`getSession(child-X).archived` 或等价查询)。
2. **failed 同上**:`fail(taskId, err)` → 行删 + mark。
3. **killed 不走此路径**:`kill(taskId)` → 行**不**被 fireOnTaskTerminal 删(killed 由 abandonTask/acknowledgeTask 管;本 sub 不动)。
4. **无子 session 早退**:row.sessionId 为空 → 不抛、不 mark、不删。
5. **memory 保留按接线**:onTaskTerminal 已接 → 被调用一次,入参含 `(taskId, status, childSessionId, childAgentId, childModelId)`;未接(db-only delegator)→ 不抛,行仍删、mark 仍打(① 无条件)。
6. **回调不回读行**:mock archiveDelegatedSession,断言它**没有**调 `getDelegatedTask`(行已在调用前删,agent/model 由入参透传)。
7. **mark 幂等**:fireOnTaskTerminal 后再调 `markArchivedTransient(child)` 不报错、仍 archived=1。
8. **fire-and-forget 不抛穿**:onTaskTerminal reject / throw → fireOnTaskTerminal 不抛、不阻断后续(① 已完成)。

## 源码断言

9. `archiveDelegatedSession` 方法体 + `SessionConfig.archiveDelegatedSession` / `onTaskTerminal` 类型签名:含 `childAgentId?` / `childModelId?` 参数。
10. `fireOnTaskTerminal` 内 `markArchivedTransient` + `deleteDelegatedTask` 调用在 `onTaskTerminal` 调用**之前**(grep 顺序 / 读源码确认)。
11. `archiveDelegatedSession` 不再 `getDelegatedTask` 回读(改用入参)。

## 回归

12. 既有 task / registry / delegator 测试套件全绿(尤其 sub4-tool-quality-pass、task-cleanup-db 不回归)。
13. `npm run build:lib`(tsc)类型绿。
