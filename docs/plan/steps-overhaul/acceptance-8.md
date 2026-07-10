# acceptance-8:归档管线

## 验收清单
- [ ] 管线:末次 Extractor A 压缩 → 导出 JSON → 删库 → wiki 记忆留存。
- [ ] JSON 落盘 `~/.zero-core/archives/<agentId>/<sessionId>.json`(plain JSON,含 sessions 行 + steps + messages)。
- [ ] delegated 子 agent 完成(`delegated_tasks → completed/failed`)→ 自动归档。
- [ ] cron/main 父 agent 不自动归档。
- [ ] chat UI 归档按钮(现有)接管线,手动归档成功。
- [ ] 归档后:DB 无该 session 的 sessions/steps/messages 行;**`tool_executions`/`delegated_tasks` 该 session_id 的行也清**(无孤儿);wiki 节点仍在。
- [ ] chat 手动归档活跃 session:agent-loop 停 / handle 注销 / in-memory 状态清,再删库(无悬挂 runtime)。
- [ ] **不做归档恢复**:无 restore UI/IPC(验证确实没建)。
- [ ] 三层 tsc + vitest。

## 怎么验
跑 delegated 子任务到完成,检查 JSON 落盘 + DB 删除 + wiki 留存;手动点 chat 归档按钮。
