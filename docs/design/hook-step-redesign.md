# Hook 生命周期重做:per-loop registry + step 中心 + 去 turn 表

> 设计 + 执行文档。驱动 hook 系统与执行引擎的一次结构性整理。
> 状态:**待抠细节 → 定时执行**。相关:ADR-024(技术债)、`docs/arch/03-runtime-engine.md` §Hook 系统。

> ## ⚠️ 执行须知(给定时执行的 fresh session)
>
> **本文档是权威 spec**。`~/.claude/plans/merry-whistling-pizza.md` 是早期高层 plan,**细节以本文档为准**(它有些数字/框架是旧的,如 13 hook → 实际 14、TurnEnd 旧框架 → 实际是 turn 边界闭合)。
>
> **执行规则:**
> 1. 按 §9 的 Phase 1 → 2 → 3 → 4 → 5 顺序,每 phase 一个 commit,每 phase typecheck 三层绿 + vitest 绿才进下一。
> 2. **Phase 2 第一件事 = spike AI SDK**(`stopWhen: stepCountIs(1)` 的 tool-call 续跑 / abort / retry)。不通 → Phase 2 回退(OnLLMError 仅观测,step 外置/重试/resume 列后续),并在 §10 #3 记录,不要硬干。
> 3. 任一 phase 失败 → **停下、不要继续**,PushNotification 报给用户,等人工。
> 4. 注释一律英文;commit 带 `Co-Authored-By: Claude <noreply@anthropic.com>`;不碰 `BUILTIN_WORKFLOW_ROLES` / `docs/rfc/*`;code-graph 提交前再生成。
> 5. 全程约束见 §12。

## 1. 问题(四个递进发现)

1. **命名不副实 + 所有权错位**:per-run hook 冒充 session 级 —— `SessionStart`/`Stop`/`StopFailure`/`SessionEnd` 实际在 `AgentLoop.run()` 里每 turn fire;`PreLLMCall` 也在 turn 级(每轮一次),名字却像 per-LLM-call。session 生命周期的真正 owner 是 **`agent-service.ts`**(持 `loops: Map<sessionId, AgentLoop>`,管 loop 建/删/关停),**不在 AgentLoop**(AgentLoop 无 `dispose()`,只是 per-turn 执行驱动,按 session 缓存)。session 级 hook 当前**完全静默**(构造/销毁都不 fire)。

2. **handler 全局单例跨 loop 触发**:`HookRegistry` 是进程级单例,handler 对所有 loop(主 + 子 agent)fire,靠 sessionId 自行过滤。pi-mono 的做法是 **per-instance / per-loop registry**(每个 loop 自己的 registry),从根上消灭跨 loop 问题。

3. **turn 不是正确的主颗粒**:subagent 会话是 1-turn(一条 user 指令 → 多 step);真正的工作与持久化颗粒是 **step**。压缩 / 抽取 / todo 等操作应下沉 step 级,turn 级瘦成只剩"输入门控"。

4. **turn 表是冗余抽象**:`turns` 物理表里,step 就是带 `turn_group` 列的行(`session-db.ts:130`,`hasStepSchema()` 查的就是这列在不在)。turn 本质是 step 的一个分组属性。退役 legacy turn API(`appendTurn`/`getTurns`/`updateTurnContent` + `hasStepSchema` 分支),让 step 成为唯一权威存储。

## 2. 目标

- **14 个**按生命周期位置命名的 hook(Session/Turn/Step/LLMCall/Tool 五层)。
- **per-loop registry**(治本):每个 AgentLoop 持自己的 registry,handler 只对本 loop fire。
- **step 循环外置**:打开 step 级重试(只重试失败 step)+ step 级 resume(崩溃后续跑)。
- **操作下沉**:压缩/抽取/todo/metrics → StepEnd;requirement-hooks **移除**(§5.5,workflow 域)。
- **去 turn 表**:step 唯一,turn = `turn_group` 属性,带数据迁移。
- 行为向后兼容(迁移保证旧数据可读);分 5 phase,每 phase typecheck 绿、独立 commit。

