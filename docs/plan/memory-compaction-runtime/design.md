# Design: memory-compaction-runtime

> 状态：**Ready**。设计已于 2026-07-18 经用户确认，可按本目录 README 和分阶段 plan
> 实施；外部前置仍必须满足。
>
> 对应问题：[issue.md](./issue.md)。

## 0. 当前结论

压缩不再由 Agent 自判，也不再用同一个 `AgentLoop` 串行重入 memory turn。runtime 在
preferred/hard 条件下固定一个不可变 `CompactionSnapshot`，并行运行：

```text
CompactionRun(snapshot, boundary B)
├── MemoryRun（foreground 原模型，一个逻辑 call）→ 仅内存 WikiPatch
└── CompressionPipeline（专用模型）
    ├── pass 1
    ├── pass 2
    └── pass N                         → 仅内存 SummaryCandidate

两者都成功
└── safe point + generation/CAS
    └── durable commit

任一失败 / 取消 / 软件关闭
└── 丢弃两个内存结果；不恢复旧 run，等待下次触发
```

MemoryRun 与 CompressionPipeline 是一个 `CompactionRun` 的两个并行分支，不是两个可以
各自推进持久化 cursor 的后台任务。MemoryRun 对整个 Snapshot 只创建一个原模型逻辑 call；
CompressionPipeline 可按专用模型窗口顺序调用多次。它们共享一个 `maintenanceCursor` 和
同一最终覆盖范围。

## 1. 三种信息的边界

### 1.1 原始 Steps

- 原始 Steps 是不可变、无损的事实来源。
- 压缩不删除或改写原始 Steps；archive/eval 仍可读取完整历史。
- 运行时组装上下文不等于重新读取全部历史。

### 1.2 Context Summary

- Summary 是当前 Session 连续性的有损投影。
- 它只替换已确认覆盖的前缀，不包含启动后继续增长的 fresh tail。
- Summary 必须带 coverage range、source digest、prompt/model/policy version 和 generation。

### 1.3 Wiki Memory

- Memory 是跨 Session 的长期事实、经验、偏好和稳定决策。
- MemoryRun 只得到预编译的当前 Agent `memory://` bounded snapshot，不得到 live Wiki tool 或
  管理面权限。
- Memory 写入不证明信息永远正确；后续治理仍属于 memory-maintenance。

## 2. 不变量

| ID | 不变量 |
|---|---|
| M1 | Snapshot 边界固定后，`seq <= B` 的输入不再变化；新 Step 只进入 fresh tail。 |
| M2 | MemoryRun 和 CompressionPipeline 读取同一个 Snapshot，使用同一个 `maintenanceCursor`。 |
| M3 | 两个分支运行期间没有可见的 Wiki、summary 或 cursor 持久化副作用。 |
| M4 | 任一分支失败、取消或进程关闭，另一分支即使已经完成也不能单独影响上下文。 |
| M5 | 只有两个分支都成功并通过 safe-point CAS，才能进入 durable commit。 |
| M6 | cursor 不能越过任何未实际提供给模型的 Step；tool call/result 原子组不能被切开。 |
| M7 | 运行中 foreground LLM、工具和 UI 不因 preferred compaction 阻塞。 |
| M8 | 到达 hard 后，只允许在下一次 LLM call 之前等待；已经运行的工具不被截断。 |
| M9 | Agent 不通过自然语言 ack、隐藏标记或普通工具决定 compression 时机。 |
| M10 | bypass runner 不并发重入 foreground AgentLoop，也不共享其 mutable abort/recorder/messages。 |
| M11 | 自动语义召回不是首版提交条件；显式 `memory://` read/search 保持可用。 |
| M12 | 旧 `running` bypass work 不在重启后恢复。 |
| M13 | 每个 CompactionRun 的 MemoryRun 恰好创建一个原工作模型逻辑 call；CompressionPipeline 可以有多个顺序 pass。 |
| M14 | Turn 不是压缩原子或保留单位；一个超长 Turn 可以在完整 Step 边界触发多个 CompactionRun。 |

## 3. CompactionSnapshot

Snapshot 至少包含：

