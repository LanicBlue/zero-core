# Design: session-turn-lifecycle

> **状态**：2026-07-17 经用户确认；Ready，尚未实施。  
> **问题**：[issue.md](./issue.md)。  
> **研究**：[research.md](./research.md)。

## 0. 结论

zero-core 使用一个 Session runtime supervisor 统一管理：

- 长期 Session；
- 每次前台执行的 TurnRun；
- 当前不可变 invocation；
- 普通输入 inbox；
- 跨 Turn 的后台任务事件 inbox；
- cancellation scope；
- waiting、AskUser、compacting 和 system continuation。

`AgentService.runStates` 与 `SessionManager.lifecycle` 不再分别解释状态；UI、API、输入路由和
runtime 都消费同一个 `SessionRuntimeSnapshot`。

## 1. 核心不变量

1. 一个 Session 同时至多有一个 active TurnRun。
2. TurnRun 的 identity 不等于持久 step，也不恢复已退役的 `turns` 表。
3. 旧 Turn 的控制事件不能改变新 Turn。
4. Session 后台任务的 progress/terminal event 可以跨 Turn。
5. Stop 取消前台 Turn，并暂停普通输入自动消费。
6. Stop 不取消显式后台任务；后台任务只接受任务级 cancel。
7. 只要存在 running/finishing 后台任务，Session 必须有 active TurnRun 承接它们。
8. 有后台任务时 Agent 不能主动完成 Turn；最终由 runtime barrier 保证，而非只靠 prompt。
9. 外部 invocation 只在声明的安全边界 handoff，不硬中断任意工具副作用。
10. compacting 是可见状态，commit 临界段不能被破坏性中断。

## 2. 模型

### 2.1 Session

Session 是长期对话与项目上下文容器，不因用户消息、Work 或 Cron 各建一个新 Session。
它拥有 supervisor、普通 inbox、task event inbox 和后台任务目录。

### 2.2 TurnRun

```ts
type TurnRunKind = "invocation" | "system_continuation";

type TurnRunStatus =
  | "starting"
  | "running"
  | "waiting"
  | "needs_input"
  | "compacting"
  | "cancelling"
  | "superseded"
  | "completed"
  | "failed";

interface TurnRun {
  id: string;
  sessionId: string;
  kind: TurnRunKind;
  invocation?: TurnInvocationEnvelope;
  status: TurnRunStatus;
  startedAt: number;
  cancellation: TurnCancellationScope;
}
```

TurnRun 主要是运行时 identity 和 fencing token。是否持久化最小审计字段由 Plan 00 根据合并
后数据库决定；首版不为它重建完整消息表。

### 2.3 Session projection

```ts
type SessionRuntimeState =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "needs_input"
  | "compacting"
  | "cancelling"
  | "recovering"
  | "error"
  | "disposed";

type WaitReason =
  | "agent_wait"
  | "background_barrier"
  | "provider_capacity"
  | "tool_capacity";

interface SessionRuntimeSnapshot {
  sessionId: string;
  state: SessionRuntimeState;
  activeTurnRunId?: string;
  activeTurnKind?: TurnRunKind;
  waitReason?: WaitReason;
  stopRequested: boolean;
  queuePaused: boolean;
  queuedInputCount: number;
  background: { running: number; finishing: number };
  compactionPhase?: "memory" | "rewrite" | "commit";
  pendingAskUser?: { requestId: string; turnRunId: string };
  revision: number;
}
```

`background_barrier` 是 `waiting` 的 reason，不增加平行主状态。`queued` 表示没有正在执行
provider/tool、且普通 inbox 有可运行输入；被 Stop 暂停的 inbox 通过 `queuePaused=true`
表达，此时没有 active Turn 的 Session 保持 idle。provider capacity 使用
`waiting(provider_capacity)`，不再复用 queued。

## 3. 唯一状态所有者

新增或提取 `SessionRuntimeSupervisor`，它串行处理每个 Session 的 command/event，并发布
带单调 `revision` 的 snapshot。AgentService、SessionManager、Loop、TaskRegistry、AskUser、
compression coordinator 和 UI 不直接互相改布尔值。

```text
command/event
    → per-session serialized reducer
    → effect request（run/abort/wake/compact）
    → effect completion event
    → new snapshot revision
```

副作用在 reducer 外执行，但完成事件必须携带 scope 和 identity 后再归并。

## 4. 事件作用域与 fencing

### 4.1 Turn control event

模型流、tool start/end、AskUser response、Wait 结束、abort completion、agent end 和
compaction phase completion 都携带 `turnRunId`。只有与 active TurnRun 匹配时才能改变
前台状态；晚到事件可以记录调试信息，但不得更新新 Turn 的 streaming/tool/state。

### 4.2 Session task event

```ts
interface SessionTaskEvent {
  eventId: string;
  sessionId: string;
  taskId: string;
  originTurnRunId: string;
  type: "progress" | "completed" | "failed" | "cancelled";
  payload: unknown;
  occurredAt: number;
}
```