## 3. 最终 hook 骨架(step 中心)

```
SessionStart                                    [agent-service · loop 建时]
├─ TurnStart   (输入门控 + 记 user step + 分配 turn 属性)
├─ Step × N   [外置 step 循环 · 每次 1 个 streamText]
│   ├─ StepStart          (per-step setup,暂为空缝)
│   ├─ PreLLMCall         (每 step 注入:RAG / providerOptions / notifications
│   │                      / workflow-context / 控制消息 / insert_now)
│   ├─ [LLM call] ──失败──→ OnLLMError   (error+分类,可干预重试,只重试该 step)
│   ├─ PostLLCall         (模型返回/工具执行前,观测缝)
│   ├─ Tool × M
│   │   ├─ PreToolUse → [exec] → PostToolUse
│   │   └─ (失败) → PostToolUseFailure
│   └─ StepEnd            (落库 step + usage + 压缩查 + 抽取查 + todo 查 + metrics)
├─ TurnEnd    (TurnStart 的对称结构 · 保留为空缝,暂无操作)
├─ TurnError  (失败落库,或并入 TurnEnd 带 error 标志)
SessionClose                                    [agent-service · loop 销时]
                (metrics idle + registry teardown)
```

**14 hook 一览:**

| 层级 | hook | owner | 颗粒度 |
|---|---|---|---|
| Session | `SessionStart` / `SessionClose` | agent-service | 每 loop 实例一次 |
| Turn | `TurnStart` / `TurnEnd` / `TurnError` | AgentLoop.run() | 每 user 输入一次 |
| Step | `StepStart` / `StepEnd` | AgentLoop(外置循环) | 每 LLM call |
| LLMCall | `PreLLMCall` / `PostLLCall` / `OnLLMError` | AgentLoop | 每 LLM call |
| Tool | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | AgentLoop | 每工具 |

**负载分布**:Turn 级三件(TurnEnd = turn 边界闭合,非空缝);StepEnd 吸收原 turn 级的压缩/抽取/todo/metrics + step 检查点;durable 检查点改 step 级恢复(Phase 2);requirement-hooks 移除(§5.5)。

## 4. 命名映射(old → new)

| Old | New | 备注 |
|---|---|---|
| `UserPromptSubmit` | `TurnStart` | 合并:输入门控即 turn 起点 |
| `SessionStart`(per-run 误用) | `TurnStart` | 改正语义 |
| `SessionStart`/`SessionEnd`(新语义) | `SessionStart`/`SessionClose` | agent-service fire,真 session 级 |
| `PreLLMCall` | `PreLLMCall` | 保留名,改 per-step |
| `PrepareStep` | 并入 `PreLLMCall` + `StepStart` | 注入统一到 PreLLMCall |
| `PostStep` | `StepEnd` | |
| `PostTurnComplete` | 拆 → 多数 `StepEnd`;requirement 移除(§5.5) | |
| `Stop` | `TurnError` 或 `SessionClose` | 按操作 |
| `StopFailure` | `TurnError` | |
| `PreToolUse`/`PostToolUse`/`PostToolUseFailure` | 不变 | |
| —(新) | `PostLLCall`(空缝)、`OnLLMError`(新) | |

## 5. 现有 26 个操作 → 新 hook 落点

### Session 级

| 操作 | 现 hook | 模块 | → 新 hook | 判定 |
|---|---|---|---|---|
| trackSessionStreaming | SessionStart | metrics-hooks | **SessionStart** | ✅ 修对语义(现状每 turn 误 fire) |
| trackSessionIdle | SessionEnd | metrics-hooks | **SessionClose** | ✅ |
| (agent-loop 空 trigger L270/314) | SessionEnd | agent-loop | — | ❌ 砍 |

### Turn 级