```ts
interface CompactionSnapshot {
  sessionId: string;
  agentId: string;
  generation: number;
  boundarySeq: number;       // B
  maintenanceCursor: number;
  historyDigest: string;     // cursor+1..B 的稳定摘要
  contextTokens: number;
  contextWindow: number;
  foregroundProvider: string;
  foregroundModel: string;
  compressionProvider: string;
  compressionModel: string;
  policyVersion: string;
  promptVersion: string;
  wikiBaseRevision: string;
  createdAt: string;
}
```

Snapshot 的输入范围是：

```text
[existing summary continuity]
+ [raw Steps: maintenanceCursor + 1 .. B]
+ [bounded continuity reference]
```

continuity reference 只帮助摘要与仍在运行的任务衔接，不属于本 candidate 的覆盖范围：

- Turn 内触发时可带 bounded fresh-tail snapshot；
- 新 Turn 触发时可带新 user message；
- 新 user message 和 `seq > B` 的 Step 永不写入当前 candidate coverage。

`historyDigest` 只验证 Session 历史和当前 summary，不应因 MemoryRun 自己准备的 WikiPatch
变化而失效。

### 3.1 CompactionAtom 与 Turn

Turn 不属于压缩边界。Snapshot 只按已完成的 `CompactionAtom` 切分：

- 已 seal 的 Step 可以成为 atom；
- tool call/result、AskUser/answer 和其他需要配对的语义块必须位于同一 atom；
- 在途 Step、尚未处理的 user message 和未闭合语义组永远位于 fresh tail；
- 不保证保留最后一个完整 Turn，也不因“本 Turn 已压缩”阻止后续压缩。

一个超长 Turn 可以这样运行：

```text
StepEnd → CompactionRun 1 → commit
继续产生 Steps
StepEnd → CompactionRun 2 → commit
……
```

当前实现的 `compressedThisTurn` 一类单 Turn guard 与该语义冲突，切换时必须删除。

## 4. 水位

`W` 表示模型上下文窗口；实际调用仍必须扣除最大输出、system/tool 注入和协议安全余量。

```text
preferred(W) = min(50% × W, 100K)
hard(W)      = min(75% × W, 400K)
```

示例：

| W | preferred | hard |
|---:|---:|---:|
| 32K | 16K | 24K |
| 64K | 32K | 48K |
| 128K | 64K | 96K |
| 200K | 100K | 150K |
| 256K | 100K | 192K |
| 1M | 100K | 400K |

`hard` 还必须满足 runtime 的安全输入上限：

```text
effectiveHard = min(hard(W), W - outputReserve - protocolReserve)
```

水位使用实际组装后的 token estimate，不使用字符数替代。压缩完成后的目标体积、保留多少
fresh tail 和 summary token cap 固定为：

```text
target(W)     = min(30% × W, 60K)
summaryCap(W) = min(10% × W, 12K)
tailBudget    = max(0, target(W) - estimatedSummaryTokens)
```

不以完整 Turn 作为 tail floor。boundary 选择最近的合法 CompactionAtom 边界，使提交后的
估算上下文尽量落到 target；preferred candidate 至少减少压缩前上下文的 `20%`，否则丢弃并记录
`insufficient_reduction`。hard candidate 不能用低 reduction 静默放行下一次超限请求。

## 5. preferred 触发与 Provider cache TTL

不新增固定的 `quietPeriod` 字段，直接复用现有 per-provider `cacheTtlMs`。

### 5.1 计时来源

- 使用 foreground 工作模型所属 Provider 的 TTL，不使用 compression provider 的 TTL。
- `lastForegroundLLMCallAt` 只记录前台调用；MemoryRun/CompressionPipeline pass 不能刷新它。
- 当前配置为空时保留源码实际 fallback 60 分钟；旧注释中的“6 分钟”必须清理，UI、类型
  注释和 runtime 常量统一成同一事实。

### 5.2 eligible 条件

```text
Session 到达 TurnEnd 或进入 Wait
AND assembled context >= preferred(W)
AND 从该 quiescent boundary 起没有新 semantic Step
AND now >= lastForegroundLLMCallAt + provider.cacheTtlMs
→ 启动 CompactionRun
```

