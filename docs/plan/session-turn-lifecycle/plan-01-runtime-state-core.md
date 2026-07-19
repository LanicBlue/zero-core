# Plan 01：统一运行时状态核心

## 目标

建立 TurnRun identity、SessionRuntimeSupervisor、统一 snapshot 和事件作用域，不先改变 Stop、
Wait、队列的完整产品行为。

## 工作

1. 定义 TurnRun、SessionRuntimeSnapshot、waitReason、providerAttempt、revision 和结构化
   terminal reason。
2. 每 Session 串行归并 command/event，副作用通过带 identity 的 completion 回流。
3. 为 turn control event 增加 turnRunId fencing。
4. 为 task event 增加 sessionId、eventId、taskId、originTurnRunId。
5. AgentService、SessionManager、Loop 暂通过单向 adapter 消费 supervisor；禁止双向同步。
6. initial API/WS snapshot 与增量事件使用同一 DTO。
7. 定义 ProviderRequestSnapshot、ProviderCallCheckpoint、ModelStepProposal 和
   callId/attemptId fencing、burst/lifetime attempt 与 suspension wake condition 类型；
   本阶段不切换生产 retry。
8. 定义全局 ProviderRuntimeSnapshot、availability key revision 和 retry control command
   DTO；本阶段不接 UI 操作。
9. 加入 reducer/state-machine table tests、旧事件/旧 revision race tests。

## 约束

- adapter 只允许旧 API 读取新 snapshot，不能让旧布尔值反向改状态。
- 不恢复 `turns`/`turn_state` 表。
- 不在本阶段接入 durable WorkRun context。

## 完成

[Acceptance 01](acceptance-01-runtime-state-core.md) 通过并创建 `result-01.md`。
