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
- 事务化 Model Step、Provider retry wait、circuit recovery 和 Subagent Provider 恢复。

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
11. Provider API retry 对对话默认无感，但对 runtime snapshot、Stop 和 handoff 可见。
12. 未成功形成 `ModelStepProposal` 的 Provider stream 不得执行本地工具。
13. 只有成功 proposal 才能进入 tool execution；tool effect 使用独立 ledger/checkpoint。
14. 同一 Provider 的 Main/Subagent 共享 availability supervisor，不各自探测恢复。
15. 恢复只重放未提交 Provider attempt，不重跑整个 Turn 或已封存 Step。
16. Provider/model/context 或副作用确定性变化时，负责执行的 Agent 必须收到 recovery notice。
17. 首页是 Provider Runtime 的全局控制面；手动重试只申请一个受 circuit 约束的 probe，
    不能直接批量唤醒 waiter。

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
  | "provider_retry"
  | "provider_quota"
  | "provider_suspended"
  | "provider_config"
  | "tool_capacity";

type ProviderResumeTrigger =
  | "timer"
  | "circuit_probe"
  | "credential_revision"
  | "config_revision"
  | "manual_retry";

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
  providerAttempt?: {
    callId: string;
    attemptId: string;
    stepSeq: number;
    phase:
      | "calling"
      | "retry_wait"
      | "quota_wait"
      | "suspended"
      | "config_wait"
      | "half_open"
      | "recovery_required";
    burstAttempt: number;
    lifetimeAttempt: number;
    errorClass?: string;
    nextRetryAt?: number;
    resetAt?: number;
    resumeOn: readonly ProviderResumeTrigger[];
    provider: string;
    model: string;
  };
  compaction?: {
    cycleId: string;
    trigger: "preferred" | "hard" | "manual";
    phase: "preparing" | "running" | "commit" | "blocked";
    memory: {
      state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
      outcome?: "written" | "no_change";
    };
    compression: {
      state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
      passIndex?: number;
      passCount?: number;
    };
  };
  pendingAskUser?: { requestId: string; turnRunId: string };
  revision: number;
}
```

`background_barrier` 是 `waiting` 的 reason，不增加平行主状态。`queued` 表示没有正在执行
provider/tool、且普通 inbox 有可运行输入；被 Stop 暂停的 inbox 通过 `queuePaused=true`
表达，此时没有 active Turn 的 Session 保持 idle。provider capacity 使用
`waiting(provider_capacity)`，不再复用 queued。

### 2.4 事务化 Provider Step

```ts
interface ProviderRequestSnapshot {
  callId: string;
  sessionId: string;
  turnRunId: string;
  stepSeq: number;
  requestDigest: string;
  provider: string;
  model: string;
  providerRouteRevision: number;
  messages: readonly unknown[];
  toolSchemas: readonly unknown[];
  providerOptions: Readonly<Record<string, unknown>>;
}

interface ModelStepProposal {
  callId: string;
  committedAttemptId: string;
  text: string;
  reasoning?: string;
  toolCalls: readonly unknown[];
  usage?: unknown;
  providerResponseId?: string;
}

interface ProviderCallCheckpoint {
  callId: string;
  turnRunId: string;
  stepSeq: number;
  lastSealedStepSeq: number;
  requestDigest: string;
  providerRouteRevision: number;
  lastCredentialRevision?: number;
  attemptId: string;
  burstAttempt: number;
  lifetimeAttempt: number;
  state:
    | "calling"
    | "retry_wait"
    | "quota_wait"
    | "suspended"
    | "config_wait"
    | "half_open"
    | "recovery_required"
    | "proposal_ready"
    | "committed";
  errorClass?: string;
  nextRetryAt?: number;
  resetAt?: number;
  resumeOn: readonly ProviderResumeTrigger[];
}

type ProviderAvailabilityState =
  | "healthy"
  | "busy"
  | "retrying"
  | "quota_wait"
  | "suspended"
  | "config_required"
  | "half_open"
  | "disabled";

