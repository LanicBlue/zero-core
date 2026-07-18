# Design:platform-observability

> 状态:**Draft,待决策**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。

## 问题回顾(详见 ./issue.md)

平台管理视角单薄:① session 观测、② provider 观测、③ 首页看板重设计三块缺统一观测口(③依赖①②)。

## 关键事实(审计)

### session 侧(①③ 共用)

- **活状态(瞬时)**:`agent-service.ts` `runStates` Map<sessionId,{agentId,isBusy,waiting,streamingText,toolCalls}>([:590](../../../src/server/agent-service.ts#L590)/[:1002](../../../src/server/agent-service.ts#L1002)/[:1591](../../../src/server/agent-service.ts#L1591));`isSessionRunning(sid)`([:576](../../../src/server/agent-service.ts#L576));`activeSessions` agentId→activeSessionId([:142](../../../src/server/agent-service.ts#L142)/[:437](../../../src/server/agent-service.ts#L437));`db.getMainSession(agentId)`;`listDelegatedTasks({parentSessionId})`([:798](../../../src/server/agent-service.ts#L798));`session_kind` chat/delegated。
- **累积指标**:[`session-metrics.ts`](../../../src/server/session-metrics.ts) `SessionMetrics`(parentSessionId/spawnDepth/lifecycleState/inputTokens/outputTokens/cacheRead/cacheWrite/reasoningTokens/avgTurnLatencyMs/avgFirstTokenMs/totalTurns/errorCount/retryCount/toolCallCounts),`SessionMetricsHolder.recordTokenUsage`([:165](../../../src/server/session-metrics.ts#L165)),`getAllSessionMetrics`(session-manager [:318](../../../src/server/session-manager.ts#L318))。
- **IPC**:`sessions:metrics`([ipc-api.ts:138](../../../src/shared/ipc-api.ts#L138))→ `AggregateMetrics + sessions`(session-router [:62](../../../src/server/session-router.ts#L62));前端 `DashboardPage.tsx` 消费。
- **缺口**:`Platform` 工具(`platform-tools.ts`)无 session resource —— agent 无法自省父 session 状态;活状态(runStates)与累积指标(SessionMetrics)是两套,无统一"父 session 状态"视图。

### provider 侧(②)

- **静态配置**:`Platform` 'providers' resource(`platform-tools.ts:128`)只读 providers 表(name/type/enabled/modelCount/baseUrl/redacted apiKey)。
- **并发快照**:`AggregateMetrics.concurrencySnapshot`(per provider active/waiting,[:115](../../../src/server/session-metrics.ts#L115)),`agentService.getConcurrencySnapshot()`(session-manager [:355](../../../src/server/session-manager.ts#L355))。
- **usage 不带 provider**:`recordTokenUsage(sessionId, usage)`([session-manager.ts:290](../../../src/server/session-manager.ts#L290))无 providerName 参数;usage 按 **session** 累积,未按 provider。
- **provider 可 mid-session 切换**:`config.providerName/modelId` 在 AgentLoop,`patch` 可改([agent-loop.ts:741](../../../src/runtime/agent-loop.ts#L741))→ **一个 session 历史上可能用过多个 provider**,按"当前 provider"聚合会错配。
- **打点位置**:agent-loop `finalizeOneStep`(usage 落地时,[:1367](../../../src/runtime/agent-loop.ts#L1367))处 `this.config.providerName` 已知 → 可在此把 providerName 传入 recordTokenUsage。

### 看板侧(③)

- 现有 [`DashboardPage.tsx`](../../../src/renderer/components/dashboard/DashboardPage.tsx):SessionMetrics 表(tokens/turns/errors)+ Aggregate 计数 + concurrencySnapshot,组织轴是"session 列表",非"平台管理"。

## 方案

### ① session 观测

**A — Platform `sessions` resource(推荐)**
- `{resource:'sessions', sessionId?}`:省略=List,传=Detail。
- **List**(无 id):全局**父 agent**(agent-general / agent-project / …)每个的 active/main session + 状态。单元 = 父 agent session(`session_kind='chat'`),**扁平,不掺 task、不掺 subagent**。一行:`{agentId, sessionId(short), status:running|waiting|idle, lastActivity}`(status 来自 `runStates`:有条目→isBusy?running:waiting?waiting:idle;无条目→idle;父 agent 枚举自 `agentStore.list()` + `activeSessions`/`db.getMainSession`)。
- **Detail**(sessionId):该父 session 的
  - **task tree** —— `getRuntimeTaskTree(sessionId)`([:446](../../../src/server/agent-service.ts#L446)),该父派出的 task/delegation 树(与 TaskList 同源,roots=parent_session_id 派出、按 root_task_id 扩嵌套 [:793-798](../../../src/server/agent-service.ts#L793))。
  - **最近 N=3 step** —— 经 recorder/`getRecentToolCalls`([:568](../../../src/runtime/agent-loop.ts#L568))同源抽取,每 step `{stepSeq, toolCalls:[{name, argsBrief}], status, time}`(**不含 tokens** —— 用户明确不要)。
- 优点:归 Platform 只读自省,数据经 ctx 可达,agent 自省 + 看板(③)都能消费。缺点:Platform resource 现是 flat 单值,加 List/Detail 两态(略复杂,但 `sessionId?` 区分即可)。

**B — 独立 `SessionStatus` 工具**
- 优点:后续加写操作(kill/resume)不污染 Platform。缺点:只读阶段没必要拆,与 Platform 自省定位重复。

→ **推荐 A**。session 维度写操作短期内 unlikely(子 task 已有 TaskKill/TaskResume);要写再拆。

**渲染(已定)**:**文本格式**(类 TaskList/wiki expand,tree+step 可读;非 JSON)。`lastActivity` 用**相对时间**("last 2s ago" / "last 1m ago")。

### ② provider 观测 + 并发管理

**已定:纯本地统计,无 cost、无余额拉取。** provider 层记录与 session 独立,各记各的。四部分:

#### ②.1 turnSource 标记(优先级 + 统计共用)

- **现状**:无现成来源标志(turn_state 列无 source;message 只 {role,content})。但入口可区分且部分有间接信号:chat-router.sendPrompt=用户、sendProjectPrompt({workId})=work、cron fireAgent(有 cronRunStore 记录)=cron、delegated session=background。
- **方案**:`turn_state` 加列 `source`(持久,turn 级),由入口设置:
  - chat-router.sendPrompt → `user`
  - sendProjectPrompt(有 workId) → `work`
  - cron fireAgent(有 cronRun 上下文) → `cron`
  - delegated session 的 turn → `background`
- 优先级档:`user=P1 > work/cron=P2 > background=P3`。
- 复用:喂 ②.4 优先级 + ②.2 用量可按来源切 + ③ 看板分组。

#### ②.2 小时/模型用量(DB 表,provider 层独立)

- finalizeOneStep 处(providerName + modelId + usage + turnSource 都已知)记一条。
- **新 DB 表 `provider_usage`**(provider 层,与 session 独立),键 `(provider, model, hour_bucket, source)`:
  `calls · inputTokens · outputTokens · cacheRead · cacheWrite · errors`
  - hour_bucket = hour-floor timestamp(UTC)。
  - **天视图** = `GROUP BY date(hour_bucket)`(无需另存天桶,从小时聚合)。
  - **留存 ≥ 30 天**(支撑"过去 30 天"视图;定期清 30 天前数据,类 turn_state 清理)。
- 累积总量(per-provider / per-model)= 对该表 SUM;小时序列 = GROUP BY hour_bucket;天序列 = GROUP BY date(hour_bucket)。一表多视图。
- 查询参数:`{ provider, granularity: hour|day, range: 24h|30d, model? }`。
- latency(avg)单独进程内 running 累积(不进 DB;观测量级小,重启可接受)。
- 记录时机:usage 落地同 ②.1 打点处,不另起路径。

#### ②.3 并发队列观测

- 现状:`ConcurrencyQueue.waiters[]` **匿名**(只 {resolve,reject,abort}),`getWaitingCount()` 只给数([concurrency-queue.ts:101](../../../src/runtime/concurrency-queue.ts#L101))。
- 方案:waiter 加 `{ sessionId, agentId, source/tier, waitedSince }`;新增 `getWaiting()` 返排队列表。`getQueue(provider).getWaiting()` → 每 provider 的排队 session 清单(sessionId + 等了多久 + tier)。
- 暴露:Platform provider 观测 + IPC(③ 看板"排队中")。

#### ②.4 优先级队列(机制改动)

- 现状:`release()` = `waiters.shift()` 纯 FIFO([concurrency-queue.ts:88](../../../src/runtime/concurrency-queue.ts#L88))。
- 方案:
  - **AsyncLocalStorage** 传优先级:agent-loop.run 开始 set `{ sessionId, source→tier }`,provider-factory 中间件 acquire 时读(比往每次 model call metadata 塞字段干净)。
  - `acquire({tier})` 把 tier 挂 waiter;`release()` 改为**按 tier 出队**(同 tier 内 FIFO,按 waitedSince)。
  - 严格优先级:P1 先于 P2 先于 P3。background(P3)可能饿死 —— **接受**(最低档本就最低优先;如需防饿死后续加 aging,本期不做)。
- 影响面:`concurrency-queue.ts`(waiter 结构 + release)、`provider-factory.ts`(acquire 传 tier)、`agent-loop.ts`(set ALS context by turnSource)、各入口设 turnSource(②.1)。

#### 暴露面

- `Platform` provider 观测(resource 文本格式,同 ①):per-provider 一行 = 静态配置(enabled/models)+ 即时 in-flight + 累积 tokens/calls/errors/latency + 排队队列。
- IPC 给 ③ 看板(消费小时序列 + 排队)。

### ③ 首页看板重设计(依赖①②)

**已定:原地演进 [`DashboardPage.tsx`](../../../src/renderer/components/dashboard/DashboardPage.tsx),横向布局(窗口宽>高)。** 复用现有 `sessions:metrics` IPC + ①② 新增数据。

布局:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 顶 KPI 条(全宽):会话数 │ 运行 │ 等待 │ 今日 token │ 错误                          │
├──────────────────────────────┬───────────────────────────────────────────────────┤
│ agent(① List)              │ 今日任务(今日会触发的 cron,含 work)            │
│ ● agent-general   running    │   09:00  agent-archivist  [work] 绑定  上次 ✅    │
│   2s ago   24 turns          │   14:30  agent-general    [cron] 日报  上次 ❌    │
│ ◐ agent-project   waiting    │   每2h   agent-research   [cron] 检索  —         │
│   1m ago    8 turns          │   23:00  agent-archivist  [git]  归档  上次 ✅    │
│ ○ agent-research  idle       │                                                   │
│   14m ago   3 turns          │                                                   │
│ (点行→task tree+最近3step)  │                                                   │
├──────────────────────────────┴───────────────────────────────────────────────────┤
│ Provider [combobox 筛选]  [日 │ 30天]                                             │
│ 选中 provider:in-flight/queue + tokens/calls/err/latency + 排队列表(②.3)       │
│ 用量堆叠柱状图(全宽):每柱=1h(日)/1天(30天),分段=模型,柱高=总量(②.2)      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

要点:
- **顶 KPI 条**:全宽,聚合(会话/运行/等待/今日 token/错误)。
- **主区左右分栏**:
  - **左 `agent`**(① List):每个父 agent 一行 = `状态点 · agentId · 状态 · 相对时间 · turns`(**不显 sessionId**)。点行 → ① Detail(task tree + 最近 3 step)。
  - **右 今日任务**:今日会触发的所有 cron(含 cron 触发的 work)。遍历 enabled cron,用 `nextFireMs`([cron-analysis.ts:272](../../../src/server/cron-analysis.ts#L272))算今天的 fire 时间。每条:`触发时间(today) · agent · 类型[work|cron|git-aware] · 标签 · 上次结果(CronRunStore)`。
- **底 Provider**(全宽):**combobox 筛选**(一次看一个 provider)。选中后:in-flight/queue + tokens/calls/errors/latency + 排队 session 列表(②.3)+ 用量图。
- **用量图 = 堆叠柱状图,带视图切换**(全宽,放底部让 24/30 柱更舒展):
  - **日视图**:X = 近 24h 按小时(小时柱)。
  - **过去 30 天视图**:X = 近 30d 按天(天柱)。
  - 每柱分段 = 模型,柱高 = 总量。数据源 ②.2 `provider_usage`(granularity hour|day,模型作 series)。
- 数据 IPC:① 活状态 + ② provider 统计/排队/小时序列 + 今日 cron 各经 IPC(③ 消费)。



## 推荐

| 块 | 方案 | 理由 |
|---|---|---|
| ① | Platform `sessions` resource(List 父状态 / Detail task tree + 最近3step) | 归口 Platform 只读自省;数据经 ctx 可达 |
| ② | 本地统计 + 并发管理(turnSource 标记 + 小时/模型用量 DB 表 + 队列观测 + 优先级队列) | 精确归因(provider 可 mid-session 切换);队列优先级保用户对话体验 |
| ③ | 原地演进分 section | 复用现有 metrics 基建 + ①② 数据 |

实施顺序:**① ② 可并行 → ③**(③数据/IPC依赖①②)。

## 决策记录(全部已定,可进 plan)

1. ~~**① List 范围**~~ ✅ 已定:只父 session(`session_kind='chat'`,agent-general/project 等);Detail = task tree(`getRuntimeTaskTree`)+ 最近 N=3 step(无 tokens);渲染文本格式 + 相对时间。
2. ~~**① 暴露面**~~ ✅ 已定:**Platform resource(agent 自省)+ 看板 IPC 都建**(同源数据两消费者:agent 自省用 Platform、③ 看板用 IPC)。
3. ~~**② cost 维度 / 余额拉取**~~ ✅ 已定:**不做** cost(无定价源)、**不做**余额/账单拉取(provider 间不通用)。② 只做本地运行时统计(tokens/errors/latency/count per provider)。
4. ~~**② 累积器生命周期 / 存储**~~ ✅ 已定:**小时/模型用量进 DB 表 `provider_usage`**(provider 层独立,持久历史);累积总量 = 该表 SUM;latency 进程内 running(观测量级小)。turnSource 持久在 `turn_state` 加列。
5. ~~**③ 看板布局**~~ ✅ 已定:原地演进 DashboardPage,横向(顶 KPI 条 + 左 `agent` 栏 + 右 `Provider` combobox 钻取 + 堆叠柱状图 + 底 Activity);不显 sessionId。

## 下一步

5 决策已全定 → `/effort plan` 拆 sub(①/② 各自 sub + ③ 收尾 sub,每个配 acceptance)。实施顺序:①② 可并行 → ③(③数据/IPC依赖①②)。
