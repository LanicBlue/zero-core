# acceptance-N1 — 统一状态流基建 · 测试要求

> 节点 N1 验收。对应 [plan-N1.md](plan-N1.md)。

## 完成判定
所有状态(DB 表写 + 运行时对象变更)都能经 `data-change-hub` 发出带 `changes` 的 `data:changed`(或等价 runtime ping),且 coalesce 正确、不刷屏。

## 单元测试(vitest)
1. **桥转发**:模拟 `emitDataChange` → hub flush → 广播事件形如 `{type:"data:changed", collection, changes:[{id,op,record?}]}`(含 `changes`,非 undefined)。
2. **TaskRegistry coalesce**:
   - `create`/`complete`/`acknowledge` 后 `subscribe` 回调被调用。
   - 连续 `updateProgress` N 次(同 tick)→ 回调只触发 1 次。
3. **TaskRegistry 不感知 sessionId**:回调不带 sessionId(由 AgentLoop 转译)。
4. **SessionDB emit**:
   - `createSession` → `emitDataChange("sessions", id, "create", record)` 被调。
   - `deleteSession` → op="delete"。
   - `archiveSession` → op="update",record.archived=true。
   - `updateUpdatedAt`/token UPDATE → **不**触发 emit(可用 spy 断言未调)。
5. **InputQueueStore 适配**:`enqueue` → 触发 `emitDataChange("runtime:input-queue", sessionId, "update", items)`(经适配层)。
6. **MCPManager / SessionManager.metrics / ConfirmRegistry emit**:各自变更点触发对应 subscribe 回调(模拟连接/计数器/confirm 态变更)。
7. **白名单**:`emitDataChange("non_whitelisted", …)` 不发事件;新加的 collection 名都生效。

## 集成测试
- 后端 `emitDataChange` → index.ts broadcast →(模拟 WS client)收到 `{collection, changes}` 完整 payload。
- ipc-proxy 透传 `changes`(不丢)。

## 手动验证
- 改一条 agent 配置 → renderer network/日志可见 `data:changed {collection:"agents", changes:[…]}` 带 record。
- 后台建一个 session(如触发 cron)→ `data:changed {collection:"sessions",…}` 发出。

## 回归
- 现有 data-change-hub / SqliteStore 用例全绿。
- 不破坏既有 agent/project/cron/requirement/wiki store 的 subscribeListDataChange(桥修好后它们应开始真正收到 patch——可作为正向回归)。

## 不在本节点
- UI 是否真正更新(→ N2 验收)。
- 闪烁(→ N2)。
