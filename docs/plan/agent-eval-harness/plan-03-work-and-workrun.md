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

### 2. TriggerService

- 订阅标准 `flow.transitioned`；
- 可订阅标准 `flow.dependencies.changed/satisfied/regressed`；
- 可订阅标准 `flow.instance.split` / `flow.instance.merged`，并按 policy、
  source/target definition 过滤；
- 匹配 definition/transition/project/可选 input 条件；
- manual fire；
- 复用或适配现有 Cron scheduler；
- 创建 WorkRun，不直接调用 Agent。

事件去重键是 `workId + workVersion + triggerEventId`。Cron 每次 fire 使用自己的稳定
trigger event id；manual 每次生成新 id。

### 3. WorkRunStore 与 durable queue

Core DB 新建独立 WorkRun 表/Repository，至少持久化：

```text
id/projectId/workId/workVersion/triggerEventId
agentId/sessionId/turnId
status/attempt
workSnapshot/invocationSnapshot
createdAt/startedAt/finishedAt
result/error
```

状态变更必须使用 compare-and-set，防止两个 dispatcher 同时 claim。同一 Project Session
默认 FIFO；允许以后增加 priority，但首版不实现抢占。

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

### 5. 重启恢复

启动扫描：

- queued：保留；
- running 且没有活跃 turn：按 retry policy requeue 或 failed；
- terminal：不重放；
- snapshot/schema 不可解析：failed + 明确错误，不用当前 WorkDefinition 猜测。

## 测试

覆盖 transition/dependency/composition event、manual/cron、filter、
vacant/missing tools、幂等、并发 claim、FIFO、retry、cancel、restart、config
update、坏 snapshot 和 Flow/Requirement 无隐式迁移。

## 完成定义

[Acceptance 03](acceptance-03-work-and-workrun.md) 全部通过并生成 `result-03.md`。
