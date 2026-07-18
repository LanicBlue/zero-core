# Acceptance 05：Provider Retry、事务化 Step 与恢复

对应 [Plan 05](plan-05-provider-retry-recovery.md)。

## A. Provider ownership

- [ ] ProviderAdapter 返回稳定 code/status/retryability/Retry-After，不只解析 message。
- [ ] ProviderAvailabilitySupervisor 是 backoff/circuit/half-open/fairness 的唯一所有者。
- [ ] maxAttempts 只结束 active retry burst，不结束原 Turn、Provider call 或 Child task。
- [ ] 任务 deadline/累计失败升级来自 caller cancellation policy，不写死在 ProviderAdapter。
- [ ] Main/Subagent 共享 availability key，不各自形成恢复探测循环。
- [ ] retry wait 释放 concurrency lease，恢复遵守容量和公平顺序。
- [ ] credential、header、stack 和原始敏感响应不进入 snapshot/event/checkpoint/log。

## B. Transactional Model Step

- [ ] `ProviderRequestSnapshot` 在第一次 attempt 前冻结，retry 的 semantic digest 不变。
- [ ] 未成功 proposal 的 text/reasoning/tool-call 只属于 provisional preview。
- [ ] 本地工具不在未完成 Provider stream 内执行。
- [ ] 完整 `ModelStepProposal` 先原子提交，再进入 ToolExecutor/effect ledger。
- [ ] Provider-native effectful adapter 无 resume/idempotency 证据时禁止透明 retry。

## C. Runtime、UI 与 cancellation

- [ ] transient error 投影为 `waiting(provider_retry)`，burst exhausted 为
  `provider_suspended`，quota 为 `provider_quota`，auth/config 为 `provider_config`。
- [ ] retry 不追加 Assistant error message，也不进入 Agent 普通 prompt。
- [ ] preview reset 只撤销对应 callId/attemptId，旧 delta 不污染新 attempt。
- [ ] Stop、dispose、supersede 可撤销 active stream、capacity、timer 和 circuit waiter。
- [ ] 新 Turn 建立后旧 waiter completion 被 turnRunId fencing。

## D. Provider Runtime control

- [ ] ProviderRuntimeSnapshot 同时提供 Provider aggregate 与 availability key-level revision。
- [ ] 首页 retry command 带 providerId、可选 key、expected revision 和 user actor。
- [ ] 一次 command 最多从真实 waiter 放行一个 probe；成功后才公平恢复其余 waiter。
- [ ] 无 waiter 不产生隐藏模型调用；healthy/disabled/stale/before-reset/probing 返回稳定结果。
- [ ] control command 不并入只读 Platform resource，也不自动成为普通 Agent tool。

## E. Main Agent recovery

- [ ] none/partial preview failure 继续同一 Turn/Step，不重放整个 Turn 或 sealed Step。
- [ ] provider/model/context/effect 语义变化生成一次 sanitized `ProviderRecoveryNotice`。
- [ ] Provider route 未经显式配置不自动改变。
- [ ] restart 可从安全 checkpoint 重建，临时 preview 和 credential 不落盘。
- [ ] 未知 effect 状态进入 `recovery_required`，不猜测成功或自动重跑。

## F. Subagent recovery

- [ ] Child transient error 使 Parent task 为 `waiting_provider`，而非 failed/completed。
- [ ] 在线恢复保持原 taskId、Child Session、parentToolCallId 和 step checkpoint。
- [ ] blocking/background Parent 分别保持等待/继续语义。
- [ ] recovery notice 首先交给 Child，无法处理才逐级通知直接 Parent。
- [ ] restart 使用冻结 delegation snapshot，不使用 Parent 当前 prompt/model/workspace/tool policy。
- [ ] nested Subagent 恢复不会广播或重复唤醒整棵 task tree。

## G. Error matrix

- [ ] 429 尊重 Retry-After。
- [ ] usage-window-exhausted 与 quota/billing hard limit 分开，使用结构化 scope/resetAt；
  “已达到 5 小时的使用上限”等 message 不能单独推算 resetAt。
- [ ] known resetAt 前不探测；unknown resetAt 等待 revision 或显式 retry，不形成 busy loop。
- [ ] manual retry 带 Provider/key runtime revision，只安排受 minProbeAt 限制的实际 waiter
  probe；过期命令不创建新 Turn 或复活 superseded call。
- [ ] network/5xx bounded backoff + jitter，half-open 同时最多一个 probe permit。
- [ ] 新 retry burst 重置 burstAttempt，但 lifetimeAttempt/audit 单调递增。
- [ ] auth 等待 config/credential revision，不形成 busy loop。
- [ ] prompt-too-long 返回 context recovery request，由 compression coordinator 处理。
- [ ] Provider 恢复时多个 waiter 不形成 thundering herd。

## H. 验证

- [ ] transactional stream、proposal/tool crash、Stop/handoff race、Main/Subagent/restart 测试通过。
- [ ] UI/API/WS reconnect 使用同一 providerAttempt/ProviderRuntime revision。
- [ ] typecheck、build:lib、unit、相关 E2E 和 check:links 成功。
- [ ] `result-05.md` 包含 error matrix、并发恢复 trace、Subagent tree 和副作用证明。
