# sub-8:归档管线(delegated 自动 / chat UI)

## 范围
归档管线:末次 Extractor A 压缩 → 导出 JSON → 删库 → wiki 记忆留存。触发:delegated 子 agent 完成自动;cron/main 父不自动;chat 走现有 UI 按钮。

## 依赖
sub-7(末次压缩 = Extractor A)。

## 改动点
- 归档管线函数:① 末次 Extractor A 压缩(残留 step 抽进 wiki)② 导出 JSON(sessions 行 + steps + messages 全量)③ 删库(sessions/steps/messages 行 + **`tool_executions`/`delegated_tasks` 孤儿**,全 `WHERE session_id`)④ wiki 节点不删。
- **活跃 session runtime teardown**:chat 手动归档一个仍在跑的 session 时,先停该 session 的 agent-loop / 注销 session handle / 清 in-memory 状态(SessionDB/turn-seq-tracker),再删库。delegated 自动归档天然是完成态,无需额外 teardown。
- JSON:`~/.zero-core/archives/<agentId>/<sessionId>.json`,plain JSON。
- **delegated 自动触发**:`src/runtime/subagent-delegator.ts` 任务完成(`delegated_tasks → completed/failed`)→ 调归档管线。
- **chat 手动**:接现有 chat UI 归档按钮(已有,接管线即可,无新增 UI)。
- **cron/main 不自动归档**。
- **不做归档恢复**:archive JSON 只留档,无 restore 通路(不建 UI/IPC/命令读回)。

## 关键不变量
- wiki 记忆跨 session,归档只删 session 自有内容(sessions/steps/messages 行),记忆节点留存。
- DB 只装 active session。

## 参考
design.md「归档」。