任务事件不按当前 TurnRun id 过滤。supervisor 以 `eventId` 幂等接收，写入 Session Event
Inbox；在当前 Turn 的安全 step 边界注入，或唤醒 continuation/barrier。持久 delegated task
的 terminal event 需要 durable delivery；纯进程内任务只承诺进程生命周期内交付。

## 5. Invocation 与普通 inbox

```ts
interface TurnInvocationEnvelope {
  invocationId: string;
  source: "user" | "work" | "cron" | "subagent" | string;
  content: UserContent | string;
  context: unknown; // Agent Eval Plan 04 切换为 TurnInvocationContext
  delivery: "next_turn" | "next_step";
  enqueuedAt: number;
}
```

- 普通用户 `next_turn` inbox 首版保持内存态和 FIFO。
- WorkRun 仍使用 Core DB durable queue；被 dispatcher claim 后才形成 invocation。
- 调度优先级由调用方/未来配置决定，本设计不硬编码 Work/Cron 业务顺序。
- Stop 后 inbox 进入 paused，不自动 drain；新的明确用户发送或外部 dispatch 可启动/handoff。
- `next_step` 即现有 `insert_now`：只允许文本、只在安全 StepStart 注入、成功 StepEnd commit。
- 若 Turn 在注入前结束，`next_step` 自动降级为 `next_turn`，不能永久滞留。
- 队列项最终保存完整 immutable invocation，而非继承上个 Turn 的 source/cwd。

## 6. Wait 与 handoff

Wait 不是 Turn 结束，而是 active TurnRun 的挂起：

```text
running → waiting(agent_wait)
```

唤醒原因集中仲裁并记录：task event、用户 invocation、Cron/Work invocation、timeout、Stop。
同一 reducer tick 内使用确定性规则，重复 callback 只能产生一次结论：

```text
Session dispose
  > Stop
  > 匹配 requestId/turnRunId 的 AskUser 回答
  > scheduler 已选定的新 invocation
  > task terminal event
  > timeout
```

优先级只决定当前 Turn 如何退出 Wait，不丢弃其余输入：未获胜 invocation 保留在普通/
durable inbox，task event 保留在 Session Event Inbox；只有已被更高优先级取代的 timeout
outcome 可以丢弃。多个 invocation 之间的选择由 scheduler 提供的 priority + enqueue
sequence 决定，本生命周期层不写死 user/Work/Cron 的业务优先级。

- task event：唤醒同一 Turn，在安全 step 注入结果；
- timeout：唤醒同一 Turn并返回 timeout outcome；
- Stop：进入 cancellation；
- 新 invocation：原子 handoff，旧 Turn 标记 superseded，新 Turn 成为 active；
- 后台任务不随 handoff 转移或取消，因为它们属于 Session。

running 中到达的普通 invocation 默认入 inbox；只有 already waiting/barrier/needs_input 的
Turn 可被 handoff。`insert_now` 仍走 next-step，不把 handoff 伪装成硬抢占。

## 7. 后台任务硬门禁

Turn 尝试完成时：

```text
无 running/finishing task → completed
有 task，首次尝试       → 注入一次 Wait 提醒，继续一个 model step
Agent 调用 Wait         → waiting(agent_wait)
Agent 再次尝试完成       → waiting(background_barrier)，不再调用模型
```

barrier 由 runtime 保证：

- terminal task event 唤醒 continuation/当前 Turn；
- 所有任务 terminal 后允许 Turn 正常完成；
- 新 invocation 可原子 handoff；
- barrier 不循环生成提醒或模型调用。

### 7.1 system continuation Turn

Stop、错误隔离或允许的 handoff 使原前台 Turn 终止，但后台任务仍存在时，supervisor 在同一
状态事务中创建：

```ts
{ kind: "system_continuation", status: "waiting" }
```

它没有用户 invocation，处于 `waiting(background_barrier)`，不消耗模型。收到 task terminal
event 后才恢复一个系统处理 step，或在新 invocation 到达时被 supersede。这样不存在后台
任务“没有 Turn”的窗口。

## 8. Stop 与 cancellation tree

### 8.1 语义

Stop 是 `cancel_active_turn`：

1. snapshot 进入 cancelling，普通 inbox paused；
2. abort 当前前台 cancellation scope；
3. provider stream/并发 acquire、工具限流、Wait、AskUser 和 blocking child 都接收 signal；
4. 不再开始 queued input，不再启动新的普通 tool/model step；
5. effect 全部 settle 后，若无后台任务则 idle + queuePaused，否则创建 continuation Turn。

UI 只有在 backend snapshot 确认后才结束 streaming，不先做不可逆 optimistic finish。

### 8.2 cancellation tree

```text
Session dispose scope
└── Turn cancellation scope
    ├── provider stream + concurrency wait
    ├── tool rate-limit wait
    ├── Wait / AskUser
    ├── blocking foreground child
    └── cooperative tool execution

Session task scope（不在 Turn Stop 子树）
└── explicit background task
```

工具在副作用提交前检查 signal；已经进入不可回滚临界段的工具完成最小一致性提交后返回
cancelled/settled。不得声称 Stop 能回滚已经发生的外部副作用。

### 8.3 AskUser