| 操作 | 现 hook | 模块 | → 新 hook | 判定 |
|---|---|---|---|---|
| 写 user turn + 分配 turn_seq | SessionStart | turn-hooks | **TurnStart** | ✅ |
| ~~createTurnState(崩溃恢复检查点)~~ | SessionStart | durable-hooks | — | 🔄 **Phase 2 重构为 step 级恢复**(检查点记 lastCompletedStepSeq,非 turn 级) |
| 闭合 turn_group + 推进 turn_seq(turn 边界) | —(现隐式 getTurnCount) | turn-hooks | **TurnEnd** | 🆕 TurnEnd 真活:显式闭合当前 turn,下个 user 输入 turn 属性 +1 |
| ~~safety-net 落库最终 assistant step~~ | Stop | turn-hooks | — | 🔄 Phase 2 并入 StepEnd(abort 分支落 partial + 合成 dangling tool result) |
| ~~completeTurnState~~ | Stop | durable-hooks | — | 🔄 Phase 2 step 级恢复(TurnEnd 的活改由 turn-hooks 做边界闭合,见上) |
| 压缩 + 记忆节点(+ 内嵌 PreCompact/PostCompact) | PostTurnComplete | compression-hooks | **StepEnd** | ✅ 下沉 |
| 清已完成 todo + emit todos_update | PostTurnComplete | todo-cleanup-hooks | **StepEnd** | ✅ 下沉 |
| 增量抽取(阈值触发) | PostTurnComplete | extraction-hooks | **StepEnd** | ✅ 下沉 |
| ~~lead 自动领下一个需求(拉模型链)~~ | PostTurnComplete | requirement-hooks | — | ❌ **退役**:workflow 域逻辑,不该搭 session hook(见 §5.5);随 cron+work 取代一并删 |
| recordTokenEstimate(按 resultText) | Stop | metrics-hooks | **StepEnd**(或读真实 usage 砍) | ✅ 下沉 |
| 失败时落库已完成 block | StopFailure | turn-hooks | **TurnError** | ✅ |
| ~~failTurnState~~ | StopFailure | durable-hooks | — | 🔄 Phase 2 step 级恢复(markSessionInterrupted) |
| trackSessionError | StopFailure | metrics-hooks | **TurnError** | ✅ |

### Step / LLMCall 级

| 操作 | 现 hook | 模块 | → 新 hook | 判定 |
|---|---|---|---|---|
| (per-step setup) | — | — | **StepStart** | 🔵 空缝 |
| 注入 ragContext | PreLLMCall | rag-hooks | **PreLLMCall** | ✅(handler 内缓存) |
| 注入 providerOptions(thinking) | PreLLMCall | provider-options-hooks | **PreLLMCall** | ✅ |
| 回灌后台任务结果 + Notification | PreLLMCall | notification-hooks | **PreLLMCall** | ✅(main only) |
| 注入工作流上下文 | PreLLMCall | workflow-context-hook | **PreLLMCall** | ✅(work session) |
| 注入委派控制消息(request_finish) | PrepareStep | task-control-hooks | **PreLLMCall** | ✅(delegated only) |
| 注入 insert_now 排队输入 | PrepareStep | input-queue-hooks | **PreLLMCall** | ✅(main only) |
| (模型返回/工具前观测) | — | — | **PostLLCall** | 🔵 空缝 |
| persistAllSteps(step 级落库) | PostStep | turn-hooks | **StepEnd** | ✅ |
| (失败 LLM call 干预) | — | — | **OnLLMError** | 🆕 新增 |

### Tool 级

| 操作 | 现 hook | 模块 | → 新 hook | 判定 |
|---|---|---|---|---|
| 记录工具起始时间 + args | PreToolUse | tool-execution-hooks | **PreToolUse** | ✅ |
| ~~updateTurnPhase("tools_executing")~~ | PostToolUse | durable-hooks | — | 🔄 Phase 2 step 级恢复(markStepDone @ StepEnd) |
| ~~plan→build 状态流转(Orchestrate)~~ | PostToolUse | requirement-hooks | — | ❌ **退役**:同上,workflow 域 |
| recordToolExecution(success) | PostToolUse | tool-execution-hooks | **PostToolUse** | ✅ |
| recordToolExecution(failure) | PostToolUseFailure | tool-execution-hooks | **PostToolUseFailure** | ✅ |

### 砍 / 并

