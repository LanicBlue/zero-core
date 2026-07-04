# plan-N2 — UI 推送驱动 + 消闪烁 + 重连 resync

> 节点 N2(依赖 N1)。目标:UI 全部改成"只读真源 + 推送喂养 + 零轮询";消除闪烁;WS 重连 resync。对应 design §3.3、§3.4、§7。

## 范围
- task/queue store:ping→可见时拉,移除 setInterval。
- mcp/metrics/execution/kanban:改读真源(单消费者→组件本地缓存 + 订阅),移除 setInterval 与 api 直查。
- 渲染横切(消闪烁):选择器订阅、`React.memo` 行、稳定 key、loading 不 gate 内容、稳引用。
- 重连 resync:新增 main→renderer `ws:reconnected` 信号,renderer 收到重拉可见 collection。

## 实现步骤
1. **task/queue store(通道不同,分开接)**:[src/renderer/store/task-store.ts](../../../src/renderer/store/task-store.ts) / [input-queue-store.ts](../../../src/renderer/store/input-queue-store.ts)
   - **task-store → `onAgentEvent`**:TaskRegistry 在 runtime 层,ping 走 agent:event。模块加载一次 `api().onAgentEvent((e)=>…)`,过滤 `e.type==="runtime:tasks:changed"`,仅当 `e.sessionId` 在 `watched` 集合时 `pull(e.sessionId)`。
   - **input-queue-store → `onDataChanged`**:InputQueueStore 在 server 层,ping 走 hub。模块加载一次 `api().onDataChanged((e)=>…)`,过滤 `e.collection==="runtime:input-queue"`,仅当该 sessionId 在 `watched` 时 `pull`。
   - 两者 `startPolling`→`startWatching`:立即 pull 一次 + 加入 watched;`stopWatching` 移除。**移除 setInterval,无兜底**(靠重连 resync + pull-on-display)。
2. **单消费者面改本地缓存 + 订阅(通道按来源)**:
   - [McpSettingsPage.tsx](../../../src/renderer/components/mcp/McpSettingsPage.tsx):本地 state,挂载拉一次 + `onDataChanged` 过滤 `runtime:mcp` 更新;移除 10s setInterval。
   - [DashboardPage.tsx](../../../src/renderer/components/dashboard/DashboardPage.tsx):本地 state + `onDataChanged` 过滤 `runtime:metrics`;移除 2s setInterval。
   - [ExecutionDetailPanel.tsx](../../../src/renderer/components/requirements/ExecutionDetailPanel.tsx):本地 state,打开 req 拉一次 + `onDataChanged` 过滤 `task_steps`/`requirement_messages`(命中本 req 才更新);移除 5s setInterval。
   - [KanbanBoard.tsx](../../../src/renderer/components/requirements/KanbanBoard.tsx):本地 state + `onDataChanged` 过滤 `orchestrate_plans` 与 `runtime:orchestrate`;移除 5s setInterval。
3. **会话列表**:[ChatPanel.tsx](../../../src/renderer/components/layout/ChatPanel.tsx)(持有 `sessionsList` 拉取,~L395/413/441/598)改用 `subscribeListDataChange("sessions", …)`(镜像 [agent-store.ts:135](../../../src/renderer/store/agent-store.ts#L135))→ 后台建会话立刻出现。
4. **渲染横切(消闪烁)**:
   - 选择器订阅替全仓 `useStore()`:[TaskTreePanel.tsx](../../../src/renderer/components/layout/TaskTreePanel.tsx) 按 active session 切片订阅;[AgentEditor.tsx](../../../src/renderer/components/agents/AgentEditor.tsx) `useAgentStore()` → 选择器。
   - 行组件抽 `React.memo`(浅比较):task 卡片、kanban 卡片、execution 步骤行。
   - 稳定 key 复核(已用 id)。
   - loading 不 gate 内容:[WikiAnchorsSection.tsx](../../../src/renderer/components/agents/WikiAnchorsSection.tsx) `list = form.wikiAnchors ?? EMPTY`(模块级常量稳引用);刷新期保留上次 preview,token 行不摘,"refreshing" 改不占位小圆点。
   - 通用原则:刷新期始终渲染上次数据,loading 只做轻量指示。
5. **重连 resync**:
   - [src/main/ipc-proxy.ts](../../../src/main/ipc-proxy.ts) `_ws.on("close")` 重连成功后(`_ws.on("open")` 或 connect() 内新 ws open)→ `win.webContents.send("ws:reconnected")`。
   - [src/preload/index.ts](../../../src/preload/index.ts) 暴露 `onWsReconnected(cb)`。
   - renderer(各 store 或 AppLayout 集中):收到 → 把当前可见 collection 各 pull 一次。

## 关键文件
`task-store.ts` · `input-queue-store.ts` · `McpSettingsPage.tsx` · `DashboardPage.tsx` · `ExecutionDetailPanel.tsx` · `KanbanBoard.tsx` · `TaskTreePanel.tsx` · `WikiAnchorsSection.tsx` · `AgentEditor.tsx` · `ipc-proxy.ts` · `preload/index.ts` · `AppLayout.tsx`(或集中重连处理)

## 不做(留其他节点)
- 状态流基建(emit/桥/白名单)→ N1(本节点依赖)。
- 文件系统面 → N3。
- 配置字段热更 → N4。

## 风险
- pull-on-display 与推送竞态:切换时旧 push 可能覆盖新 pull。每个新本地缓存/store 加护栏(pull 发出后丢弃早于 pull 的事件,或拉取后用版本号/时间戳判定)。
- `ws:reconnected` 首次连接不要误触发重拉(只在 close→reconnect 后触发,初始连接走 app:ready)。
- ChatPanel 内联渲染不动(830 行 tab/CRLF),message-blocks.tsx 是新视图规范。
