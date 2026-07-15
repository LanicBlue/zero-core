# sub-4:cleanup-TTL 安全网 + 存量孤儿 sweep(D4 / D5)

- **决策**:D4 = 保留 cleanup-TTL 作安全网(idempotent);D5 = 加启动 sweep 清存量孤儿
- **依赖**:sub-1/2/3 已落地(保证零新增遗留);本 sub 只清「修管线前累积、行已不在、sessions 表识别不出是委托子」的存量
- **关联**:[design.md §D4 §D5](./design.md)

## D4:cleanup-TTL 定性(基本无代码改动)

[sub-2 cleanup()](../../../src/runtime/subagent-delegator.ts) / [task-registry cleanup()](../../../src/runtime/task-registry.ts#L352):sub-1 落地后,终态行在 terminal 已立即删 → cleanup 的 `deleteDelegatedTask` 调用变 idempotent no-op。**保留**:
- registry 内存侧 aging(防 TaskInfo 内存膨胀)仍有用,与 DB 无关。
- DB 删段留作安全网(万一某路径漏删 terminal 行)。
- 改动:加注释说明「primary 删除在 sub-1 terminal;此处为安全网,idempotent」。无逻辑改。

## D5:启动 sweep 清存量孤儿

### 问题

存量孤儿 = 修管线前累积的 session:其 `delegated_tasks` 行已(手清)不在、但 session 行(`sessions`/`steps`/`messages`)还在,且 **sessions 表无 parent 链接、无 `archived` mark** → `recoverInterruptedArchives`(只扫 archived=1)发现不了。

### 改动:[src/server/archive-service.ts](../../../src/server/archive-service.ts) 新增 `sweepOrphanSessions`

```
export async function sweepOrphanSessions(db, opts?: { maxAgeDays?: number }): Promise<number> {
  const maxAgeDays = opts?.maxAgeDays ?? 14;          // 保守默认
  const cutoff = isoOf(now - maxAgeDays days);
  // 候选:非 main、未 archived、超期、且非任何 active agent 当前 session
  const orphans = db.listSessions({ isMain: false, archived: false, olderThan: cutoff, excludeActive: true });
  let n = 0;
  for (const row of orphans) {
    try {
      // 先 export JSON 留档(防误判丢数据),再删 DB 行
      exportArchiveJson(row);                          // 复用 buildArchivePayload + writeArchiveJsonAtomic
      db.deleteSessionData(row.id);
      n++;
    } catch (err) { log.warn("archive", `sweep: ${row.id} failed, skip:`, err); }
  }
  return n;
}
```

- 挂载点:[index.ts](../../../src/server) 启动,`recoverInterruptedArchives(db)` **之后**调 `sweepOrphanSessions(db)`。
- **保守**:`maxAgeDays=14` 默认;`excludeActive` 排除任何 agent 当前 activeSessions 里的 session;export-before-delete 防误判。
- 启发式不精确(is_main=0 也含合法非 main session),但:① 阈值保守(14 天);② export 留档可恢复;③ 一次性清存量,sub-1/2/3 后无新增。

### listSessions 查询

[session-db.ts](../../../src/server/session-db.ts) 加 `listSessions({isMain, archived, olderThan, excludeActive})`(或扩展现有 list)。新列无;只用现有 `is_main`/`archived`/`updated_at`。`excludeActive` 由 caller 传 active sessionId 集合过滤(archive-service 不持有 active 集合 → index.ts/agent-service 注入)。

## 不做(out of scope)

- 给 sessions 加 `parent_session_id`/`delegated` 列(precise 识别)——可选未来改进;本 sub 启发式够清存量。如要 precise,另开 sub(含 schema + db-migration *_COLUMNS 同步,见 [[feedback-fresh-db-migrations]])。
- archives 轮转 / 上限 / restore 通路(仍 deferred)。

## 验证要点

- sweep 不动 active session(任何 agent 当前 session 不被清)。
- sweep 不动 main session(is_main=1)。
- export-before-delete:被清 session 的 JSON 落盘 `~/.zero-core/archives/<agentId>/<id>.json`。
- 启动顺序:migrations → stores → recoverInterruptedArchives → sweepOrphanSessions。