| 项 | 判定 |
|---|---|
| agent-loop `SessionEnd` 空 trigger | ❌ 砍 |
| turn-hooks 与 durable-hooks 各自的 `sessionTurnSeq` Map | 🔀 并(一处共用) |
| PreCompact / PostCompact(压缩内嵌子事件,metrics 用 PreCompact 记 token) | ⚠️ 核查 firing 点 |
| `Notification` 事件(notification-hooks 内部 fire,无 handler) | 🔵 留(观测缝) |
| metrics `recordTokenEstimate` 粗估(msgCount×50 / len÷4) | ⚠️ Phase 5 审查,可能砍(真实 usage 已有) |

### 5.5 原则:session hook 只承载 session 生命周期自身的事

> session hook = 持久化 / 上下文装配 / 指标 / 注入这些**session 域**关注点。
> **跨域的业务/工作流逻辑(需求状态机 mutation、lead pickup)不该搭 session hook 便车** —— 那是把 session hook 当事件总线,语义错位。这类逻辑归 workflow/cron 层自管。

判定每个操作去留时先问:**它是 session 生命周期的事,还是借 session 事件触发的别域副作用?** 后者不进 new skeleton。

- ✅ 留(session 域):turn-hooks(持久化)、durable-hooks(崩溃检查点)、tool-execution-hooks(会话审计)、metrics-hooks(会话指标)、notification/rag/provider-options/workflow-context-hooks(上下文注入)、task-control/input-queue-hooks(per-step 注入)。
- ❌ 出(workflow 域,借 session 事件触发的需求状态机):**requirement-hooks 整个移除**(plan→build + autoPickup)。它本就在 cron+work 取代路线上退役;无论退役与否,都不属 session hook。

操作总数 26 → **24**(requirement 2 个移除)。TurnEnd 仅留 turn 边界闭合(turn-hooks);durable → step 级恢复(Phase 2);safety-net → StepEnd(Phase 2)。

## 6. per-loop registry 设计

- `HookRegistry` 去单例化 → 普通实例类。`AgentLoop` 构造期 `this.registry = new HookRegistry()`。
- 所有 `triggerHooks(...)` → `this.registry.trigger(...)`(或 loop 上的实例方法)。
- **注册按 loop kind 分组**:`registerHooksForLoop(registry, loopKind, deps)`:
  - **shared(main + delegated)**:turn-hooks、tool-execution-hooks、durable-hooks、provider-options-hooks、rag-hooks、extraction-hooks、compression-hooks、workflow-context-hook(仅 work session)
  - **main only**:notification-hooks、input-queue-hooks、metrics-hooks(requirement-hooks 已移除,见 §5.5)
  - **delegated only**:task-control-hooks
- agent-service 建主 loop → `registerHooksForLoop(reg, "main", deps)`;`subagent-delegator` 建子 loop → `registerHooksForLoop(reg, "delegated", deps)`。
- `BaseHookContext.loopKind` 保留作 handler 自省,但 per-loop registry 后**不再 load-bearing**(跨 loop 问题已从根上消失)。
- merge 语义:`blocked` 短路;标量 last-writer-wins;**数组字段(appendMessages)concat**。

## 7. step 循环外置(最高风险)

`executeStream()` 从"一次 `streamText({ stopWhen: stepCountIs(200) })`"改为**外层 while 驱动,每次跑 1 step**:

```
while (应继续):
  trigger StepStart
  preResult = trigger PreLLMCall     // 每 step 注入(原 prepareStep 的 appendMessages 语义)
  try:
    result = streamText({ stopWhen: stepCountIs(1) 或单步等价, messages, ... })
    await processStreamEvents(result) // 含 tool-call/result/finish-step
    trigger PostLLCall
    [Tool × M: PreToolUse → exec → PostToolUse/Failure]
    trigger StepEnd                   // 落库 step + usage
  catch LLM error:
    trigger OnLLMError(error, cls)    // handler 可 {retry, delayMs}
    若重试:只重跑该 step(已完成 step 的 tool 结果已在 messages)
    若放弃:抛出 → TurnError
  if 模型未再调工具: break
```