如果进入 TurnEnd/Wait 时 cache 已冷，可以立即启动；否则等待剩余 TTL。这样 preferred
maintenance 不主动破坏仍可能有价值的 foreground prefix cache。

### 5.3 semantic Step

会取消等待并在下一次 TurnEnd/Wait 重新判断的事件：

- 用户消息、Agent 完整输出；
- tool call/result；
- Work、Cron、外部 invocation；
- 会进入 Session 历史的后台任务完成/通知。

不会重置计时器的事件：

- stream delta；
- UI heartbeat/status poll；
- token/usage 刷新；
- Provider 内部 retry/probe；
- 不进入 Session 历史的 progress telemetry。

新 semantic Step 只取消尚未启动的 TTL 等待。CompactionRun 一旦取得 Snapshot，后续 Step
进入 fresh tail，不取消已经运行的两个分支。

## 6. hard 触发

任意完整 `StepEnd`：

```text
assembled context >= effectiveHard
AND 当前没有 CompactionRun
→ 立即固定 Snapshot 并启动两个分支，不等待 TurnEnd/Wait 或 cache TTL
```

如果 candidate 尚未完成：

- 当前 tool、后台任务和 UI 继续运行；
- 在下一次 `PreLLMCall` 前建立 hard gate；
- 不允许构造一个已知超过安全输入上限的 Provider request。

两个分支在 hard gate 下失败时：

- 当前 cycle 不提交，所有内存 candidate 丢弃；
- Session 进入运行时 `compaction_blocked`，下一次 LLM call 不得发送；
- Provider 恢复或用户手动 retry 后，使用最新 Snapshot 创建新 CompactionRun；
- 不提供跳过 MemoryRun、只激活 Compression 的 emergency path。

## 7. MemoryRun

### 7.1 执行模型

- 默认使用 foreground Session 的同一模型和 Agent identity。
- 每个 CompactionRun 恰好创建一个逻辑 Memory Provider call，输入覆盖
  `maintenanceCursor + 1 .. B`；不能按 Compression segment 重复调用 Memory。
- 它是独立 bypass runner，不是 `AgentLoop.run()` 的嵌套调用。
- 它得到 Snapshot、预编译 bounded MemoryView 和专用 prompt，不读取运行中的 mutable
  messages。
- 它不获得 live Wiki read/write/search tool，也不运行“tool result → 再次调用模型”的
  agentic loop；否则无法保证一次 API call。
- 单次调用直接返回结构化 `MemoryDecision`：

  ```text
  no_change
  OR
  patch operations[]
  ```

  host 校验 operations 后才应用到内存 overlay。
- Provider Runtime 可以用同一 `callId/requestDigest` 对 transient transport/API error 做透明
  attempt；这不创建第二次 Memory reasoning pass。burst 耗尽或语义恢复要求出现时，
  MemoryRun 失败，不能重建 prompt 再问一次。
- Provider concurrency 使用 maintenance/low-priority lane，并为 foreground 保留容量。

### 7.2 Wiki copy-on-write view

host 为 MemoryRun 编译逻辑上的 Wiki snapshot：

```text
MemoryView   = bounded paths/summaries/selected contents + base revisions
model output = structured patch proposal
host apply   = update in-memory WikiPatch only
```

不要求把完整 Wiki 复制进内存。实现可以使用：

- 稳定 base revision；
- 按需读取的节点 snapshot；
- touched node 的 base revision/content hash；
- 内存 overlay 和结构化 patch operations。

MemoryRun 不得拿到直接写真实 WikiDB 的 capability。允许结果：

```text
written | no_change | failed | cancelled
```

`no_change` 是成功结果，允许整个 CompactionRun 提交并推进 cursor。

### 7.3 可见性

成功提交后的 Memory 在下一安全 prompt refresh 可见。不得在一个已经构造或正在执行的
foreground LLM request 中热替换 system prefix；Agent 如需立即读取，可显式访问
`memory://`。

## 8. CompressionPipeline

