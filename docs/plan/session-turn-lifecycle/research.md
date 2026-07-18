# Research: session-turn-lifecycle

> 核对日期：2026-07-17。以下是计划前的源码基线，不是目标设计。

## 1. 多个状态真相源

[`agent-service.ts`](../../../src/server/agent-service.ts) 的 `runStates` 保存 `isBusy`、
`waiting`、streaming text 和 tool calls。`session_waiting` 会把 `isBusy` 设为 false，
`session_running` 再设回 true。

[`session-lifecycle.ts`](../../../src/server/session-lifecycle.ts) 与
[`session-manager.ts`](../../../src/server/session-manager.ts) 另有
`created/idle/queued/streaming/executing_tools/error/disposed` 转换，`queued` 在这里主要
表示等待 provider concurrency，而不是输入队列已有消息。

因此相同词汇没有相同含义，UI、API 和 runtime 不能从同一 snapshot 判断 Session。

## 2. Stop 的传播边界

- `AgentService.abort()` 只定位 Loop 并调用 `loop.abort()`。
- `AgentLoop.abort()` 只 abort 当前 `AbortController`。
- 模型 stream 接收 signal，但 provider concurrency acquire 调用没有贯穿 signal。
- ToolRateLimiter 和多个工具内部等待没有统一 signal。
- [`ask-user.ts`](../../../src/tools/ask-user.ts) 通过
  [`pending-responses.ts`](../../../src/runtime/pending-responses.ts) 等待用户响应，没有
  Turn cancellation contract。
- `AgentLoop.run()` 的 finally 仍可能协调强制 memory turn 与 compression。

现有 [`abort-isolation.test.ts`](../../../tests/unit/abort-isolation.test.ts) 主要证明不同 Loop
的 AbortController 隔离，不足以证明一次 Stop 能贯穿当前 Turn 的全部阻塞路径。

## 3. Stop 后队列继续

[`agent-service.ts`](../../../src/server/agent-service.ts) 的 `sendPrompt()` 在 `loop.run()`
返回后循环调用 `drainNextQueued()`，没有“用户 Stop 后暂停 queue”的显式 gate。因此 abort
只是让当前 run 返回，随后仍可能立即启动 queued turn。

## 4. 普通队列与 insert_now

[`input-queue-store.ts`](../../../src/server/input-queue-store.ts) 是进程内、按 Session 保存：

- `queued` 在 run 后作为新 Turn FIFO drain；
- `insert_now` 由 [`input-queue-hooks.ts`](../../../src/runtime/hooks/input-queue-hooks.ts) 在
  下一个 StepStart 注入，成功 StepEnd 才提交删除；
- retry 会重新注入，避免失败 step 吃掉用户消息；
- drain 只取 `queued`，不处理没有遇到下一 step 的 `insert_now`。

所以 `insert_now` 已经是软边界语义，不是 provider/tool 抢占。队列项虽可保存
`UserContent`，但未形成完整 source/invocation envelope。

## 5. Wait

[`wait.ts`](../../../src/tools/wait.ts) 依赖
[`task-registry.ts`](../../../src/runtime/task-registry.ts)：

- timeout、任务 terminal、用户输入都可唤醒；
- 用户输入先入普通队列，再调用 `interruptWaitForUserInput()`；
- 当前 Turn 在下一 step 边界结束，消息随后成为新 Turn。

代码是多个 callback 竞争同一个 resolver，文档中的“确定性优先级”没有一个集中仲裁点。
Stop 也没有被建模为独立 Wait 结束原因。

## 6. force-Wait

[`force-wait-hooks.ts`](../../../src/runtime/hooks/force-wait-hooks.ts) 在 TurnEndCheck 检查
running/finishing task：

1. 第一次尝试结束时注入 Wait 提醒并再跑一个 step；
2. 同一 Turn 已提醒后，再次尝试结束会被允许。

[`sub6-force-wait.test.ts`](../../../tests/unit/sub6-force-wait.test.ts) 固化了“一次提醒”行为。
这与“后台任务存在时 Turn 不得自行结束”的目标不变量冲突。

## 7. 后台任务所有权

TaskRegistry 绑定到 Loop，但一个 Loop 可跨多个 Turn 复用，delegated task 也有持久恢复。
这说明任务的业务生命周期天然长于单个 Turn。当前缺少两类事件的显式分界：

- 只能影响 origin Turn 的 control event；
- 必须能进入同一 Session 后续 Turn 的 task progress/terminal event。

简单使用“当前 Turn generation”过滤全部晚到事件会错误丢掉后台结果。

## 8. AskUser

AskUser 会让工具 Promise 长时间 pending。UI 能按 sessionId pull 未决问题，但请求没有统一
的 `turnRunId`、取消原因和 supersede 行为。Stop、普通新消息、Session dispose 与 timeout
可能各走不同清理路径。