- 注入移到外层循环 step 边界,不再依赖 SDK `prepareStep` 回调。
- `OnLLMError` 只重试失败 step;`prompt_too_long` → aggressivePrune(作用域当前 step 上下文)。
- `runWithRetry` 重构:turn 级重试下沉到 step 级;turn 级只剩整体 abort/超时。
- **step 级 resume**:`resume()` 读最后一个 finish-step 的 seq,从下一 step 续跑(崩溃恢复执行层落地)。
- **durable-hooks 重构为 step 级恢复**:turn_state(turn 级 phase 检查点)→ step 级检查点(per-session `lastCompletedStepSeq`)。四件套(create/updatePhase/complete/fail turn_state)改为 step 等价物(markStepDone @ StepEnd / markSessionInterrupted @ 启动)。UI 恢复也从 step 推导。这取代了原 turn 级 doRecoverIncompleteSessions 的 turn_state 消费。
- abort 语义重验:外置后 abort 在 step 间/内的中断点要明确。

### 持久化与崩溃恢复(step 级)

**恢复分界 = finish-step 是否 fire:**

| Case | 触发 | 恢复策略 |
|---|---|---|
| **1. LLM 未完整返回**(未 callLLM / 流式中 / API 错 / 崩在 LLM 阶段) | finish-step 未 fire | **重跑整个 step**。partial LLM 输出丢弃,不落库 |
| **2. LLM 已返回,工具未全完成**(finish-step 已 fire,工具执行中 / 未开始) | finish-step 已 fire | **从工具执行恢复**:保留已完成工具,重做未完成工具;不重跑 LLM |

**设计变更(Phase 2 必做):**

1. **per-tool result 即时落库**(case 2 硬前提):PostToolUse / PostToolUseFailure 立即写该 tool block(result 已知),不等 finish-step。否则并发工具部分完成时区分不了谁完成 → 被迫全部重跑 → 非幂等工具双重副作用。
2. **父 tool-call ↔ delegated_tasks 链接持久化**(subagent 恢复,**父驱动 by design**):Agent/Orchestrate dispatch 时把 taskId 记到 tool-call block + 落 `delegated_tasks.parent_tool_call_id`,**且 taskId 在子 agent loop 建立前就分配+返回父** → 父始终持有 durable handle。`resumeTask(taskId)` 原语就位(查行→重建子 loop→`subLoop.resume()` 从 lastCompletedStepSeq 续→回填,不重新 invoke)。崩溃恢复**父驱动**:`markRunningDelegatedTasksInterrupted` 标 interrupted → 父下一轮 TaskStatus/tree 看到 → **自己决定**调 resumeTask 续跑或接受 interrupted 结果。**不做自动 scan-backfill**(by design)。
3. **"投递即消费"注入延迟消费到 StepEnd**:control message(task-control)、insert_now(input-queue)注入时只标记已投递、不删;等该 step finish-step 成功(StepEnd)才真正删 control message / 出队列。case 1 重跑 step 时注入仍在,直到成功才消费 —— 避免失败 attempt 吃掉控制消息/用户输入。无状态注入(RAG / providerOptions / workflow-context / notifications)无需此处理,纯重做。
4. **step 级检查点 `lastCompletedStepSeq`**(per session):每 StepEnd 推进;崩溃从 +1 step 续。case2 的"工具执行中崩溃" = 该 step finish-step 已 fire(LLM 输出已落库)但工具未全完成 → 恢复时重跑该 step 未完成工具,不算新 step。
5. **dangling tool-call 兜底**:任何落库路径捕获到 `status:"running"`(无 result)的 tool-call,若不能 resume,合成 result `[interrupted]` 保证 rebuild 合法。
- ⚠️ **spike AI SDK 单步行为**:`stopWhen: stepCountIs(1)` 的 tool-call 续跑 / abort / retry 是否正确。spike 通过再并入。

## 8. 去 turn 表 + 迁移

