# Issue: session-turn-lifecycle

- **状态**：plan（用户已确认设计方向，Ready）
- **提出**：2026-07-17
- **类型**：缺陷 / 运行时生命周期（P1）
- **来源**：[`D-004`](../../arch/10-tech-debt-architect-view.md#d-004abort-没有贯穿等待队列)
- **设计**：[design.md](./design.md)

## 问题

当前 Session、Turn、等待、队列、停止和压缩没有共享一套生命周期真相源：

- `AgentService.runStates` 用 `isBusy + waiting` 驱动 UI 和输入路由；
- `SessionManager` 另有 `created/idle/queued/streaming/executing_tools/error/disposed`；
- `AgentLoop` 自己保存 busy、waiting、AbortController 和后台 TaskRegistry；
- AskUser、Wait、压缩、输入队列和后台任务各自实现挂起与恢复。

这不只是“abort 没传进两个等待队列”。它使 Stop、Wait 中的新输入、跨 Turn 后台结果、
`insert_now`、AskUser 和 compacting 无法组成一个可验证的状态机。

## 已确认的异常

1. Stop 只调用 `AgentLoop.abort()`，而 provider 并发等待、工具限流、AskUser 等路径没有统一
   cancellation scope。
2. Stop 后 `sendPrompt()` 仍会 drain 普通输入队列，可能表现为“刚停止又自动继续”。
3. Wait 时 `isBusy=false`，UI 看似空闲，但原 Turn 仍挂在工具调用中。
4. `insert_now` 只是下一个 StepStart 的软插入；若 Turn 在下一 step 前结束，消息可能滞留。
5. force-Wait 当前只提醒一次；Agent 再次尝试结束时会被允许结束，后台任务可失去前台承接。
6. 后台任务属于长期 Session，却主要挂在 Loop/Turn 周边；旧 Turn 控制事件与可跨 Turn 的任务
   事件没有显式分类。
7. AskUser 是另一种挂起中的活跃 Turn，但没有进入统一状态或取消协议。
8. 强制压缩可在 Turn finally 中继续发生，Stop 与压缩提交之间没有明确的阶段语义。

完整代码证据见 [research.md](./research.md)。

## 用户已确认的产品语义

- Stop 取消当前前台 Turn，暂停普通输入队列，不自动 drain。
- Stop 不取消显式后台任务；后台任务使用独立、任务级取消。
- 只要存在运行中或 finishing 的后台任务，Session 就不能没有承接它们的 Turn。
- Agent 有后台任务时不能自行结束 Turn，只能 Wait；忽略一次 Wait 提醒后，runtime 自动进入
  无模型消耗的 background barrier。
- Stop 后仍有后台任务时，runtime 原子创建 system continuation Turn，并进入
  `waiting(background_barrier)`。
- 用户输入、Cron、Work 可从 waiting/barrier 触发 Turn handoff；后台任务继续属于 Session。
- 后台任务完成/进度事件允许跨 Turn；旧 Turn 的控制事件不得污染新 Turn。
- `insert_now` 只在安全 step 边界软插入，不中断正在进行的 provider 或工具。
- 普通对话队列首版保持内存态；WorkRun、后台任务与跨 Turn 事件仍按各自可靠性要求持久化。
- `compacting` 是 UI 可见的一等 Session 状态。

## 影响

- 用户无法从 UI 状态准确判断 Agent 是在执行、等待问题、等待后台任务、压缩还是取消。
- Stop 不能提供“前台已经停止、队列不会自己继续”的稳定承诺。
- 后台任务晚到结果要么可能丢失，要么可能被错误地当成旧 Turn 噪音过滤。
- Agent Eval 的长期 Project Session、逐 Turn Invocation Context 和持久 WorkRun queue 会建立
  在不稳定的 Session/Turn 底座上。

## 非目标

- 不把普通聊天输入队列改成持久队列。
- 不用 Stop 隐式取消所有后台任务。
- 不增加任意时刻抢占 JavaScript/工具副作用的硬中断。
- 不在本 effort 设计 Work/Cron 的业务优先级；它只提供 invocation handoff 机制。
- 不修改 FlowDefinition、WorkDefinition 或外部 Agent/MCP 协议。
- 不兼容已经退役的 `turns` / `turn_state` 表。

## 当前实施安排

本计划会触及 Agent runtime、Session 服务、输入队列、任务注册、压缩和 UI，与正在另一
worktree 实施的 `wiki-system-redesign` 有重叠。当前人工计划是等待 Wiki 最终验收并合并，
再执行 Plan 00。

Agent Eval 的 [Plan 04](../agent-eval-harness/plan-04-invocation-context.md) 必须消费本计划稳定
下来的 TurnRun、invocation handoff 和 Session projection 契约，不能并行实现另一套生命周期。

