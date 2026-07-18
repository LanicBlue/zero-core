# 子代理 session 中断恢复 + 父子同步 — Design

> 阶段 ② 设计细化。`issue.md` 是问题记录(同目录),本文件是设计 spec。未定案项标 **[待确认]**。

## 0. 概述

一个崩溃/关闭打断 subagent 后的恢复模型,牵出三个强耦合问题域:

1. **父子 session 的结束与重建恢复** —— turn 生命周期 + recovery 分流。
2. **task / wait 工具** —— 父如何挂起等子、durable Wait。
3. **context 注入** —— 父如何看见 task/todo 状态。

三者共一个根:**父子同步模型**。下面的设计按"三通道注入模型 + 三域"组织。

---

## 1. 三通道 prompt 注入模型(system / context / workbench)—— 已定稿

按**持久化 + 更新频率**分三层。消息布局:system prompt 在最前 → 多段 context 留存在 user 输入处 → 一段 `<workbench>` 在最新 step。

| 通道 | 持久化 | 更新频率 | 定位 |
|---|---|---|---|
| **system** | 否(system prompt) | **按需**(config / wiki / requirement 变才 invalidate 重建) | 稳定绑定,强 prompt cache |
| **context** | **是(进历史,留存累积)** | 事件驱动(每次 recall 追加一次,去重) | 跨 turn 留存的召回记忆 |
| **workbench** | **否(每 step 重建,不累积)** | 每 step + dirty 检查 | 当前工作台面活状态 |

### 1.1 完整分配表(原 context 块 6 段 + work-context hook 拆解)

