# acceptance-3:父归档级联

> 据 [sub-3.md](./sub-3.md) 独立验收。

## 单元/集成测试(real SessionDB + AgentService)

1. **父归档级联终态子**:seed 父 session + 父派发 2 个子任务(session_id 各异,子 session 行存在)+ 子已 completed。触发父归档(chat 风格)。断言:
   - 两个子 session 行消失(archive deleteSessionData 跑过)或 archives JSON 落盘。
   - 两个 delegated_tasks 行删除。
   - 父 session 归档完成。
2. **父归档级联运行中子**:seed 父 + 1 个 running 子任务(子 loop 活跃 mock)。触发父归档。断言:
   - 子 loop 被 teardown(stopAgentLoop 调用)。
   - 子 session 归档(archive 路径跑过,非 kill 路径)。
   - **不**经过 delegator kill(killed 状态不出现)。
3. **递归孙子层**:父 → 子 → 孙(孙 session 行存在,子任务派发)。父归档 → 断言孙 session 也归档(递归 archiveChildrenOf 触达)。
4. **无子 session 的任务行仍清**:子任务 row.sessionId 为空 → 父归档时该行被 deleteDelegatedTask 清(不卡)。
5. **并发撞锁 benign**:子 session 已在被归档(自身 terminal 触发中)→ cascade 再调 → withArchiveLock 返 skipped,不抛、不 double-archive、不重复 export JSON。
6. **killed 语义不变**:手动 kill 一个子任务 → 其 status=killed,**不**被 fireOnTaskTerminal 归档(killed 仍 abandoned)。父归档时该 killed 子若仍有 sessionId → 由 cascade 直接 archive(本 sub 覆盖)。
7. **idempotent**:对已归档的父再调 archiveChildrenOf → no-op(list 空 / 行已删),不抛。

## 源码断言

8. `archiveChildrenOf` 存在,按 `{parentSessionId}` list。
9. archiveDelegatedSession 与 chat 手动归档入口都调 archiveChildrenOf(或 archiveOneSessionCascade)。
10. cascade 路径**不**调 delegator kill / stopTask(直接 archiveSession)。

## 回归

11. 既有 archive 流测试(sub1-archive-nonblocking、sub4-archive-flow、memory-archive-fixes)不回归。
12. `npm run build:lib`(tsc)类型绿。
