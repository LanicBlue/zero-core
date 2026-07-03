# Design:运行时推送,UI 是窗口

> 状态:**Draft,讨论中**。
> 一句话:**UI 是运行时的展示窗口。** 由四条不变量定义,由"两类数据、各一套统一契约"实现。
> 关联代码:[data-change-hub.ts](../../../src/server/data-change-hub.ts)、[index.ts](../../../src/server/index.ts)、[agent-service.ts](../../../src/server/agent-service.ts)、[agent-loop.ts](../../../src/runtime/agent-loop.ts)、[AppLayout.tsx](../../../src/renderer/components/layout/AppLayout.tsx)。架构现状以 [`../../arch/`](../../arch/) 为准,本文是"为什么这么改 + 按什么顺序落地"。

---

## 1. 四条不变量(设计的锚)

设计只为满足这四条,其余都是实现细节:

1. **所见即所跑** —— UI 上看到的 = 运行中实际生效的。agent 是什么配置,UI 显示的就是运行时用的;不存在"配了没生效"或"生效没显示"的缝隙。UI 与运行时**读同一份真源**,改了两头同步。
2. **只更新变化部分** —— 数据没变就不重绘;只 patch 真正变化的那部分。无非必要刷新。
3. **运行时状态变 → UI 实时反应** —— 运行态(task 进度、会话 running、队列、MCP、metrics)一变,UI 立刻跟着变,不等轮询。
4. **架构统一、易扩展** —— 一套机制通吃,不东一块西一块;以后加新数据流也能照契约轻松接入。

## 2. 两类数据,各一套统一契约

UI 数据天然分两类,形态不同,各走一套**统一**契约。**不是"一个例外",是两类边界清晰。**

| 类 | 是什么 | 变更单位 | 频率 | 渲染语义 | 契约(通道) |
|---|---|---|---|---|---|
| **状态(record)** | 一条**已存在**的记录(agent / task / message / mcp 状态 / metrics…) | 整条 record(create/update/delete) | 低~中 | patch / 替换 | **统一状态流**(data-change-hub → `data:changed`) |
| **流(stream)** | 一条记录**正在生成**,逐块到达 | 子记录增量(token / thinking / 工具参数) | 高(每秒数十) | append 到进行中缓冲 | **增量流**(`agent:event`,按 session 路由) |

**为什么 chat token 流是"流"类、不是状态**:它不是"消息变了",是"消息还在长"。token 是 record 内部的字符增量,频率高,UI 要平滑 append 到气泡,而非每 tick 整条重绘。强行并进状态流要么每 token 重序列化整条 message(浪费),要么状态流得新增 `append/delta` op + 高频低延迟 coalesce——chat 流现在工作良好,不划算。两类边界:**"已存在的记录会变"→状态;"正在生成、逐块到"→流。**

> 将来若流类数据变多,可考虑把状态流升级成"支持 append 的超集流"合并;现在两类清晰即可。

## 3. 统一架构

### 3.1 状态类:一个中枢,通吃所有状态

所有状态类数据(不论背后是 DB 表还是内存运行时对象)都看成 **collection**,走**同一条变更流、同一个形状**:

```
{ collection, changes: [{ id, op: "create"|"update"|"delete", record? }] }   // coalesced
```

复用现成的 [data-change-hub](../../../src/server/data-change-hub.ts):
- **DB 表写** → SqliteStore 写原语 emit(已有)。
- **server 层运行时对象**(InputQueueStore / MCPManager / SessionManager.metrics / ConfirmRegistry)→ **调同一个 `emitDataChange`,用虚拟 collection 名**(`runtime:input-queue` / `runtime:mcp` / `runtime:metrics` / `runtime:orchestrate`)。hub 照样 coalesce + 转发。
- **runtime 层对象(TaskRegistry)→ `agent:event`**(不走 hub):TaskRegistry 在 `src/runtime/`,不能反向 import `src/server/` 的 hub;它经 AgentLoop.emit 发 `runtime:tasks:changed`(runtime 层既有通道,chat 流也走它)。

> **按层分、前端契约统一**:后端两层各用自己既有的统一通道(server→hub、runtime→agent:event),不是散装;**前端只认一种 `runtime:*` ping**,一律 ping→pull,不关心后端走哪条。