interface ProviderAvailabilitySnapshot {
  availabilityKey: string;
  state: ProviderAvailabilityState;
  circuit: "closed" | "open" | "half_open";
  revision: number;
  inFlight: number;
  maxConcurrency: number;
  waiting: number;
  affectedSessions: number;
  affectedTasks: number;
  lastErrorClass?: string;
  nextProbeAt?: number;
  resetAt?: number;
  manualRetry:
    | { allowed: true }
    | { allowed: false; reason: "healthy" | "probe_in_flight" | "before_reset" | "min_probe_at" | "no_waiter" | "disabled" };
}

interface ProviderRuntimeSnapshot {
  providerId: string;
  name: string;
  enabled: boolean;
  aggregateState: ProviderAvailabilityState;
  revision: number;
  availability: readonly ProviderAvailabilitySnapshot[];
}
```

`ProviderRequestSnapshot` 在第一次 attempt 前冻结。endpoint、model、options 等语义路由由
`providerRouteRevision` 锁定；credential secret 不进入 snapshot。Provider Runtime 可在不改变
语义路由的前提下按最新 `credentialRevision` 重新取证，checkpoint 只记录使用过的 revision，
不记录 credential。endpoint、model 或 provider options 变化必须进入 recovery decision，不能
偷偷改变原 snapshot。

Provider stream 的 text/reasoning/tool-call 都是 provisional preview，携带 attemptId。
只有收到成功终止并形成完整 `ModelStepProposal` 后，Turn coordinator 才提交 proposal。
本地 ToolExecutor 只消费已提交 proposal；其 effect ledger、幂等与崩溃恢复不属于
Provider retry。

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
  context: unknown; // Agent Work Runtime Plan 02 切换为 TurnInvocationContext
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

## 9. Provider API retry 与恢复

### 9.1 所有权分层

```text
SessionRuntimeSupervisor
└── TurnExecutionCoordinator
    ├── ProviderRuntime
    │   └── ProviderAdapter
    └── ToolExecutor