- 使用独立配置的 compression provider/model，不提供 Agent 工具。
- 一个 pipeline 可以顺序执行一个或多个 one-shot structured generation pass。
- 每个 pass 输入：

```text
[上一个内存 rolling summary]
+ [本 pass 完整 transcript segment]
+ [bounded continuity reference]
```

- pass 1 从现有持久 summary 开始；pass N 生成最终内存 `SummaryCandidate`。
- 中间 rolling summary、pass cursor 和结果全部只在内存，不写 context table。
- pipeline 按 `CompactionAtom` 将 `maintenanceCursor + 1 .. B` 切成有序 segment；每个
  segment 必须适配 Compression 模型的 input/output reserve。
- 输入必须包含模型实际处理的完整 transcript slice；禁止 template placeholder 未替换。
- 不允许字符截断后仍推进到 segment 末尾，也不允许跨 pass 拆开语义 atom。
- 任一 pass 失败、取消或输出不满足 coverage/schema，整个 CompactionRun 失败。
- 最终 candidate 至少包含 content/sections、完整 coverage、每 pass source digest、
  model/prompt/policy version、pass count 和 token counts。

专用 Compression 模型可以小于 foreground 模型。首版不做并行 map-reduce，而以多个顺序
pass 覆盖同一个 Snapshot；只要至少一个合法 CompactionAtom 能与 capped summary 一起放进
Compression 模型窗口，pipeline 就能前进。单个 atom 本身超限时 fail closed，交给大结果
externalization/config error 处理，绝不静默截断。

MemoryRun 与整个 CompressionPipeline 并行；不是每个 Compression pass 都配一次
MemoryRun。CompressionPipeline 使用专用模型时不能假设复用 foreground prompt cache。

## 9. 运行时生命周期

```text
idle
  → waiting_cache_ttl
  → snapshotting
  → running(memory once || compression pass 1..N)
  → ready_to_commit
  → committing
  → idle
```

分支状态独立展示，但提交资格是联合的：

```text
memory      pending/running/succeeded(no_change|written)/failed/cancelled
compression pending/running(pass i/N)/succeeded/failed/cancelled
```

规则：

1. 一个分支完成不会取消、提交或持久化另一个分支。
2. 任一分支失败或取消，整个 CompactionRun 失败，所有内存 candidate 丢弃。
3. Stop、session dispose、软件关闭和进程退出不保存 Memory 结果、rolling summary、pass
   cursor 或 run checkpoint。
4. 重启不扫描/恢复旧 run；下一个 trigger 使用最新上下文重新 Snapshot。
5. 允许写普通日志、metrics 和 eval telemetry，但这些记录不能被当作 recovery state。

## 10. Safe point 与提交

两个分支都成功后：

1. 若 Session 仍 idle/Wait 且没有在途 foreground Step，可立即尝试提交；
2. 若前台已恢复，在下一次 `PreLLMCall` 前尝试；
3. 校验 generation、`historyDigest`、boundary、summary base 和 touched Wiki nodes；
4. 校验失败则丢弃两个 candidate，不能只提交其中一个；
5. commit 临界段开始后遵守 Session Lifecycle 的不可破坏提交规则。

### 10.1 双数据库约束

`wiki-system-redesign` 已决定：

- Session summary/cursor 位于 `core.db`；
- Memory Wiki 位于独立 `wiki.db`；
- 不使用 `ATTACH DATABASE`，没有跨库 SQLite transaction。

因此下面这个理想动作不能直接由单个 SQLite transaction 保证：

```text
WikiPatch + SummaryCandidate + maintenanceCursor
```

提交顺序固定为：

```text
1. 校验两个 candidate
2. 向 wiki.db 提交 WikiPatch
3. 只有 Wiki commit 成功，才向 core.db 提交 SummaryCandidate + maintenanceCursor
```

它保证不会出现“上下文已经压缩，但压缩前 Memory 从未落盘”。Wiki operations 使用由
`sessionId + maintenanceCursor + B + historyDigest + patchDigest` 派生的确定性 request id，
并在 provenance 中记录 source range/digest。软件若在步骤 2 和 3 之间关闭，允许留下
Memory 已写、cursor 未推进的安全重复；下次 MemoryRun 读取最新 Wiki snapshot，避免重新
创建相同事实。