## 9. compacting

强制压缩由 hook 发 signal，再由 AgentLoop 在 Turn 边界协调 memory ephemeral turn 与
`compressSession()`。它会改变后续模型上下文，但 UI 没有稳定的 compacting 状态；Stop、
外部 invocation 与后台任务事件在各压缩阶段的处理也未成契约。

## 10. Provider API 错误与当前重试边界

[`agent-utils.ts`](../../../src/runtime/agent-utils.ts) 已把错误粗分为 timeout、rate limit、
server、auth、network、prompt too long 和 unknown；[`agent-loop.ts`](../../../src/runtime/agent-loop.ts)
在每个 model step 内最多重试三次，并把最终错误发成 `TurnError`。但当前边界存在以下问题：

- retry/backoff 由 AgentLoop 自己实现，没有进入 Session snapshot，也没有与 Provider
  concurrency、全局 circuit 或 credential revision 统一；
- backoff 使用普通 timer，Session Stop、handoff 和 supersede 没有一个 Provider waiter
  identity 可集中撤销；
- stream 的临时 text/reasoning 已推送 UI，retry 没有正式的 attempt generation/reset 协议；
- 同一个 provider stream 内会收到 `tool-call`、`tool-result` 并立即持久化工具结果，失败
  attempt 可能已经越过外部副作用边界，不能由 Provider 无条件重放；
- `SessionManager.trackSessionError()` 把最终错误直接投影回 idle，重连后的 snapshot 看不到
  retry wait、blocked provider 或最后失败 Turn；
- 三次 attempt 是一次 AgentLoop 调用的终止条件，不存在“主动重试预算耗尽后进入低频、
  可取消、可跨重启恢复的 Provider wait”这一层；长时间 quota window 因而只能终止 Turn
  或由外层重新发起；
- Subagent 虽有隐藏 Session、`delegated_tasks` 和 `resumeTask(taskId)`，但在线 Provider
  错误会直接走 task failed；重启 resume 也会从父 Loop 当前配置重建部分 Child 配置，而
  不是完整 delegation snapshot；
- 每个 Main Agent/Subagent各自重试会在 Provider 恢复时形成 thundering herd。
- [`DashboardPage.tsx`](../../../src/renderer/components/dashboard/DashboardPage.tsx) 已在首页底部
  展示 Provider selector、并发、queue、usage 和 error metrics，数据来自 Platform tool 的
  providerStats/providerUsage/providerQueue；但当前只能单选查看，8 秒轮询的统计 DTO
  没有 circuit、quota、resetAt、runtime revision 或安全的 retry command，不能作为
  Provider 恢复控制面。
- 当前 BrowserWindow 默认 `1400 × 900`、最小 `900 × 600`；Icon Sidebar 为 48px，
  Dashboard 左右 padding 共 48px。现有 Provider chart 固定高 220px，responsive 主要按
  aspect ratio 切换，没有针对 900–1180px 内容宽的列裁剪规则。直接把所有 Provider card
  加到当前页尾会增加首屏丢失、水平拥挤和嵌套滚动。
- [`provider-store.ts`](../../../src/server/provider-store.ts) 当前会合并 4 个 system Provider
  （OpenAI、Anthropic、Google Gemini、Ollama），并允许用户继续增加 Provider；布局不能把
  “当前正好 4 个”写成上限。

根因不是缺少更多 `catch/retry`，而是 Provider call 同时承担“生成候选输出”和“执行本地
工具”。只要未完成的 Provider stream 能产生工具副作用，Provider 层就无法把失败 attempt
当作可安全丢弃的事务。

## 11. 计划约束

1. 不以旧类名为最终实现接口；Wiki 合并后 Plan 00 重新映射。
2. 不把当前 `isBusy=false` 解释为 Turn 已结束。
3. 不把 TaskRegistry 的内存实现误写成“所有任务必须持久化”。
4. 不为修复 Stop 扩大成任意工具的线程级强杀；副作用只能在安全边界 cooperative cancel。
5. Agent Work Runtime 的 TurnInvocationContext 是 invocation payload，不是 Session
   状态机的替代品。
6. Provider Runtime 可以拥有 error normalization、backoff、circuit 和 retry mechanism，
   但不能拥有 Session handoff、Turn fencing 或工具副作用恢复。
7. Provider stream 成功提交 `ModelStepProposal` 前不得执行本地工具；否则透明 retry
   必须 fail closed。
8. maxAttempts 只能限制一次 active retry burst；达到上限后必须停止高频请求并进入有明确
   wake condition 的挂起状态，不能自动把 Turn/Child task 判为失败。
9. 本 effort 只处理模型 Provider API 错误，不统一 zero-core 内部 REST/IPC error envelope。