AskUser request 绑定 `turnRunId + requestId`：

- 对应回答只恢复同一 active Turn；
- Stop/dispose/supersede 以结构化原因 settle pending promise；
- 普通新 invocation 若选择 handoff，先 supersede AskUser Turn；
- 旧回答不得注入新 Turn。

## 9. compacting

compacting 是 Session 主状态，并暴露 phase：

```text
running → compacting(memory → rewrite → commit) → running/waiting/terminal
```

- memory/rewrite 阶段 cooperative cancel，可在进入 commit 前停止；
- commit 是最小不可中断临界段，Stop 只设置 `stopRequested`，commit settle 后再完成 cancellation；
- 普通 invocation 在 compacting 期间入 inbox，不在中间替换上下文；
- background task event 继续进入 Session Event Inbox；
- commit 后先处理 Stop，再处理 handoff/queue，不能用旧 Turn completion 覆盖新状态；
- UI 显示 compacting 和 phase，不伪装成普通 streaming 或 idle。

## 10. 恢复与持久性

- 普通用户 inbox 不跨进程恢复。
- 已持久 WorkRun、delegated task 和其 delivery ledger 按现有/Agent Eval 可靠性契约恢复。
- restart 若发现 running task 且无 active Turn，创建 recovering → system continuation。
- event dedupe 至少覆盖持久 task 的 terminal delivery。
- 不持久化瞬时 streaming text、tool spinner 或 AbortController。

## 11. UI 与 API

UI 使用 snapshot revision，忽略旧 revision：

- Stop 按钮在 running/waiting/needs_input/compacting 可用；
- cancelling 有明确反馈；
- waiting 显示 waitReason；
- needs_input 显示 AskUser；
- compacting 显示 phase；
- queued 同时显示 paused 与 count；
- background task count 独立于前台状态显示。

HTTP/WS initial snapshot 和增量 event 使用同一 DTO；重连后 snapshot 是真相源，不靠客户端
重放布尔事件猜状态。

## 12. 与其他计划的边界

### wiki-system-redesign

当前手动硬门禁：Wiki 最终验收并合并后才能执行 Plan 00。这不是当前 Flow runtime 依赖。

### agent-eval-harness

- 本计划先稳定 TurnRun、snapshot、handoff、queue pause 和事件作用域。
- Agent Eval Plan 04 把 `TurnInvocationEnvelope.context` 收紧为不可变
  `TurnInvocationContext`，并接入 durable WorkRun dispatcher。
- 两个计划不得各自保留一套 Session busy/queue 判断。

### local-backend-security-boundary

安全计划保护 HTTP/WS/IPC 边界；本计划定义其上传输的生命周期 DTO。两者无产品语义依赖，
但若并行修改 server event wiring，必须分 worktree 并在各自 Plan 00 记录合并顺序。

## 13. 失败语义

- cancellation 不是 error；UI/metrics 分开统计。
- superseded 不是 cancellation failure。
- background task failed 是 Session task event，不自动把无关的新 Turn 标成 failed。
- compaction failure 回到可运行 snapshot，并保留原上下文；不得提交半份 cursor。
- reducer/effect 边界出现未知事件时记录并拒绝状态变更，不能猜测 active Turn。

## 14. 已拒绝方案

- **只给两个 queue API 加 AbortSignal**：不能解决 Stop drain、Wait、AskUser、后台事件和 UI。
- **所有旧 Turn 事件一律丢弃**：会丢掉合法的跨 Turn 后台任务结果。
- **Stop 取消所有后台任务**：违背显式后台工作的独立生命周期。
- **允许后台任务悬空且没有 Turn**：破坏 Wait/提醒语义和结果承接。
- **force-Wait 只靠 prompt**：Agent 可忽略；runtime 必须有 barrier。
- **持久化所有聊天输入**：首版收益不足，并混淆普通 inbox 与 durable WorkRun。
- **insert_now 硬抢占工具**：无法安全回滚副作用。
- **把 compacting 当 streaming 文案**：不能表达 Stop、安全提交和外部 input 行为。

## 15. 决策记录

| ID | 决策 |
|---|---|
| D1 | SessionRuntimeSupervisor 是生命周期唯一状态所有者。 |
| D2 | 一个 Session 同时至多一个 active TurnRun。 |
| D3 | Turn control event 以 turnRunId fencing；task event 是 Session scoped。 |
| D4 | Stop 取消前台并暂停普通 queue，不自动 drain。 |
| D5 | 显式后台任务不继承 Turn Stop。 |
| D6 | 后台任务存在时必须有 active/continuation Turn。 |
| D7 | 一次提醒后由 background barrier 硬阻止 Agent 自行结束。 |
| D8 | waiting 时新 user/Cron/Work invocation 可原子 handoff。 |
| D9 | insert_now 只做 next-step 软插入。 |
| D10 | 普通 chat queue 首版内存态；WorkRun/task delivery 可持久。 |
| D11 | compacting 是 UI 可见主状态，commit 临界段不可破坏性中断。 |
| D12 | AskUser、Wait、provider/tool queue 共用 Turn cancellation tree。 |