```

- ProviderAdapter 把 SDK/HTTP 错误规范化为稳定 error class，保留 status、Retry-After、
  provider request/response id 和 retryability，不用字符串 regex 作为唯一依据。
- ProviderRuntime 拥有 attempt、backoff、Retry-After、circuit breaker、half-open、
  concurrency lease、credential refresh 和公平唤醒。
- TurnExecutionCoordinator 拥有 request snapshot、turnRunId fencing、proposal commit、
  Stop/supersede 和 recovery notice。
- ToolExecutor 只消费已提交 proposal，拥有 tool idempotency/effect ledger。
- SessionRuntimeSupervisor 只把 calling/retry/quota/suspended/config wait 投影到统一 snapshot，不复制
  Provider retry policy。

### 9.2 Provider Runtime 调用合同

```ts
executeStep(
  snapshot: ProviderRequestSnapshot,
  signal: AbortSignal,
): Promise<ModelStepProposal>
```

transient error 时 Promise 不立即以 Turn failure 结束。ProviderRuntime：

1. 发布带 attemptId 的 `provider_attempt_failed`，要求 renderer 丢弃该 attempt preview；
2. 释放 concurrency lease，进入 `waiting(provider_retry)`；
3. 普通 429 尊重 Retry-After；network/5xx 使用带 jitter backoff；
4. circuit half-open 时只放一个 probe permit，成功后再公平释放 waiter，防止恢复风暴；
5. auth/config error 进入 `waiting(provider_config)`，等待 credential/config revision 变化；
6. retry 前重新验证 AbortSignal 和 turnRunId lease；旧/superseded Turn 不得复活；
7. 用同一 immutable semantic snapshot 创建新 attempt，成功后 resolve proposal。

Provider waiter 不持有 concurrency slot。Stop、dispose、handoff/supersede 必须能从 timer、
circuit queue、capacity queue 和 active stream 中统一移除。

### 9.3 主动重试上限与挂起恢复

`maxAttempts` 只限制一次 **active retry burst**，不决定 Turn/Task 已永久失败。达到上限后：

1. 停止高频 API 调用、释放 lease，并将 circuit 打开；
2. 保存 sanitized `ProviderCallCheckpoint`；
3. 普通暂时不可用进入 `waiting(provider_suspended)`；
4. 有明确配额恢复窗口的错误进入 `waiting(provider_quota)`；
5. 原 `executeStep()` 仍 pending，不生成 Assistant error message，不把 Child task 标成 failed。

Provider Runtime 不设置任务级“累计尝试 N 次后永久失败”。若某个 Work/Flow 需要最大等待时长、
deadline 或失败升级，由其调用方通过 cancellation/deadline policy 终止 Provider waiter；
不能把业务 SLA 写死进 ProviderAdapter。

挂起后的恢复条件是显式数据，而不是递归重试：

- 到达可信的 `resetAt`/`nextRetryAt`；
- 同 availability key 的 half-open probe 成功；
- credential/config revision 变化；
- 用户从首页发出显式 retry；
- Stop、handoff 或 dispose 终止 waiter。

恢复时只发放一个 half-open probe permit。成功后开启新的 retry burst，`burstAttempt` 归零，
但 `lifetimeAttempt` 和 audit 保持单调递增；失败则按 circuit policy 重新挂起，不能在
“每次重置 maxAttempts”后形成无限紧循环。

显式 retry 是 Provider Runtime control command，不是新用户消息，也不创建新 Turn：

```ts
retryProvider({
  providerId,
  availabilityKey?, // 省略时由 supervisor 选择一个最旧的可恢复 key
  expectedRevision,
  actor: "user",
})
```

它只能请求 supervisor 从该 key 的实际 waiter 中安排一个 half-open probe，不能直接逐个
retry Session，也不能绕过 circuit 的 `minProbeAt`。Provider 下有多个故障 key 时，一次
首页操作仍最多选择一个；probe 成功后 supervisor 才按公平队列恢复其余 waiter。没有 waiter
时不为“测一下”偷偷产生模型调用；需要独立连通性测试时仍走 Provider Settings 的 test
能力。旧/disabled Provider、过期 revision 或正在 probe 的 key 返回结构化
no-op/conflict。

ProviderAdapter 必须区分下面几类 429/配额错误：

| 规范化 error class | Session 投影 | 默认恢复条件 |
|---|---|---|
| `rate_limited` | `provider_retry` | Retry-After 后进入公平队列 |
| `usage_window_exhausted` | `provider_quota` | 可信 resetAt 到达 |
| `quota_exhausted` / `billing_hard_limit` | `provider_config` | quota/billing/config revision 或显式 retry |
| `network` / `server_error` burst exhausted | `provider_suspended` | circuit probe、nextRetryAt 或显式 retry |
| `auth_error` / `invalid_config` | `provider_config` | credential/config revision |

ProviderAdapter 应优先读取稳定 error code、scope、Retry-After/rate-limit-reset：

- 已知 resetAt：在该时间前不做探测，到时经 half-open 恢复；
- 未知 resetAt：`nextRetryAt` 为空，等待 config/credential revision 或显式 retry；
- “已达到 5 小时的使用上限”等本地化 message 应归为候选
  `usage_window_exhausted`，但只能作为诊断提示，不能单独推算 resetAt；若 Provider 没有给
  可信时间，则 UI 显示“恢复时间未知”，等待 revision 或显式 retry；
- 换同 account/scope 的新 credential 可保持请求语义；换 account、Provider 或 model 属于
  route change，必须进入 recovery decision 并产生一次 notice。

进程重启后，挂起 checkpoint 重新注册 timer/config/circuit waiter。若原 Turn 已被
supersede，checkpoint 只保留审计，不得恢复调用。

### 9.4 Preview 与提交边界

Renderer 以 `callId + attemptId` 接收 provisional text/reasoning。attempt failure 产生
`provider_preview_reset`；旧 attempt 的晚到 delta 被丢弃。临时 preview 不写入 Session
message、Step row 或 memory。

Provider 成功返回完整 proposal 后：

```text
proposal ready
→ atomic proposal commit / step checkpoint
→ execute tool calls from durable ledger
→ collect tool results
→ next ProviderRequestSnapshot
```

实施时必须关闭 SDK 在未完成 provider stream 内自动执行本地工具的路径。若某 Provider
只能以自动 tool execution 工作，该 adapter 标记 `effectful=true`，透明 retry fail closed，
除非它提供可验证的 response resume/idempotency contract。

### 9.5 Agent 可见性

普通 timeout/rate-limit/network/5xx retry 不进入 Agent 对话或下一次 prompt。只有以下变化
生成一次性 `ProviderRecoveryNotice`：

- provider/model route 改变；
- prompt-too-long 触发了非等价 context rewrite；
- provider-managed effectful tool 状态不确定；
- 已提交 proposal/tool ledger 与恢复 checkpoint 不一致；
- 实施无法证明重放仍是同一 semantic request。

notice 进入负责该执行的 Agent 的 workbench/system context并写审计，不伪装成用户消息，
不包含 credential、原始 header 或内部 stack。

### 9.6 Main Agent 恢复

进程存活时，ProviderRuntime 在 circuit 恢复后 resolve 原 `executeStep()`；从 Turn 视角只是
一次更长的 provider wait。用户/Cron/Work invocation 仍可按第 6 节 handoff；一旦旧
TurnRun 被 supersede，其 waiter 和 preview 必须 fenced。

若要求进程重启后恢复，最小持久 checkpoint 包含 request digest、provider/model semantic
revision、last sealed step、proposal commit state 和 attempt audit，不持久临时流式文本。
安全的未提交 attempt 可重新发起；未知 tool/effect 状态进入 `recovery_required`，不能猜测
重跑整个 Turn。

### 9.7 Subagent 恢复

每个 Subagent 使用自己的隐藏 Session、TurnRun、ProviderRequestSnapshot 和 checkpoint，
但共享同一 ProviderAvailabilitySupervisor：

- transient error 时 Child Session 为 `waiting(provider_retry/provider_quota/provider_suspended)`；
- Parent delegated task 为 `waiting_provider`，不是 failed/completed；
- blocking Parent 等待同一个 task result；background Parent 可继续其他工作；
- Provider 恢复后 Child 自动续同一 call/step，不创建新 taskId、不重新 dispatch；
- recovery notice 首先交给 Child；只有 Child 无法恢复时才向直接 Parent 发
  `recovery_required`；
- Parent Stop 取消 blocking Child；显式 background Child 仍只接受 task-level cancel；
- 嵌套 Subagent逐级恢复和升级，不把所有错误直接冒泡到 root Agent。

重启恢复必须使用 delegation 时冻结的 target Agent/config revision、provider/model、
workspace/mount、tool policy、task lineage 和 Child checkpoint，不能用 Parent 当前配置重新
拼装。安全的 `none/partial preview` 或完整 sealed checkpoint 可自动 resume；未知 tool
执行保持 interrupted/recovery_required，由 Child/Parent审计后决定。

### 9.8 Prompt-too-long 与非 Provider 错误

`prompt_too_long` 虽由 ProviderAdapter 分类，但恢复动作属于 compression coordinator。
ProviderRuntime 返回结构化 `context_recovery_required`，释放 lease；Turn 完成等价
compression 后以新 request digest 重试。工具错误、MCP/外部 API 错误和 zero-core 内部
REST/IPC error 不进入 Provider circuit。

## 10. compacting

compacting 是 Session 主状态，并暴露 phase：

```text
running
→ compacting(
    preparing
    → running(memory once || compression pass 1..N)
    → commit
  )