**runtime collection payload(已定案,ping→pull)**:
| collection | 通道 | id | record | 前端动作 |
|---|---|---|---|---|
| `runtime:tasks` | agent:event | — | —(带 sessionId) | 可见时 pull active session 整棵树 |
| `runtime:input-queue` | hub | sessionId | items(可选) | 可见时 pull |
| `runtime:mcp` | hub | "status" | 连接态快照(可选) | 可见时 pull |
| `runtime:metrics` | hub | "aggregate" | metrics 快照(可选) | 可见时 pull |
| `runtime:orchestrate` | hub | planId | plan(可选) | 可见时 pull |

统一原则:runtime collection **一律 ping→pull**(只发通知,前端可见时拉);record 可选(带了省一次拉)。避免运行时对象在 emit 里序列化大对象。

→ `data:changed`(hub)+ `agent:event`(runtime 层)两条 WS 通道 → renderer `onDataChanged` / `onAgentEvent` → 每个面用同一个订阅原语 → 收到 ping/changes 后 patch 或 pull 一次。

> **注**:runtime collection 的 ping 是全局广播(不带 session 路由),一个 session 的 task 变更会让别的 session 的可见 store 也 pull 一次(over-pull)。coalesced 且罕见,可接受;若日后敏感,再给 emit 带 sessionId 做客户端过滤。

### 3.2 流类:增量流(按 session)

chat 生成期的 token/thinking/工具参数流走 `agent:event`,**per-session 路由 + 切走断开**(已有,健康)。这是流类的统一契约。

### 3.3 渲染:一个模式

store(共享数据)或组件本地缓存(单消费者数据)→ **选择器订阅**(不全仓)→ **稳定 key + `React.memo`** → **刷新期保留旧值不空白**(loading 不 gate 内容)。

### 3.4 重连:renderer 驱动(无后端协议,需重连信号)

WS 重连 → renderer 把**当前可见的 collection** 各 pull 一次(等同重新 pull-on-display)。不需要后端 resync 协议。理由:renderer↔main 是 Electron IPC 几乎不断;只有 main↔backend 的 localhost WS 罕见断连(休眠/后端崩),而后端崩了是新进程、renderer 本来就得全量重拉——renderer 重拉可见面统一覆盖。

