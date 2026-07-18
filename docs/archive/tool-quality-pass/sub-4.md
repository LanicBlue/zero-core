# sub-4 Task:#1 acknowledge 删 DB 行 + #10 list 汇总

> 对应 design:[`./design.md`](./design.md) #1 #10。范围:`src/server/session-db.ts`、`src/runtime/subagent-delegator.ts`、`src/tools/task-tool.ts`。

## #1 acknowledge 必须删 DB 行(根因见 design #1)

**根因**:`Task get`→acknowledge→[registry.delete](../../../src/runtime/task-registry.ts#L178) 只清内存,不删 `delegated_tasks` DB 行。完成行因归档 async/skip 持续存在 → 新 turn loop 重建 → [restoreDelegatedTasks](../../../src/server/agent-service.ts#L1424) re-seed → task 复活("get后消失，新turn后又出现")。

**做法**:
1. `session-db.ts` 加方法:
   ```ts
   deleteDelegatedTask(taskId: string): void {
     this.db.prepare("DELETE FROM delegated_tasks WHERE id = ?").run(taskId);
   }
   ```
   **无 schema 变更、无 migration**(不改 db-migration.ts 的 COLUMNS 数组)。
2. [delegator.acknowledgeTask](../../../src/runtime/subagent-delegator.ts#L612)(Task get 走):`registry.acknowledge` 返 true 后,调 `this.config.db?.deleteDelegatedTask?.(taskId)`。用 ?. 容错(测试 stub 无 db 时 no-op)。
3. [abandonTask](../../../src/runtime/subagent-delegator.ts#L560)(TaskKill interrupted→abandon 走):它现在 `updateDelegatedTask(killed)` + `registry.acknowledge`。改为 acknowledge 后也 `deleteDelegatedTask`(行不再留 killed 状态招 re-seed)。

## #10 Task list 汇总

**现状**:[list L289](../../../src/tools/task-tool.ts#L289) 末尾 `Total: X tasks, Y running`,无 token/耗时聚合。

**做法**:[list action](../../../src/tools/task-tool.ts#L242) 末尾(在现有 `Total:` 行后或替换)加聚合行:
```
Summary: N tasks | tokens <总 tokens> | elapsed <总 elapsed>s (running <R>, max <最长单 task elapsed>s)
```
- 总 tokens = 所有 tasks tokens 求和。
- 总 elapsed = 各 task elapsed(completed 用 completedAt-startedAt,running 用 now-startedAt)求和。
- max = 单个 task 最长 elapsed。
- 不加参数,默认总有(信息密度高,agent 多一行无负担)。

## 不在范围

- 不改 get/kill/finish/resume 行为(除 acknowledge 副作用)。
- 不加 acknowledged 列(已否决)。
- 不改归档逻辑(归档仍 async,acknowledge 删行后归档 DELETE 是 no-op,安全)。

## 注意(memory 陷阱)

- feedback-fresh-db-migrations:**没加列**,所以**不要**动 db-migration.ts COLUMNS(动了反而错)。
- feedback-sqlite-store-update-semantics / TEXT 亲和:本 sub 只 DELETE,不碰数值列,无关。
- 删行后,restoreDelegatedTasks 自然 re-seed 不到(它从 DB 读);不需改 restoreDelegatedTasks。

## 验收见 [`./acceptance-4.md`](./acceptance-4.md)