→ running/waiting/terminal
```

- preparing/running 阶段 cooperative cancel，可在进入 commit 前停止；
- commit 是最小不可中断临界段，Stop 只设置 `stopRequested`，commit settle 后再完成 cancellation；
- 普通 invocation 在 compacting 期间入 inbox，不在中间替换上下文；
- background task event 继续进入 Session Event Inbox；
- commit 后先处理 Stop，再处理 handoff/queue，不能用旧 Turn completion 覆盖新状态；
- 任一分支在 hard gate 下失败时可以进入 `compacting(blocked)`，等待 Provider 恢复或显式
  retry；Session Lifecycle 只拥有状态、取消、safe point 和投影，不定义 emergency
  compression；
- UI 显示 compacting、两个 branch 和 compression pass progress，不伪装成普通 streaming
  或 idle。

Memory/Compression 的 Snapshot、水位、一次 MemoryRun、多 pass CompressionPipeline、
WikiPatch/SummaryCandidate 和双数据库提交算法由
[`memory-compaction-runtime`](../memory-compaction-runtime/design.md)拥有。Session Lifecycle
不得实现第二套算法；它只提供可被该 effort 消费的 supervisor、Provider scheduler、
safe-point 和 commit 临界段合同。

## 11. 恢复与持久性

- 普通用户 inbox 不跨进程恢复。
- 已持久 WorkRun、delegated task 和其 delivery ledger 按现有/Agent Work Runtime
  可靠性契约恢复。
- restart 若发现 running task 且无 active Turn，创建 recovering → system continuation。
- event dedupe 至少覆盖持久 task 的 terminal delivery。
- 不持久化瞬时 streaming text、tool spinner 或 AbortController。
- Provider checkpoint 只持久 semantic digest、step/proposal commit cursor、sanitized error
  和 retry audit；credential 与 provisional preview 不落盘。
- delegated task 恢复使用冻结 Child execution snapshot；不能以 Parent 当前配置替换。

## 12. UI 与 API

UI 使用 snapshot revision，忽略旧 revision：

- Stop 按钮在 running/waiting/needs_input/compacting 可用；
- cancelling 有明确反馈；
- waiting 显示 waitReason；
- needs_input 显示 AskUser；
- compacting 显示 phase；
- queued 同时显示 paused 与 count；
- background task count 独立于前台状态显示。
- provider retry/quota/suspended/config wait 显示 Provider/model、burst/lifetime attempt、
  next retry/reset time 和恢复操作，但不把原始异常追加成 Assistant 消息；
- preview reset 按 callId/attemptId 原子撤销，旧 delta 不污染新 attempt。

HTTP/WS initial snapshot 和增量 event 使用同一 DTO；重连后 snapshot 是真相源，不靠客户端
重放布尔事件猜状态。

### 12.1 首页 Provider Control Center

现有 Dashboard 底部单 Provider selector 升级为全局 Provider 看板，并移动到 KPI 与
Agents/今日任务之间，使故障与恢复操作在默认窗口首屏可见：

- 每个 configured Provider 同时显示一行/卡片，按
  config_required → quota/suspended → retrying/half_open → busy → healthy → disabled 排序；
- Provider 行显示 aggregate state、in-flight/max、各类 waiter 数、受影响 Session/Task、
  sanitized last error、nextProbeAt/resetAt；
- 展开后显示 availability key/model scope 和等待队列摘要，不暴露 credential/account secret；
- usage 图和历史 metrics 保留为选中行的详情，不再承担 runtime health 真相源；
- 运行状态由 `ProviderRuntimeSnapshot` initial snapshot +
  `provider_runtime_changed(revision)` 驱动，8 秒 polling 只作断线兜底；
- `重试 Provider` 只在 snapshot 的 `manualRetry.allowed=true` 时启用；点击发送带
  expectedRevision 的 control command，并显示 queued/probing/succeeded/rejected；
- known resetAt 前按钮禁用并显示倒计时；unknown resetAt 可请求一次受 minProbeAt 约束的
  probe；config_required 主操作是“打开设置”，配置 revision 更新后再 probe；
- Provider 有多个故障 availability key 时，默认按钮只选择一个最旧 eligible key；展开后
  可明确选择 key，但一次操作仍只发一个 probe；
- collapsed Provider 行承担全局扫描；availability key、queue、usage 和完整错误进入右侧
  detail drawer，不能把所有信息永久铺进首页；
- Session/Task 详情只显示“等待 Provider”与“在首页查看”，不重复提供另一套 retry 控制。

`ProviderRuntimeControl.retry` 是用户控制命令。它在应用层校验 actor、revision 和 Provider
状态；不能借用当前只读 Platform resource 偷渡写操作，也不因首页按钮自动暴露给普通
Agent tool。Plan 00 根据合并后的 transport 映射到受保护的 HTTP/IPC command。

## 13. 与其他计划的边界

### wiki-system-redesign

当前手动硬门禁：Wiki 最终验收并合并后才能执行 Plan 00。这不是当前 Flow runtime 依赖。

### agent-work-runtime

- 本计划先稳定 TurnRun、snapshot、handoff、queue pause 和事件作用域。
- Agent Work Runtime Plan 02 把 `TurnInvocationEnvelope.context` 收紧为不可变
  `TurnInvocationContext`，并接入 durable WorkRun dispatcher。
- 两个计划不得各自保留一套 Session busy/queue 判断。

### local-backend-security-boundary

安全计划保护 HTTP/WS/IPC 边界；本计划定义其上传输的生命周期 DTO。两者无产品语义依赖，
但若并行修改 server event wiring，必须分 worktree 并在各自 Plan 00 记录合并顺序。

本 effort 的 Provider error 是模型执行面语义，不统一内部 HTTP/IPC error envelope。安全
计划继续拥有 backend connection generation、auth、secret sanitizer 和 transport
unavailable；ProviderRuntime 不得把这些实现复制成第二套 desktop backend supervisor。

## 14. 失败语义

- cancellation 不是 error；UI/metrics 分开统计。
- superseded 不是 cancellation failure。
- background task failed 是 Session task event，不自动把无关的新 Turn 标成 failed。
- compaction failure 回到可运行 snapshot，并保留原上下文；不得提交半份 cursor。
- reducer/effect 边界出现未知事件时记录并拒绝状态变更，不能猜测 active Turn。
- transient Provider error 是 wait，不是 Turn/task failed。
- provider/model/context 语义改变不能伪装成透明 retry。
- Provider proposal 未提交时不得产生本地 tool effect；若无法证明则进入 recovery_required。

## 15. 已拒绝方案

- **只给两个 queue API 加 AbortSignal**：不能解决 Stop drain、Wait、AskUser、后台事件和 UI。
- **所有旧 Turn 事件一律丢弃**：会丢掉合法的跨 Turn 后台任务结果。
- **Stop 取消所有后台任务**：违背显式后台工作的独立生命周期。
- **允许后台任务悬空且没有 Turn**：破坏 Wait/提醒语义和结果承接。
- **force-Wait 只靠 prompt**：Agent 可忽略；runtime 必须有 barrier。
- **持久化所有聊天输入**：首版收益不足，并混淆普通 inbox 与 durable WorkRun。
- **insert_now 硬抢占工具**：无法安全回滚副作用。
- **把 compacting 当 streaming 文案**：不能表达 Stop、安全提交和外部 input 行为。
- **所有 Provider error 都直接交给 Agent**：429/网络抖动污染上下文并增加无意义自检。
- **Provider 层无条件重放当前 stream**：当前 stream 可能已执行工具，存在重复副作用。
- **Provider retry 对 Session 完全不可见**：Stop、handoff、UI 和重连无法准确控制。
- **每个 Main/Subagent独立探测 Provider**：恢复时形成 thundering herd，且退避不公平。
- **达到 maxAttempts 就结束 Turn/Child task**：把短期 API 不可用误报成任务失败，且丢失
  原调用的恢复身份。
- **达到 maxAttempts 后立即重置计数继续 retry**：等价于没有上限，会形成无限紧循环。

## 16. 决策记录

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
| D11 | compacting 是 UI 可见主状态，表达并行 memory/compression branches 与 pass progress；commit 临界段不可破坏性中断。 |
| D12 | AskUser、Wait、provider/tool queue 共用 Turn cancellation tree。 |
| D13 | Provider Runtime 拥有 error normalization、backoff、circuit、attempt 和恢复公平性。 |
| D14 | Provider stream 只生成 provisional preview；成功后提交 immutable ModelStepProposal。 |
| D15 | 本地工具只消费已提交 proposal，不在未完成 Provider stream 内执行。 |
| D16 | transient Provider retry 对 Agent 对话无感，但投影为 waiting(provider_retry/quota/suspended/config)。 |
| D17 | provider/model/context 或 effect 确定性变化时向负责 Agent 注入一次 recovery notice。 |
| D18 | Main/Subagent共享 ProviderAvailabilitySupervisor；Child 独立恢复，Parent task 不误报 failed。 |
| D19 | 安全 checkpoint 可自动恢复；未知 tool/effect 状态 fail closed 为 recovery_required。 |
| D20 | maxAttempts 只结束 active retry burst；原调用进入可取消、可持久恢复的 Provider wait，任务级 deadline 由 caller policy 决定。 |
| D21 | 首页统一展示并管理 Provider Runtime；手动 retry 每次只申请一个受 revision/circuit/fairness 约束的实际 waiter probe。 |