该安全偏置已被接受。不得为了严格跨库 all-or-nothing 而推翻 Wiki 独立数据库边界、引入
`ATTACH`，或偷偷持久化可恢复 CompactionRun journal。

### 10.2 Wiki 并发冲突

- 只校验 WikiPatch touched nodes 的 base revision/content hash；
- 无关节点变化不使 candidate stale；
- 任一 touched node 在运行期间被其他 writer 修改，整轮 CompactionRun 放弃；
- 不自动 rebase、部分提交或让 CompressionCandidate 单独生效；
- hard gate 使用最新 Wiki snapshot 重跑。

## 11. Prompt cache

- `cacheTtlMs` 是 runtime 对 foreground prefix cache 冷热的估计，不等价于显式 cache
  breakpoint 或厂商账单事实。
- preferred path 等到 TTL 后再运行，目标是避免为了维护主动销毁仍热的前台 cache，而不是
  保证 MemoryRun 命中旧 cache。
- hard path 无条件优先保证 request 可构造。
- MemoryRun 即使使用同一模型，也会消耗 Provider 并发、rate limit 和 quota；必须使用低
  优先级 lane。
- Summary 激活会改变会话历史前缀；静态 system/tool prefix 是否继续命中由 Provider
  adapter 和未来 prompt-cache-control effort 决定。

## 12. Provider API 调度优先级

优先级由共享 Provider Runtime 管理，不由 AgentLoop、MemoryRun 或单个 Session 各自维护。
它只重排尚未发送的 API call；已经发送给 Provider 的调用不做强制抢占。

```text
P0  hard CompactionRun
    ├── MemoryRun
    └── CompressionPipeline pass 1..N

P1  用户交互链路
    ├── 用户消息对应的 foreground call
    └── 该用户 Invocation 关键路径上的 Subagent

P2  preferred CompactionRun
    ├── MemoryRun
    └── CompressionPipeline pass 1..N

P3  Work / Cron 链路
    └── 其 Subagent 继承 Work/Cron root priority

P4  Archive MemoryRun
```

规则：

1. 只有 hard CompactionRun 高于用户消息。此时继续构造 foreground request 已不安全，
   MemoryRun 与完整 CompressionPipeline 都是解除 hard gate 的必要条件。
2. preferred CompactionRun 低于用户消息。新用户消息可以在尚未 dispatch 的 bypass call
   前执行；Snapshot 不失效，新内容进入 fresh tail。
3. 同一个 CompactionRun 的 MemoryRun 与所有 Compression pass 使用相同 priority 和
   cycle id。两条分支即使落到同一个 Provider/availability key，也不能让一条无限饿死。
4. Subagent 不使用固定全局低优先级，而是继承 root Invocation：
   - 用户任务的 Subagent 属于 P1；
   - Work/Cron 的 Subagent 属于 P3；
   - archive maintenance 派生执行属于 P4。
5. Parent 正在等待的关键路径 Subagent 必须保留继承优先级，避免新 Work/Cron 持续插队造成
   priority inversion。
6. priority 只在同一 Provider/availability key 的 queue 内比较。不同 Provider 可以独立
   并行，不能构造虚假的跨 Provider 全局顺序。
7. Provider `maxConcurrency > 1` 时至少为 P1 foreground 保留一个可用 slot；P0 hard gate
   可以使用保留容量。`maxConcurrency = 1` 时完全按队列顺序执行。
8. preferred bypass call 已经在途时不因新消息强制取消；同一 cycle 尚未 dispatch 的调用
   仍按 P1 > P2 重新排队。
9. 同一 priority 默认按 enqueue time/FIFO；P3/P4 使用有界 aging，防止持续交互导致
   Work/Cron 或 archive maintenance 永久饥饿。Aging 不能把 P4 提升到 P0。
10. 排队项至少携带 `priorityClass`、`rootInvocationId`、`compactionCycleId?`、
    `enqueuedAt`、`provider/availabilityKey` 和 cancellation scope，便于 UI/telemetry
    解释真实等待原因。