| 原内容 | 来源 | 去向 |
|---|---|---|
| Environment — OS/cwd | `buildEnvironmentBlock`([context-message.ts:105](../../../src/runtime/context-message.ts#L105)) | **system** |
| Environment — date/time | 同上 | **workbench** |
| Guidelines | `config.guidelines` | **system** |
| ~~Current Task~~ | `resolveCurrentTask`([agent-loop.ts:869](../../../src/runtime/agent-loop.ts#L869)) | **丢弃** —— 被 work-context hook 的 `## Requirement` 覆盖(后者更全:title+priority+impact+desc) |
| Wiki Anchors(根 summary + 一层) | `renderSystemAnchors` + `renderContextAnchors` 合并 | **system** —— 默认不更新,特殊时机(session 重建 / compress)才刷新 |
| Wiki Baseline | work-context hook | **合并进 Wiki Anchors(system)** |
| Project(name / working dir) | work-context hook | **system** |
| Requirement(title/priority/impact/desc) | work-context hook | **system** |
| Steps Progress(各 role step 状态) | work-context hook | **workbench**(与 task 状态同类,合并) |
| Recalled Memories | `memoryContext` | **context(持久,唯一留存内容)** |
| Task List(todos) | `renderTodosContext`(`todo-write.ts:62`) | **workbench** |
| task 状态 / wait 状态(新) | — | **workbench** |

**work-context hook(`workflow-context-hook.ts`)拆解**:Project/Requirement/Wiki Baseline → system 段渲染器(on-demand);Steps Progress → workbench 渲染器;`memoryContext` 误标修正(它装的不是 memory)。hook 大幅瘦身/拆分,内容各归各位。

**notification hook(`notification-hooks.ts:34`)取代**:完成通知进 workbench(每 step 新鲜、不累积),删 addMessage 持久路径 → 少一类累积消息。

### 1.2 三通道最终内容

- **system**(按需):role · guidelines · 工具表 · OS/cwd · Wiki Anchors(根+一层)· Project · Requirement
- **context**(持久,事件累积):Recalled Memories(仅此)。recall 源 = **wiki memory 子树(per-agent `memory/<agentId>/`)**;但**本次不做** —— 记忆写入尚未完善。本次只建 context 持久通道**机制**(事件 addMessage + 去重),recall 接入待记忆写入就绪后单独开。
- **workbench**(每 step,非持久):date/time · todos · task 状态 · Steps Progress · wait 状态

### 1.3 落地改动

1. **system**:`assembleSystemPrompt()` 改为**仅按需重建**(依赖 invalidate,不每 turn 重算 —— 现已基本如此,base/wiki-system-anchors 均 cacheBreak:false)。新增 Project/Requirement/OS/cwd/Wiki Anchors 段。
2. **context**:从"每 turn 重建块"改成"recall 事件 addMessage 进历史的持久日志";`<context>` 包装基本消失。去重(已 recall 过的不重加)。
3. **workbench**:每 step 渲染并**追加成 user 消息到 `stepMessages` 末尾**(非持久,不入 `messages` → 不累积)。**append 而非 prepend** —— turn 内 step 2+ 最新消息常是 tool result(数组结构),prepend 字符串破坏格式;append format-safe(与 task-control `[control]` 同机制)。`prependContext` 不改(仍只用于 context 块 step-1)。dirty 检查暂缓(workbench 紧凑,每 step 注入 tokens 可忽略;后续 task/wait 内容变大再加)。落地见 sub-1。
4. **拆 work-context hook、删 notification addMessage 路径、删 resolveCurrentTask**。

### 1.4 cache 与代价

- **system** = 稳定强 cache(按需重建,命中率高)。
- **workbench** 拼在尾部最新内容前,属 step 自然增长(每 step 本就在尾部加消息),**不额外打断 system cache**。freshness 代价仅这条块每 step 重计。
- **context 持久累积**:长 session 历史会涨。靠"只追加新 recall + 去重"缓解;recall 本就零星。

### 1.5 现状基线(参考 —— 为什么要改)

- system:`assembleSystemPrompt()`([agent-loop.ts:662](../../../src/runtime/agent-loop.ts#L662))每 turn assemble;`base`+`wiki-system-anchors` 均 cacheBreak:false,`SystemPromptAssembler`([prompt-sections.ts:44](../../../src/runtime/prompt-sections.ts#L44))缓存,hot config 时 invalidate。
- context:`buildContextMessage()` turn 起点建一次,重渲染条件 `stepNumber===1 || memoryContext!==undefined`([agent-loop.ts:749](../../../src/runtime/agent-loop.ts#L749));`prependContext` 只在末条 user 时拼 → turn 级快照,todos mid-turn stale。
- step 级:`appendMessages`(非累积,task-control/input-queue/providerOptions)与 `session.addMessage`(累积,notification)两条混用。

---

## 2. 域一:父子 session 的结束与重建恢复

### 2.1 turn 结束语义 —— 强制 Wait(已定)

**只要有后台 task 在跑,就一直提示 Wait**(不结束父 turn)。落点:PostTurnComplete / finish-step **hook**(符合"功能走 hook"红线)—— 父 turn 想结束时若仍有 running 后台 task,注入 system step "还有 task 在跑,请 Wait" 再跑一步,让 LLM 调 Wait。

收益:父 turn 在后台 task 跑完前**不结束** → 后台子不再可能越过父 turn 变孤儿 → "父 turn 已完成 + 孤儿后台子 → 不通知"特例**消失**,recovery 塌缩成一条线(崩溃只可能发生在父 mid-Wait 或 mid-run,父必 incomplete → auto-resume)。

→ 原"[最阻塞] 后台子是否越界"事实确认**不再需要**:无论现状如何,行为统一为 force-Wait,后台子结构上不可能越过父 turn。

### 2.2 recovery 分流(已对齐)

启动时按 `session_kind`(`session-db.ts:189`、`:286`)分流:

- **父 session(`session_kind='chat'`)**:auto-resume 执行(照旧)。
- **委派子 session(`session_kind='delegated'`)**:启动**不 auto-run**,冻结在 interrupted(turn_state 留 incomplete),等父决定。

现状问题:`doRecoverIncompleteSessions`([agent-service.ts:1047](../../../src/server/agent-service.ts#L1047))对 `getIncompleteTurns()`(`session-db.ts:847`)返回的每个 turn 无差别 `loop.resume()`,不看 session_kind → 子独立 auto-run,与父脱钩(结果孤儿或重复派发)。

### 2.3 父决定续子

- **中断子 = 普通 task,状态 `Interrupted`**(无特殊处理):子 session 冻结不 auto-run(§2.2),但子的 **task 记录由 `restoreDelegatedTasks` seed 进父 TaskRegistry**([agent-loop.ts:464](../../../src/runtime/agent-loop.ts#L464))→ 父 workbench 的 Task 段照常显示 `[taskX] Interrupted`,跟中断前一样。
- **详细信息/结果走工具**(跟普通 task 一样):`TaskGet`(interrupted) 给 registry 信息 + waited 时间 + "[interrupted by restart]" 说明;近期调用记录要等 resume 后子 loop 活才有(§4.2)。
- 真实wait时间 = `now − delegated_tasks.created_at`,**含停机(wall-clock)**。
- 链路靠 `delegated_tasks.parent_tool_call_id`([subagent-delegator.ts:79](../../../src/runtime/subagent-delegator.ts#L79))。
- **阻塞 delegate**(Subagent 现在只 blocking)的 pending 工具调用若被中断:替换 `[interrupted]` 合成([session.ts:334](../../../src/runtime/session.ts#L334) `synthesizeDanglingToolResultsInPlace`)为带状态/wait时间的结果。后台 task(via TaskStart)走 §4 的收件箱路径,不涉及此。
- 续 → 懒建子 loop + `loop.resume(子 turnSeq/stepSeq)`;不续 → `TaskKill`(abandon)标 turn_state 终态。
- 决策入口(已定):**`TaskResume task_id`**,**非阻塞** —— 立即返 `子已恢复,task_id:X`,父靠 workbench 看进度 / `TaskGet` 取结果(force-Wait 保证父在子跑完前不结束 turn)。

### 2.4 按需重建(懒)

`restoreAllSessions`([agent-service.ts:1104](../../../src/server/agent-service.ts#L1104))现在 eager 全建。改成:只给"有 incomplete turn"的建;UI 显示走 `activateSession`(已有);父续子时懒建。审 `this.loops.has` / `getRuntimeTaskTree` / config-sync 假设。

---

## 3. 域二:task / wait 工具

### 3.1 Wait 现状

- 事件驱动:`suspendUntilWake`([task-registry.ts:216](../../../src/runtime/task-registry.ts#L216))timeout + 任一后台子完成即唤醒。`wakeCallback` **纯内存,崩了即丢**。
- 只有相对 timeout,**无"等到时间点"**。

### 3.2 Wait —— 通用 session 挂起工具(已定)

**Wait 不绑定 task,是通用 session 挂起**。输入仅 `until`(绝对时间点)/ `timeout`(相对),**无 task_id**。三个 wake 源,任一即打断:
- **到点**:`until` / `timeout` 达到。
- **任意 task finish**:任何后台 task 完成(全局 task 事件,非特定 task)。
- **user 输入**:打断 Wait,**开新 turn(turn+1)**(见 §3.3)。

**不是 cron**(概念共享"持久化到点触发",但):fire 动作 = 唤醒挂起 step 续跑(非注入 prompt)、有非时间触发源(any-task / user)、运行时进程内挂起不需要 scheduler。**不 reuse crons 表**。

**carrier = 无新增**。wait 状态就是持久化 step 里那个 pending Wait 工具调用的 args(`until`/`timeout`,step 工具块 `b.args` 持久化,[session.ts:396](../../../src/runtime/session.ts#L396))。
- 运行中:进程内挂起(busy 释放,§3.3),event loop 驱动,不落额外表。
- 重启 recovery:扫持久化 step,发现 pending Wait 工具调用 → 读 args → 判 `until` 是否到点 → 重挂起 or 填结果。停机期间任意 task 终态由重挂起后的 any-finish 检查自然触发。
- **resume 分支**:pending Wait 工具调用**不走** `synthesizeDanglingToolResultsInPlace` 的 `[interrupted]`([session.ts:334](../../../src/runtime/session.ts#L334)),走专门 wait-resume 分支。
- 约束:绝对 `until` 天然可持久;相对 `timeout` 需 step 工具块存 `startedAt`。durable 优先 `until`。

### 3.3 Wait 期间的 session 状态(已定)

- **Wait ≠ running**:Wait 期间 session **不算 running 态**(UI 不显示 busy),`busy` 释放(或引入独立 `waiting` 态),wake 时重获。
- **user 输入正常**:用户可正常输入。
- **user 输入打断 Wait = turn+1**:user 消息起**新 turn**(turn_seq+1),Wait 返 interrupted、当前 turn 结束。**不是 mid-turn StepStart 注入**(取消"复用 input-queue 注入"的说法 —— input-queue 仍是 turn 内 deferred 注入,与 Wait-user-interrupt 不同路径)。
- 落地:`suspendUntilWake`([task-registry.ts:216](../../../src/runtime/task-registry.ts#L216))现在挂 turn 内(`busy=true` 整段);改成挂起释放 busy、wake 重获。三个 wake 源(到点 / any-task-finish / user-input-turn+1)都打断挂起。

---

## 4. 域三:工具重构 —— 后台任务归 Task

**原则**:后台任务全部归 **Task** 命名空间;**Subagent / Shell 本身只 blocking**;**Subagent delegate 超时自动后台保留作 safety net**(父得 task_id 不卡死),**Shell 前台超时 throw**(原行为,长 Shell 任务用 `TaskStart`);显式后台唯一入口 = `TaskStart`。task 通用操作对 subagent 和 bash 都生效(不为 bash 单做一套)。

### 4.1 工具布局

**Task 工具族(后台任务全生命周期,通用):**

| 工具 | 职责 | 适用 |
|---|---|---|
| `TaskStart` | 显式后台启动(agent 或 shell),返 task_id | agent + shell |
| `TaskList` | 列表 + tree(`taskIds?` 过滤,树结构文本),属性比 workbench 多 | 通用 |
| `TaskGet` | 单 task 钻取(按状态分返,见 §4.2);completed 取走 result+acknowledge | 通用 |
| `TaskKill` | 丢弃:running→kill,interrupted→abandon | 通用 |
| `TaskFinish` | 优雅收尾(advisory + turn budget) | **仅 agent** |
| `TaskResume` | 解冻冻结子(懒建 loop + resume,非阻塞) | **仅 agent** |

**Subagent**(同步委派):`delegate`(blocking;超时自动后台 safety net)+ `list`(可委派角色)。  
**Shell**(同步命令):blocking(去 `background:true`;**前台超时 throw**,长任务用 `TaskStart`)。  
**Wait / TodoWrite** 不变。

**删 / 合并 / 改名**:
- ~~`Subagent/stop`~~ + ~~`TaskStop`~~ → **`TaskKill`**(通用,扩 interrupted)。
- ~~`Subagent/complete`~~ → **`TaskGet`(completed)** 做 result + acknowledge。
- ~~`Subagent/tree`~~ → 并入 **`TaskList`**。
- ~~`Subagent/request_finish`~~ → **`TaskFinish`**;~~`Subagent/resume`~~ → **`TaskResume`**。
- ~~`Subagent/delegate mode:non_blocking`~~ + ~~`Shell background:true`~~ → 显式后台统一走 **`TaskStart`**。
- ~~`TaskStatus`~~ → 改名 **`TaskGet`**(Get 体现 completed 取走数据)。
- `TaskList` **恢复**(含 tree,富于 workbench)。

### 4.2 TaskGet —— 单 task 钻取(按状态分返)

| 状态 | 返回 |
|---|---|
| running | **近期调用记录**:经 `ctx.getTaskRecentCalls(taskId)` 返最近 **N=3** 条工具调用(name + 简要 args),**只返调用记录,不返工具输出** |
| interrupted | registry 信息 + waited(`now−created_at`,含停机)+ "[interrupted by restart]";近期调用记录待 TaskResume 后(子 loop 冻结无 live 数据) |
| completed | **完整 result + `acknowledge`** —— 消费后从 registry/workbench 删 |

**数据源 `ctx.getTaskRecentCalls`**(runtime→runtime,不跨层、不读 server DB):
- **agent**:子 loop 同进程,delegator `runningSubloops`([subagent-delegator.ts:498](../../../src/runtime/subagent-delegator.ts#L498))持有,读近期 step 的 tool-call 块(name+args,剥输出)—— UI 渲染子 session 的同源数据,现成。
- **bash**:单命令无调用序列,只 status+elapsed+command(现成),**不暴露 stdout**(原"暴露 stdoutChunks"小改取消)。

**渲染**:调用记录一行 `工具名(args 摘要)`(类似 UI 折叠态),不带输出;输出仅 completed 经 TaskGet 取 result。

### 4.3 三级 zoom + workbench 收件箱

| 层 | 范围 | 内容 | 何时 |
|---|---|---|---|
| **workbench · Task** | 自己直接 task(不递归) | **id + status 极简**(基本只状态) | 每 step |
| **TaskList** | 全任务(含嵌套 tree) | 富列表 + 树结构文本 | 按需 |
| **TaskGet** | 单 task | 钻取(§4.2) | 按需 |

- workbench 收件箱:**running 一直在;终态留到被 `TaskGet`(completed) 消费才删**。
- → **notification hook(`notification-hooks.ts:34`)及 `notified` 标志删除** —— 收件箱覆盖完成通知。
- workbench 注入富度 = **紧凑档**(只 id+status),富信息走 TaskList/TaskGet/blocking;token 不随任务数膨胀。

---

## 5. 开放决策清单

> 用户确认前不进 plan。上下文注入部分(§1)已定稿。

**已定**:
- [x] 三通道模型(system 按需 / context 持久 / workbench 每 step)+ 命名 `<workbench>`。
- [x] 完整分配表(§1.1):todos/Steps Progress/task 状态/wait/date/time → workbench;OS/cwd/Guidelines/Wiki Anchors/Project/Requirement → system;Recalled Memories → context(持久)。
- [x] Current Task 丢弃(被 work-context hook 的 Requirement 覆盖)。
- [x] Wiki Anchors(根+一层)→ system,默认不更新,特殊时机刷新。
- [x] work-context hook 拆解、resolveCurrentTask 删除。
- [x] **工具重构:后台归 Task**(§4):`TaskStart`(显式后台,agent+shell)/ `TaskList`(列表+tree,富)/ `TaskGet`(单 task 钻取,completed 取走 result+acknowledge)/ `TaskKill`(丢弃,running→kill interrupted→abandon)/ `TaskFinish`(仅 agent)/ `TaskResume`(仅 agent,非阻塞)。
- [x] Subagent / Shell 只 blocking;**Subagent delegate 超时自动后台保留 safety net**,**Shell 前台超时 throw**(长任务用 `TaskStart`);显式后台唯一入口 `TaskStart`;去 non_blocking / `background:true`。
- [x] 删/合并/改名:stop→`TaskKill`、complete→`TaskGet`、tree→`TaskList`、request_finish→`TaskFinish`、resume→`TaskResume`、TaskStatus→改名 `TaskGet`。
- [x] `TaskGet` 近期调用记录数据源 `ctx.getTaskRecentCalls`(N=3,只调用记录不输出):agent 走子 loop(现成)、bash 不暴露 stdout。
- [x] 三级 zoom:workbench(id+status 极简)→ TaskList(富列表+tree)→ TaskGet(单个钻取)。
- [x] workbench 收件箱(终态留到 TaskGet 消费)取代 notification hook(+ `notified` 标志删除);注入富度 = 紧凑档。
- [x] **force-Wait**(§2.1):有后台 task 就一直 Wait,后台子结构上不可能越过父 turn。
- [x] **Wait 期间 ≠ running**,user 输入正常 + 作为 wake 事件(§3.3)。
- [x] **Wait = 通用 session 挂起**(不绑 task),wake = 到点 ∪ any-task-finish ∪ user-input(turn+1)(§3.2)。
- [x] **durable Wait 无独立 carrier**:wait 状态即持久化 step 里 pending Wait 工具调用的 args;不扩 turn_state、不加表、不 reuse crons(§3.2)。
- [x] **中断子无特殊处理** = 普通 task 带 `Interrupted` 状态在 workbench;详情/wait时间走 `TaskGet`(interrupted)(§2.3)。
- [x] **冻结子幂等再现接受**(④ 定案):父不决策则重启再显 Interrupted;主动清理用 `TaskKill`(interrupted→abandon)。
- [x] **Recalled Memories recall 源** = wiki memory 子树(per-agent `memory/<agentId>/`);**本次不做**(记忆写入未完善),只建 context 持久通道机制,recall 接入后续单独开(⑤ 定案)。

**待确认**:无 —— 全部定案。

## 6. 实施顺序建议(参考,进 plan 时定)

1. **workbench 通道**(§1)+ todos 迁移 —— 独立、低风险,先落地,顺带修 stale todo bug。
2. **recovery 按 session_kind 分流 + 懒重建**(§2.2、§2.4)—— 不依赖 force-Wait。
3. **事实确认后台子越界** → 决定 force-Wait(§2.1)+ durable Wait(§3.2)。
4. **工具简化**(§4)—— 依赖 workbench 通道先就位。

## 关联代码

- 注入:`prompt-sections.ts`、`context-message.ts`、`agent-loop.ts`:649/687/749/829
- 恢复:`agent-service.ts` `doRecoverIncompleteSessions`:1047、`restoreAllSessions`:1104、`recoverIncompleteSessions`:1036;`session-db.ts` `getIncompleteTurns`:847、session_kind:189/286
- resume:`agent-loop.ts`:325;合成:`session.ts`:334/539
- 委派:`subagent-delegator.ts` 阻塞 await:372、parent_tool_call_id:79
- Wait:`tools/wait.ts`、`task-registry.ts`:216
- 工具名:`Subagent`/`TaskStatus`/`TaskList`/`TaskStop`/`TodoWrite`/`Wait`/`Orchestrate`

## 相关记忆

- [[project-recovery-wikistore-startup-race]](recovery 启动顺序 race,已修)
- [[feedback-agent-loop-hooks-only]](功能走 hook)
