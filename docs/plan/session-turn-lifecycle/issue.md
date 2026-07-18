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
9. Provider API retry 只存在于 AgentLoop step 内；Session/UI 不知道 retry wait，
   Stop/handoff 也没有 Provider waiter fencing。
10. Provider stream 尚未完成时本地 tool call/result 已可能发生；透明重试可能重复工具
    副作用，而简单把错误交给 Agent 又会让所有 429/网络抖动污染上下文。
11. Main Agent 与所有 Subagent分别退避和探测同一 Provider，恢复时可能形成并发风暴；
    Subagent 的 transient Provider error 还可能被误报成 delegated task failed。
12. 当前三次重试耗尽后直接形成 TurnError；“已达到 5 小时的使用上限”等长窗口 quota
    没有 suspended waiter、resetAt 或外部恢复事件，只能失败或由上层反复重跑。
13. 首页已有 Provider 统计/队列/用量，但必须单选且只有观测数据；用户不能同时看到每个
    Provider 的 circuit/quota/config 状态，也没有受 supervisor 约束的手动恢复入口。

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
- Provider API recoverable error 默认对 Agent 对话无感；Session snapshot 按短重试、窗口
  quota、burst exhausted 或配置问题显示 provider_retry/provider_quota/
  provider_suspended/provider_config，Stop/handoff 仍可准确控制。
- Provider 只生成可提交的 `ModelStepProposal`；本地 tool call 在 proposal 成功后由
  ToolExecutor 执行，未提交 stream 可以按 attempt 整体丢弃。
- Retry-After、backoff、circuit、half-open 和恢复公平性由共享 Provider Runtime 管理；
  Session 只投影状态并提供 cancellation/fencing。
- Provider/model、上下文或不确定副作用发生语义变化时，向负责该执行的 Agent 注入一次
  结构化 recovery notice；普通 transient retry 不进入对话。
- Subagent 使用自己的隐藏 Session/TurnRun 自动等待和恢复；Parent task 显示
  `waiting_provider`，不重新 dispatch，也不把 transient error 标成 failed。
- maxAttempts 只结束一次主动 retry burst；原 Provider call 转为
  `waiting(provider_suspended/provider_quota)`，等待 resetAt、circuit probe、
  credential/config revision 或显式 retry。
- 首页看板是全局 Provider 状态与手动重试入口；Session 页面只显示本 Session 的等待原因
  和跳转，不复制 Provider 控制逻辑。

## 影响

- 用户无法从 UI 状态准确判断 Agent 是在执行、等待问题、等待后台任务、压缩还是取消。
- Stop 不能提供“前台已经停止、队列不会自己继续”的稳定承诺。
- 后台任务晚到结果要么可能丢失，要么可能被错误地当成旧 Turn 噪音过滤。
- Provider 抖动可能重复工具副作用、错误结束 Main/Subagent task，或让 UI 在实际 retry
  时显示 idle。
- Agent Work Runtime 的长期 Project Session、逐 Turn Invocation Context 和持久 WorkRun
  queue 会建立
  在不稳定的 Session/Turn 底座上。

## 非目标

- 不把普通聊天输入队列改成持久队列。
- 不用 Stop 隐式取消所有后台任务。
- 不增加任意时刻抢占 JavaScript/工具副作用的硬中断。
- 不在本 effort 设计 Work/Cron 的业务优先级；它只提供 invocation handoff 机制。
- 不修改 FlowDefinition、WorkDefinition 或外部 Agent/MCP 协议。
- 不兼容已经退役的 `turns` / `turn_state` 表。
- 不统一 zero-core 内部 HTTP/IPC/renderer 的通用 API error contract。
- 不默认切换 Provider/model；任何语义 route 变化都必须显式配置并进入 recovery notice。
- 不宣称 Provider 自带的远端 effectful tool 可以像纯模型生成一样透明重试。

## 当前实施安排

本计划会触及 Agent runtime、Session 服务、输入队列、任务注册、压缩和 UI，与正在另一
worktree 实施的 `wiki-system-redesign` 有重叠。当前人工计划是等待 Wiki 最终验收并合并，
再执行 Plan 00。

Agent Work Runtime 的
[Plan 02](../agent-work-runtime/plan-02-invocation-context.md) 必须消费本计划稳定
下来的 TurnRun、invocation handoff 和 Session projection 契约，不能并行实现另一套生命周期。