**实现依赖**:[connectEventBridge](../../../src/main/ipc-proxy.ts#L397) 已自动重连(close→2s 重连),但重连发生在 main,**renderer 察觉不到**。必须新增一个 main→renderer 的重连信号(如 `ws:reconnected` IPC),renderer 收到后重拉可见 collection。否则断连窗口丢的推送要等下次导航才补。

## 4. 全量数据归类

| UI 数据 | 类 | 真源 | 初始(pull-on-display) | 实时更新 | 备注 |
|---|---|---|---|---|---|
| chat token/thinking/工具参数流 | 流 | chat-store 进行中缓冲 | 切 session→sessionsGetInit | `agent:event` 增量 append | DB 持久化最终 message |
| 最终消息(record) | 状态 | messages 表 | 切 session 重建 | (生成期走流;完成后落库) | 高频,不入状态推送;冷读 pull |
| token 计数 / context 条 | 状态(经流喂养) | chat-store.contextInfo | session_init | `usage`/`message_end` | sessions/turns 累计落库 |
| agent / cron / requirement / project / wiki 配置 | 状态 | 各 renderer store(读 DB) | 页面打开拉一次 | `data:changed`→patch | 修桥后生效 |
| 会话列表(侧栏) | 状态 | session-store | 打开拉一次 | 建会话 emit + lifecycle | **SessionDB 不发 data:changed,需补 emit**(§7) |
| Task 树 | 状态 | TaskRegistry(内存);delegated_tasks 写穿 | loop seed + 可见 pull | `runtime:tasks`→pull | — |
| 输入队列 | 状态 | InputQueueStore(内存,已有 emit) | strip 可见 pull | `runtime:input-queue`→pull | 纯内存,重启丢 |
| MCP 连接态 | 状态 | MCPManager(内存) | 设置页打开 pull | `runtime:mcp`→pull | 需补 emit |
| Dashboard metrics | 状态 | SessionManager(内存) | dashboard 打开 pull | `runtime:metrics`→pull | 需补 emit |
| Kanban(pending + confirm) | 状态 | orchestrate_plans + ConfirmRegistry | 看板打开 pull | `data:changed` + `runtime:orchestrate` | 需补 ConfirmRegistry emit |
| ExecutionDetail(steps/messages) | 状态 | task_steps / requirement_messages | 打开 req pull | `data:changed` 命中本 req | — |
| Cron 下次触发 | 状态 | crons 表 | 打开 pull | `data:changed` | 显示绝对时间 |
| 文件树 / 日志 | (非运行时) | 文件系统 | 打开拉一次 | **不实时**:手动刷新 | 用户决定不上 fs watcher |

> **后台运行的非当前 session**:因流类按 session 路由 + 切走断开,后台 session 在 chat-store 里是 stale,切回才 pull-on-display 重建。所以"实时反应"严格讲对**当前可见 session** 成立;这是 disconnect-on-leave 的取舍,接受。

## 5. 四不变量怎么被保证(逐条)+ 现状缺口

### 不变量 1(所见即所跑)
**保证**:状态 collection 是唯一真源,UI 与运行时读同一个;配置改动**热加载到运行 loop**([agent-service.ts:216](../../../src/server/agent-service.ts#L216) `store.onChange`:loop 空闲重建,忙则 `applyConfigUpdate`),并经同一状态流推到 UI。
**现状缺口**:[applyConfigUpdate](../../../src/runtime/agent-loop.ts#L475) 只覆盖 `systemPrompt / toolPolicy / subagents / wikiAnchors / capabilities`。下列 AgentRecord 字段**未热更**(loop 忙时改它们,运行时要等下次重建才生效,期间 UI 显新、运行时用旧 = 所见≠所跑):
- `model / provider` —— **每轮已被重读**([agent-loop.ts:577](../../../src/runtime/agent-loop.ts#L577) `resolveModel`),只差没被写回,补进 applyConfigUpdate 即下轮生效(轮间切模型安全)。
- `contextConfig`(device/guidelines/memory)—— 建 loop 时解析进 prompt/contextBundle,需 re-resolve + `invalidate("base")`。
- `thinkingLevel` / `skillPolicy`(enabledSkills,影响工具集)/ `knowledgeBaseIds`(影响 context)—— 照 toolPolicy 模式热更。
- 注:`maxTokens`/`temperature` 非 AgentRecord 字段,非 gap。
- 注:gap 仅在"loop 忙时改"出现(空闲时 `store.onChange` 整个重建 loop,全字段生效)。
**待办**:把上述全部补进 `applyConfigUpdate`,使任意字段编辑(忙/闲)下轮生效。(Wiki bug 即此路径上 capabilities 的洞,已补。)

### 不变量 2(只更新变化部分)
**保证**:状态流只带 `{id,op,record?}`;渲染按稳定 key + `React.memo` 只 patch 变化行;选择器订阅避免无关重渲染;刷新期保留旧值不空白。
**现状缺口**:盲轮询全量重拉重绘;全仓 `useStore()`;loading 当内容开关;`?? []` 引用抖动。

### 不变量 3(运行时状态变 → UI 实时)
**保证**:运行时对象变更即 `emitDataChange` → 状态流 → 可见的面 pull/patch。
**现状缺口**:TaskRegistry / SessionManager / MCPManager / ConfirmRegistry **根本没 emit**(只能被轮询);InputQueueStore 有 emit 但没接通道;`data:changed` 桥断([index.ts:283](../../../src/server/index.ts#L283) 丢 `changes`)→ 配置态变更也没真推到。

### 不变量 4(架构统一、易扩展)
**保证**:状态类全走一个中枢一条流一个原语一个渲染模式;流类全走 `agent:event` 一个契约。两类边界清晰。加新数据按 §6 契约。
**现状缺口**:多套并行机制(data:changed + ad-hoc runtime ping + onSessionLifecycle + 轮询 + api 直查),风格不一。

## 6. 加新数据的契约(易扩展)

新数据先分类,再套该类两行契约:

**状态类(record)** —— 后端 1 行 + 前端 2 选 1:
1. 后端:变更时 `emitDataChange("你的collection", id, op, record)`(DB 表自动有;运行时对象手调)。
2. 前端(按真源性质二选一):
   - **DB 表**:`subscribeListDataChange("你的collection", …)` —— 按 id **patch** 列表(变更带 record,免重拉)。
   - **runtime collection**(task/queue/mcp/metrics):订阅 ping,可见时 **pull** 一次整段(ping 不带完整数据,按 active session 重拉)。
→ 自动获得:实时推送、coalesce、只更新变化部分、重连重拉。

**流类(increment)** —— 2 行:
1. 后端:生成块时 `emit({type:"你的type", sessionId, delta})`。
2. 前端:`onAgentEvent` 加 handler,append 到进行中缓冲。
→ 自动获得:按 session 路由、切走断开、平滑 append。

**分类一句话**:"已存在的记录会变"→状态;"正在生成、逐块到"→流。

## 7. 落地节点

拆成 4 个独立可实现/可测/可合并的节点,每节点两份文档(实现路线 + 测试要求):

| 节点 | 主题 | 依赖 | 实现路线 | 测试要求 |
|---|---|---|---|---|
| **N1** | 统一状态流基建(桥 + runtime emit + 白名单 + session emit) | 无(基石) | [plan-N1.md](plan-N1.md) | [acceptance-N1.md](acceptance-N1.md) |
| **N2** | UI 推送驱动 + 消闪烁 + 重连 resync | N1 | [plan-N2.md](plan-N2.md) | [acceptance-N2.md](acceptance-N2.md) |
| **N3** | 文件系统零轮询(非运行时) | 无 | [plan-N3.md](plan-N3.md) | [acceptance-N3.md](acceptance-N3.md) |
| **N4** | 配置字段热更(不变量 1) | 无 | [plan-N4.md](plan-N4.md) | [acceptance-N4.md](acceptance-N4.md) |

**建议顺序**:N1(基石)→ N2(UI 改造,最大、消闪烁在此)→ N3/N4(独立,可并行)。各节点详细步骤/文件/验收见对应文档。

> **实现/验收 subagent 必读 [conventions.md](conventions.md)**(项目级硬规约:三层 tsc、sessions.db 只读、commit 规约、Edit 陷阱、不动他人代码等)——这些不在设计正文,但实现必须遵守。

## 8. 验证
- typecheck 三层 + build:lib + vitest(新增:hub 转发带 changes;运行时对象 emitDataChange 触发流;ping→pull 仅可见;applyConfigUpdate 新字段热更)。
- e2e/手动:子代理状态→task 树秒动无闪;后台建会话→侧栏秒出;改 agent contextConfig→运行中 loop 下轮吃到 + UI 同步;断 WS→重连重拉恢复;Injection preview 配置不动不闪;renderer 数据路径 grep `setInterval` 为 0(本地时钟例外)。
- 覆盖度:除文件树/日志外,每面运行时/配置变更 ≤1 tick 内可见。

## 9. 风险 / 取舍 / 待讨论

- **[已定案] SessionDB emit**:SessionDB 独立类、直接 prepared statement、不走 SqliteStore。会话列表通过「白名单加 `sessions` + `createSession`/`deleteSession`/`archiveSession` 显式 `emitDataChange` 喂 hub」实现(高频 UPDATE 不 emit)。放 SessionDB primitive 层因 9+ 创建点全在它下、且与 SqliteStore 同款。
- **[已定案] applyConfigUpdate 字段补全**:核实后,model/provider 每轮已被重读(只差写回),contextConfig/thinkingLevel/skillPolicy/knowledgeBaseIds 需热更;maxTokens/temperature 非 AgentRecord 字段、非 gap。Phase 4 全部补进。
- **[已定案] 流类与状态类不合并**:保持两类各一套契约(状态走 hub、流走 agent:event)。两类边界清晰("已存在记录会变"→状态;"正在生成逐块到"→流),不算散装;合并要给 hub 加 `append` op + 子记录路由 + token 级延迟调优,把高频特化塞进通用管道,不划算。**触发条件**:出现第二种流类数据(非 chat 生成)时,重新评估合并(升级状态流为支持 append 的超集)。
- **[实现依赖] 重连信号**:`connectEventBridge` 已自动重连,但 renderer 察觉不到。Phase 2d 必须新增 `ws:reconnected` main→renderer 信号,否则断连窗口丢推送、靠下次导航补。
- **[边界] 后台 session stale**:disconnect-on-leave 使后台 session 切回才更新,接受。
- **[边界] 纯本地时钟**:Cron 倒计时允许无 fetch 的本地 timer(不是数据轮询);"零 setInterval"仅约束数据路径。
- **[特例] Injection preview**:配置预览,闪烁根因是全仓订阅 + `?? []` + loading gate,修法是渲染卫生(Phase 2c),不走推送。
- **不动 ChatPanel 内联渲染**(830 行 tab/CRLF,Edit 易踩);message-blocks.tsx 是新视图规范模块。
- 提交规约:Co-Authored-By: Claude;commit message 走 Bash `-F`;查 sessions.db 只读、不 checkpoint。