该顺序是 API dispatch priority，不改变 Session inbox 的用户消息、Work/Cron 或 task event
handoff 语义，也不允许 Provider queue 直接结束/切换 Turn。

## 13. Memory 召回

首版保持：

- bounded `memory://` root/summary outline 注入；
- Agent 显式 Wiki search/read；
- 新 Memory 在安全 refresh 后可见。

首版不增加：

- 每 Turn 自动语义检索；
- embedding、reranker；
- 基于相似度自动注入正文；
- 访问次数/recency 衰减。

需要记录的低敏 telemetry：

- 注入 Memory snapshot/version/token count；
- 显式 memory search/read 的 path 与结果数量，不记录正文；
- MemoryRun 的 written/no_change/failed；
- compression coverage、input/output token 和 reduction；
- candidate stale、commit conflict 和 hard-gate 等待时间。

这些事件可由后续 Agent Eval Harness profile/scenario 消费，但本 effort 不修改 Eval Skill
的判断逻辑。

## 14. 手动操作

- 保留 UI/管理 API 的“Compact now”，用于诊断、测试和故障恢复。
- 普通 Agent 不获得 compression tool，不通过回复特殊字符串触发。
- 手动触发仍必须使用 Snapshot、双分支、联合成功和相同 commit barrier，不能成为绕过
  MemoryRun 的生产后门。

## 15. 与现有 effort 的边界

### wiki-system-redesign

本 effort 消费其 `memory://` capability、WikiService revision/patch、独立 `wiki.db` 和安全
prompt refresh。必须在 Wiki Final merge 后按真实 API 重做映射。

### session-turn-lifecycle

Session effort 拥有 Session/Turn supervisor、Stop、Wait、handoff、状态 projection 和 commit
临界段。本 effort 拥有 Snapshot、水位、两个 bypass 分支、WikiPatch/SummaryCandidate 和
压缩提交算法。

Session Lifecycle 的 contract 必须表达
`preparing → running(memory once || compression pass 1..N) → commit`。Session effort
不实现 Snapshot、Memory/Compression 算法或双数据库提交；本 effort 消费其稳定
supervisor、Provider scheduler 和 safe-point contract，不能建立第二套 lifecycle owner。

### backend-io-scheduling

CompactionRun 是 Session runtime work，不是 MaintenanceJob。大 Wiki patch/数据库 checkpoint
如需 worker isolation，可以消费 Backend I/O 的执行设施，但不能把 Agent bypass work 转成
可恢复的 maintenance job。

### memory-maintenance

本 effort 只在 compaction boundary 抽取新长期记忆，不负责已有 Memory 的全局去重、冲突
治理或淘汰。

### archive

Archive MemoryRun 复用同一个 MemoryRunner 和 Wiki copy-on-write overlay，但不创建
CompressionPipeline、不读取或推进 `maintenanceCursor`：

- API priority 固定为 P4；
- 每次 archive memory extraction 仍只创建一个原工作模型逻辑 call；
- 成功后只提交 WikiPatch；中断时丢弃 overlay；
- Memory 失败后继续 export，沿用 archive 的 best-effort 业务语义；
- archive lifecycle/recovery 仍由 ArchiveService 拥有，不进入 CompactionRun。

## 16. 已关闭设计项

以下事项已确认，不得在实施中静默重开：

1. 未配置 Provider 的 cache TTL fallback 保留 60 分钟，清理过时“6 分钟”注释。
2. hard 失败进入 `compaction_blocked`，没有 compression-only emergency path。
3. 双数据库接受 Wiki-first/Core-second 的安全偏置，不持久化 run/candidate。
4. touched Wiki node 冲突使整轮失败，不自动 rebase 或部分提交。
5. target/summary cap 使用第 4 节公式，不保留完整 Turn。
6. Memory 每个 CompactionRun 只有一个原工作模型逻辑 call；Compression 可顺序调用多次。
7. Session Lifecycle 拥有生命周期合同，本 effort 拥有 compaction 算法。
8. Archive MemoryRun 复用 runner/overlay，但保持独立 P4 best-effort policy。
