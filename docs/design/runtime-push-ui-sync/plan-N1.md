# plan-N1 — 统一状态流基建

> 节点 N1(基石,无依赖)。目标:让所有状态类数据(DB 表 + 运行时对象)走**同一条** `data-change-hub → data:changed` 流。对应 design §3.1、§7。
> 验收见 [acceptance-N1.md](acceptance-N1.md)。

## 范围
- 修 `data:changed` 转发桥(丢 `changes` 的 bug)。
- 运行时对象(TaskRegistry / MCPManager / SessionManager.metrics / ConfirmRegistry)接同一 hub,用虚拟 collection 名 + 统一 coalesce。
- InputQueueStore 现有 emit 适配成 hub 形状。
- 扩白名单 `UI_COLLECTIONS`(含 `sessions` + 各 `runtime:*` 虚拟名 + 遥测表)。
- SessionDB 三个结构性原语(create/delete/archive)显式 emit;高频 UPDATE 不 emit。

## 实现步骤
1. **修桥**:[src/server/index.ts](../../../src/server/index.ts) `onDataChange` 转发补 `changes: e.changes`。(下游 [ipc-proxy.ts](../../../src/main/ipc-proxy.ts) 的 `data:changed` 分支、[preload onDataChanged](../../../src/preload/index.ts) 已透传 `changes`,只差这一行。)
2. **TaskRegistry coalesced emit**:[src/runtime/task-registry.ts](../../../src/runtime/task-registry.ts) 加 `changeListeners` Set + `subscribe(cb)` + `private scheduleChange()`(`setTimeout(flush,0)` 批处理,镜像 hub coalesce)。在 `create / updateProgress / addUsage / requestFinish / complete / fail / kill / acknowledge / seed / cleanup` 末尾调 `scheduleChange()`。保持 TaskRegistry 不感知 sessionId。
3. **TaskRegistry → agent:event(已定案,不走 hub)**:[src/runtime/agent-loop.ts](../../../src/runtime/agent-loop.ts) 构造时 `this.delegator.taskRegistry.subscribe(() => this.emit({ type: "runtime:tasks:changed", sessionId: this.sessionId }))`。
   - **理由(层级)**:TaskRegistry 在 `src/runtime/`,hub(`emitDataChange`)在 `src/server/`,runtime 不能反向 import server。agent:event 是 runtime 层既有通道(chat 流也走它),TaskRegistry 经 AgentLoop.emit 发 `runtime:tasks:changed`,无 server 依赖。
   - **payload**:ping 形态,带 `sessionId`;前端(N2)收到即按 active session pull 整棵 task 树。
4. **MCPManager emit**:[src/server/mcp-manager.ts](../../../src/server/mcp-manager.ts) 加 listeners + `subscribe(cb)` + `emit()`;连接/断开/错误点触发。index.ts 接 `mcpManager.subscribe(() => broadcast({type:"runtime:mcp:changed"}))`。
5. **SessionManager.metrics emit**:[src/server/session-manager.ts](../../../src/server/session-manager.ts) 计数器变更点 coalesced emit;index.ts 接 `runtime:metrics:changed`。
6. **ConfirmRegistry emit**:[src/server/orchestrate-store.ts](../../../src/server/orchestrate-store.ts) ConfirmRegistry 加 emit/subscribe;index.ts 接 `runtime:orchestrate:changed`。
7. **InputQueueStore 适配**:[src/server/input-queue-store.ts](../../../src/server/input-queue-store.ts) 现有 `emit(sessionId)` 发 `{sessionId, items}` 快照;在 emit 里**转调** `emitDataChange("runtime:input-queue", sessionId, "update", items)`(或 index.ts 订阅它的 subscribe 再转)。非零成本,需适配。
8. **扩白名单**:[src/server/data-change-hub.ts](../../../src/server/data-change-hub.ts) `UI_COLLECTIONS` 加 `orchestrate_plans` / `task_steps` / `requirement_messages` / `sessions` + server 层 runtime 虚拟名(`runtime:mcp` / `runtime:metrics` / `runtime:input-queue` / `runtime:orchestrate`)。**`runtime:tasks` 不进白名单**(它走 agent:event,不经 hub)。
9. **SessionDB 显式 emit**:[src/server/session-db.ts](../../../src/server/session-db.ts) `createSession` / `deleteSession` / `archiveSession` 三个原语调 `emitDataChange("sessions", id, op, record)`。**高频 UPDATE(updated_at/token/context/setMain 等)不 emit。**

## 关键文件
`index.ts` · `data-change-hub.ts` · `task-registry.ts` · `agent-loop.ts` · `mcp-manager.ts` · `session-manager.ts` · `orchestrate-store.ts` · `input-queue-store.ts` · `session-db.ts`

## 不做(留其他节点)
- UI 侧改造(去轮询、接推送)→ N2。
- 渲染横切(消闪烁)→ N2。
- 重连 resync 信号 → N2。
- 文件系统 → N3;配置字段热更 → N4。

## 风险
- TaskRegistry coalesce 必须做(否则 updateProgress/addUsage ping 风暴)。
- SessionDB emit 只挂结构性原语,误挂高频 UPDATE 会刷屏。
- 步骤 3 task ping 走 agent:event 还是 hub,需与 N2 前端接法一致(实现时定,文档两侧对齐)。
