# sub-3:父归档级联 `archiveChildrenOf`(D3)

- **决策**:D3 = 父归档时**直接 archive 子 session**(不走 kill),孙子层递归
- **依赖**:sub-1(mark/删行)、sub-2(接线)已落地,terminal 子 session 多已自归档;本 sub 补「父归档时仍在跑/未归档的子」
- **关联**:[design.md §D3](./design.md)

## 目标

父 session 归档(chat 手动 / delegated 子自身归档)时,它派发的子任务对应的子 session 一并归档(递归孙子层),零孤儿。

**为什么直接 archive 不走 kill**:[delegator:250](../../../src/runtime/subagent-delegator.ts#L250) `killed` 被排除出 `fireOnTaskTerminal`(killed=abandoned、不归档)。kill→terminal 不会归档子 session,反造孤儿。故父归档直接调归档路径。

## 改动

### 1. [src/server/agent-service.ts](../../../src/server/agent-service.ts) 新增 `archiveChildrenOf`

```
private async archiveChildrenOf(parentSessionId: string): Promise<void> {
  const children = this.db.listDelegatedTasks({ parentSessionId });
  for (const child of children) {
    if (!child.sessionId) { this.db.deleteDelegatedTask(child.id); continue; }
    // 递归:archive 子 session(其入口又调 archiveChildrenOf → 孙子层)
    await this.archiveOneSessionCascade(child.sessionId, child.targetAgentId, child.modelId);
    this.db.deleteDelegatedTask(child.id);  // belt-and-suspenders(sub-1 终态的早删了)
  }
}
```

### 2. 统一入口 `archiveOneSessionCascade(sessionId, agentId?, modelId?)`

按子 session 是否仍有活跃 loop 选路径(复用现有机制):

- **活跃 loop**(`this.loops.has(sessionId)`):chat-manual 风格——`archiveSession(sid, db, { memoryTurnRunner: 活跃 loop 上跑 ephemeral, teardown: {stopAgentLoop, clearHookState} })`。teardown 复用 `evictSessionFromMemory` + clearHookState。
- **无活跃 loop**(已终态):delegated 风格——`buildSessionConfigForArchive` + memory turn(若 neverCompressed)→ `archiveSession(sid, db, {memoryTurnRunner})`。即现有 `archiveDelegatedSession` 的管线,抽成可按 sessionId 复用。
- 入口先 `await this.archiveChildrenOf(sessionId)`(递归),再跑自身 archive。

### 3. 两个现有入口改走 cascade

- [archiveDelegatedSession:979](../../../src/server/agent-service.ts#L979)(terminal 子归档):入口加 `await this.archiveChildrenOf(childSessionId)`(孙子层)再跑自身。或直接改为调 `archiveOneSessionCascade`。
- chat 手动归档路径([archiveSessionInBackground](../../../src/server/agent-service.ts)):入口加 `await this.archiveChildrenOf(sessionId)` 再 teardown+archive 自身。

### 4. 并发保护

复用 archive-service 的 per-session `withArchiveLock`:若子 session 已在被归档(如自己的 terminal 已触发),cascade 的调用撞锁 → `skipped: already-archiving`(benign,holder 会完成)。无需新锁。

## 不做(out of scope)

- kill 语义改动(killed 仍 = abandoned,不归档)。
- archive JSON 格式 / restore 通路。
- 跨 root_task_id 的非直系清理(只按 parent_session_id 直系递归)。

## 风险

- **深递归**:委托树深度 = 递归深度。实际委托链浅(2~3 层);withArchiveLock 防同 session 重复;无环(sessionId 单调派生,不会成环)。
- **活跃子 loop teardown 阻塞**:teardown best-effort、MUST NOT throw(现有契约);卡住的 loop 不阻断父归档。
- **listDelegatedTasks 查询**:`session-db.ts:1708` 已支持 `{parentSessionId}`,无需新查询。