- `session-db.ts`:退役 `appendTurn`/`getTurns`/`updateTurnContent`/`hasStepSchema` 分支;`turn_group` 必填;`getSteps`/`appendStep`/`replaceStepsFromMessages` 为唯一 API。物理表名 `turns` 保留(重命名 `steps` 为可选 cosmetic,风险高,本次不做)。
- `session.ts`:`rebuildFromTurns` 删 legacy 分支,只走 `rebuildFromSteps`;`cachedTurns` 一律 `getSteps`。
- turn-hooks / durable-hooks / compression-hooks:删所有 `if hasStepSchema … else appendTurn`,只走 step。
- **迁移**(`db-migration.ts`):确保 `turn_group` 列存在;backfill 旧 rows(`turn_group`:user→seq,assistant→前一 user 的 seq);同步 *_COLUMNS([[feedback-fresh-db-migrations]])。
- turn_seq 追踪两份 Map 合并。

## 9. 执行 phase

| Phase | 内容 | 风险 | 产出 |
|---|---|---|---|
| **1** | hook 重命名 + per-loop registry + 所有权归位(session→agent-service) | 低(机械) | 行为不变,typecheck + vitest 绿 |
| **2** | step 循环外置 + OnLLMError + step 级重试/resume | **最高**(引擎) | 独立 commit + 单测,spike AI SDK 先行 |
| **3** | 操作下沉 StepEnd | 中 | 压缩/抽取/todo/metrics per-step;requirement 已移除 |
| **4** | 去 turn 表 + 迁移 | 中 | step 唯一,迁移单测 + fresh DB 测试 |
| **5** | metrics 审查 + 文档(03/05/08/09 ADR-025)+ code-graph | 低 | 收尾 |

每 phase typecheck 绿才进下一,每 phase 独立 commit。

## 10. 待抠细节(执行前确认)

1. **TurnEnd 内容**:**已定** —— turn 边界闭合(闭合 turn_group + 推进 turn_seq),turn-hooks 域。durable completeTurnState → step 级恢复(Phase 2);safety-net → StepEnd(Phase 2)。
2. **TurnError 独立 vs 并入 TurnEnd 带 error 标志**:二选一。
3. **spike AI SDK 单步循环**:`stopWhen: stepCountIs(1)` 行为是否干净(tool-call 续跑、abort、retry)。这是 Phase 2 能否落地的关键前提,建议**今晚执行先 spike**。
4. **metrics `recordTokenEstimate` 留还是砍**:真实 usage 已在 `usage` StreamEvent,粗估是否冗余。
5. **PreCompact/PostCompact firing 核查**:确认 compression 真的 fire 了,否则 metrics 的 PreCompact 分支是死代码。
6. **物理表是否重命名 `turns`→`steps`**:本次默认不重命名(风险),确认。
7. **requirement-hooks 处置**:**已定** —— 整个移除(§5.5)。workflow 域逻辑不该搭 session hook;且本在 cron+work 取代路线上退役。本次 hook 重做不背它。

## 11. 验证(总体完工标准)

1. typecheck 三层(tsconfig.cli/web/node)+ `build:lib`(tsc)。
2. electron-vite build + vitest 全绿(含 step 外置新测 + 迁移测 + m5/m3 回归)。
3. 全仓 grep 旧事件名 → 0(`SessionStart` 仅 agent-service + types)。
4. 全仓 grep legacy turn API(`appendTurn`/`getTurns`/`updateTurnContent`/`hasStepSchema`)→ 0。
5. 手动:主会话多 step turn + delegate 1-turn session → step 级落库/压缩/注入正常;step 重试只重跑失败 step;崩溃后 step 级 resume;旧 DB 升级后历史可重建。

## 12. 约束

- 注释一律**英文**;commit 带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 不碰他人代码 / `BUILTIN_WORKFLOW_ROLES` / `docs/rfc/*`。
- Edit 在 tab/CRLF 易失败 → cat -A 诊断,Write 全文 fallback;commit 用 Bash `-F`。
- 查 sessions.db readonly;backend 占用时不 checkpoint。
- DB 列同步 5 处。
- code-graph 提交前再生成。
- AgentLoop 引擎改动(step 外置)属执行引擎例外,非功能代码;功能仍走 hook([[feedback-agent-loop-hooks-only]])。
