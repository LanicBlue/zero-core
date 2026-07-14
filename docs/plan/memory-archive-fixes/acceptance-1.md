# Acceptance-1:归档非阻塞化

> 对应 [sub-1.md](./sub-1.md)。verifier 按此写测试,独立判定 PASS/FAIL。证据引用测试输出,不采信 implementer 自述。

## 验收项

1. **归档响应即时**:POST archive 请求在 < 500ms 内返回 `{ success, newSessionId }`(不含 LLM 调用)。测试:mock provider 延迟 2s,断言响应先于 provider resolve 返回。
2. **新 session 立即可用**:响应返回的 newSessionId 是 main session(`db.getMainSession(agentId).id === newSessionId`),可 recreateLoop 路由。
3. **旧 session 后台清理**:响应返回 N 秒后(或 await 后台 promise),旧 session 行从 DB 删除(`db.getSession(oldId)` === null),archive JSON 落 `~/.zero-core/archives/<agentId>/<oldId>.json`。
4. **memory turn 用 temp loop**:旧活跃 loop 在同步段被 evict(`agentService.evictSessionFromMemory` 调用后 loops map 无 oldId),后台 memory turn 仍完成 + 写 wiki(temp loop 从持久化 steps 重建)。
5. **后台失败不冒到前台**:后台 archive 抛错(模拟 export rename 失败)→ HTTP 仍 200;log.warn 记录;旧行仍在且 archived=1。
6. **崩溃恢复兜底**:mark 后、export 前模拟进程退出 → 重启 `recoverInterruptedArchives` 重 export + 删行(既有逻辑,本 sub 不破坏)。
7. **并发同 session 归档**:两次并发 archive 同 sessionId → per-session 锁,第二个返回 skipped(archivePath 空),不 double-delete。
8. **delegated 路径不破**:子 agent task terminal → archiveDelegatedSession 仍 fire-and-forget 正常(本 sub 不动它,回归测试)。

## 测试形态
- 单元:mock SessionDB + mock AgentLoop(记录 evict/run 调用),验时序 + 状态。
- 回归:既有 sub4-archive-flow.test.ts 全绿。

## 反例(必须不成立)
- ❌ HTTP 响应等待 memory turn LLM 完成(阻塞)。
- ❌ 后台 archive 失败导致前台 500。
- ❌ evict 旧 loop 后 memory turn 无 loop 可跑(wiki 不写)。
