# Plan 03：WorkDefinition、Trigger 与持久 WorkRun

## 目标

把“什么时候执行什么工作”完全放到 Project WorkDefinition，并建立可去重、排队、重试和
重启恢复的 WorkRun。Flow 只发事件；本阶段用 dispatcher contract/fake 验证队列，不先
改 AgentLoop。

## 依赖

Acceptance 02 通过。

## 实施范围

### 1. WorkDefinition

物理位置：

```text
.zero-core/work/definitions/<work-id>/<version>.yaml
.zero-core/work/active.json
```

schema 至少包含：

- event/manual/cron trigger；
- Agent id 或明确的 vacant 状态；
- prompt、required tools；
- workspace kind：project/worktree/agent；
- `flow://current` mounts；
- composition event source selector，可把 manifest 中固定的 document inputs 作为只读
  mount，并把 child/target 文档作为独立输出；
- retry/maxAttempts；
- worktree completion policy；
- enabled。

版本不可变；更新创建新 version。WorkRun 固定 snapshot + digest，不依赖运行时重新读取
active 文件。

本阶段提供 WorkDefinition validator/repository service，但不把 definition mutation 加进
普通 Agent 的 `Work` 工具。Plan 07 由 management-only `Project.config.*` 暴露完整版本
publish/activate。

### 2. TriggerService

- 订阅标准 `flow.transitioned`；
- 可订阅标准 `flow.dependencies.changed/satisfied/regressed`；
- 可订阅标准 `flow.instance.split` / `flow.instance.merged`，并按 policy、
  source/target definition 过滤；
- 匹配 definition/transition/from/to/project/可选 input 条件；正向与反向 transition 不走
  特殊分支；
- manual fire；
- 复用或适配现有 Cron scheduler；
- 创建 WorkRun，不直接调用 Agent。

事件去重键是 `workId + workVersion + triggerEventId`。Cron 每次 fire 使用自己的稳定
trigger event id；manual 每次生成新 id。

### 3. WorkRunStore 与 durable queue

Core DB 新建独立 WorkRun 表/Repository，至少持久化：

```text
id/projectId/workId/workVersion/triggerEventId
originFlowInstanceId?/originFlowRevision?
agentId/sessionId/turnId
status/attempt
revision/priority/queueOrder
notBefore/deferReason/deferCount
workSnapshot/invocationSnapshot
createdAt/startedAt/finishedAt
resultOutcome/result/error
```

状态变更必须使用 compare-and-set，防止两个 dispatcher 同时 claim。状态至少支持：

```text
queued ↔ deferred
queued → running → succeeded/failed/cancelled
running → deferred
```

同一 Project Session 使用 FIFO + WorkDefinition priority 作为默认建议顺序，不实现运行中
硬抢占。Service contract 同时提供 list/get/defer/prioritize/switch/cancel/retry；
`switch` 在本阶段只用 fake session handoff 验证双 revision CAS，Plan 04 再接真实
SessionRuntimeSupervisor。

Agent不能直接写 succeeded/failed 或替换 snapshot。打回/废案 Flow 后，当前审核 run 可由
正常 Turn 完成路径记录 `resultOutcome: returned|abandoned`。

### 4. Dispatcher contract

定义：

```text
claim next queued run
→ build/validate invocation request
→ dispatch
→ link session/turn
→ complete/fail/retry
```

本阶段用 fake dispatcher 测状态机。真实 Agent dispatch 在 Plan 04 接入。旧
ProjectWorkRunner/HookManager 继续只服务旧系统，不能向新表双写。

进入 Flow terminal state 时，WorkRun service 以 terminal event revision 为边界：

- CAS cancel 该 FlowInstance 此前的 queued/deferred run；
- 向 running run 记录 cancellation request；
- 排除发起 terminal transition 的 currentWorkRunId；
- terminal event 随后匹配 WorkDefinition 所创建的新 run 正常保留。

### 5. 重启恢复

启动扫描：

- queued：保留；
- deferred：保留 notBefore/reason；到期后恢复 eligible，未到期不 claim；
- running 且没有活跃 turn：按 retry policy requeue 或 failed；
- terminal：不重放；
- snapshot/schema 不可解析：failed + 明确错误，不用当前 WorkDefinition 猜测。

## 测试

覆盖 transition/dependency/composition event、manual/cron、filter、
vacant/missing tools、幂等、并发 claim、FIFO、retry、cancel、restart、config
update、坏 snapshot 和 Flow/Requirement 无隐式迁移。transition trigger 必须覆盖
Discuss→Ready 后创建 Plan Work、Ready→Discuss 后创建讨论返工 Work、Plan→Build /
Build→Plan 和 Build→Verify / Verify→Build 的双向事件；每次返工创建新 WorkRun，不得
篡改或 retry 已完成 run。另覆盖 defer 到期、priority/reorder、switch 双 CAS、terminal
清理边界和 outcome 审计。

## 完成定义

[Acceptance 03](acceptance-03-work-and-workrun.md) 全部通过并生成 `result-03.md`。
