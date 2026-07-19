# Plan 05：Provider Retry、事务化 Step 与恢复

## 目标

把模型 Provider API error normalization、Retry-After、backoff、circuit、attempt 和恢复
公平性收归共享 Provider Runtime；把 Provider stream 改成无本地工具副作用的事务化
`ModelStepProposal`。Main Agent 与 Subagent 在同一 Session/Turn 合同下等待和恢复。

## 依赖

Acceptance 00–04 通过。Plan 00 必须已记录合并后真实 Provider SDK、step loop、tool execute、
checkpoint、Subagent persistence 和 UI preview 路径。

## 工作

### 1. Provider error contract

- 每个 ProviderAdapter 规范化 status、errorClass、retryable、Retry-After、request/response id；
- credential、header、原始响应和 stack 不进入 renderer、snapshot 或 checkpoint；
- timeout、rate-limited、usage-window-exhausted、quota-exhausted、billing-hard-limit、
  network、5xx、auth、config、prompt-too-long 使用可测试的稳定 code；
- quota error 保留 scope 与可信 resetAt；本地化 message 不作为恢复时间真相源；
- 不再以 message regex 作为唯一生产分类依据，无法识别时 fail closed。

### 2. 事务化 Model Step

- 第一次调用前冻结 immutable `ProviderRequestSnapshot`；
- Provider stream 只发布带 callId/attemptId 的 provisional text、reasoning、tool-call；
- 成功终止后生成完整 `ModelStepProposal`；
- proposal commit 后才由 ToolExecutor 执行本地工具；
- tool call/result、Step checkpoint 和 effect ledger 可在 crash 后判定；
- 删除 SDK 未完成 stream 内自动执行本地工具的生产路径。

若 adapter 使用 Provider 远端 effectful tool，必须显式标记并提供 response resume/idempotency
证据；否则该调用不允许透明 retry。

### 3. ProviderAvailabilitySupervisor

- 按 endpoint、account credential scope、model capacity 建共享 availability key；
- 429 尊重 Retry-After；network/5xx 使用 bounded exponential backoff + jitter；
- maxAttempts 只限制一次 active retry burst；耗尽后进入 provider_suspended/provider_quota，
  不结束原 Turn/Child task；
- Provider 不内置任务级累计失败上限；Work/Flow/用户 deadline 通过 cancellation contract
  结束 waiter；
- waiter 退避时释放 concurrency lease；
- half-open 只放单 probe permit，成功后按公平队列和并发限制释放 Main/Subagent；
- auth/config 等待 credential/config revision event 或显式 retry；
- quota resetAt 到达、同 key probe 成功、revision 变化或显式 retry 可唤醒挂起 waiter，
  wake condition 进入 snapshot/checkpoint；
- 未知 resetAt 不做紧循环探测；新 burst 保留单调 lifetime attempt/audit；
- 显式 retry 以 providerId/availability key/runtime revision fencing，只从实际 waiter
  安排一个受 minProbeAt 限制的 half-open probe，不新建 Turn、不绕过 circuit；
- Stop、dispose、supersede 从 stream、capacity、timer 和 circuit queue 统一移除；
- provider/model semantic route 不自动切换。

### 4. Provider Runtime control contract

- 发布带 revision 的 ProviderRuntimeSnapshot，Provider aggregate state 由 key-level state
  推导，不能反向覆盖 availability key；
- retry command 接受 providerId、可选 availability key、expected revision 和 user actor；
- 省略 key 时只选择一个最旧 eligible key，一次操作最多一个 probe；
- 无 waiter 不产生隐藏模型调用；healthy、disabled、stale、before-reset、probe-in-flight
  返回稳定 no-op/rejected code；
- probe 成功后由 supervisor 按公平队列恢复其余 waiter，UI 不逐个重试 Session；
- control command 不并入当前只读 Platform resource，也不自动暴露为普通 Agent tool。

### 5. Preview 与 Session projection

- attempt failure 发布 `provider_preview_reset`，renderer 原子撤销旧 preview；
- 旧 attempt delta 由 callId/attemptId fencing；
- snapshot 投影 calling、provider_retry、provider_quota、provider_suspended、
  provider_config、half_open；
- transient retry 不生成 Assistant error message，也不进入 Agent 普通 prompt；
- retry wait 的 metrics/audit 与 Turn failure 分开。

### 6. Main Agent 恢复

- 安全 retry resolve 原 `executeStep` promise，不创建新 Turn、不重放已封存 Step；
- 新 invocation handoff/supersede 后旧 Provider waiter 不得恢复；
- semantic route、context 或 effect 不确定时生成一次 `ProviderRecoveryNotice`；
- process restart 使用最小 checkpoint 恢复未提交 call，不保存 provisional preview/credential；
- 无法证明安全时进入 `recovery_required`，不猜测重跑。

### 7. Subagent 恢复

- Child hidden Session 使用相同 Provider Runtime 和独立 call/checkpoint；
- Parent task 为 `waiting_provider`，保持原 taskId/parentToolCallId；
- blocking/background Child 分别保持 Parent wait/continue 语义；
- 在线恢复自动续 Child call，recovery notice 优先交给 Child；
- 只有 Child 无法恢复才向直接 Parent 发 `recovery_required`；
- restart 使用冻结 delegation execution snapshot，不使用 Parent 当前配置重建；
- nested task 逐级恢复/升级，不直接广播 root Agent。

### 8. 测试

至少覆盖：

- partial text/reasoning 后 network error → reset → 同 snapshot 成功；
- tool-call proposal 未提交时 error，不执行本地工具；
- proposal commit 后 crash，ToolExecutor ledger 只执行一次；
- 429 Retry-After、5xx backoff、auth revision、half-open probe；
- active retry burst 耗尽后挂起、五小时 quota 的 known/unknown resetAt 恢复；
- stale/manual retry、known resetAt 前禁止 probe、minProbeAt 防连点、一次只放一个实际
  waiter probe；
- Stop/input/handoff 与 retry/circuit 同 tick；
- Main + 多个 Subagent 同时等待同 Provider，恢复无 thundering herd；
- Child online auto-resume、restart safe resume、unknown effect `recovery_required`；
- Provider-native effectful adapter fail closed；
- reconnect snapshot、preview generation、metrics、audit。
- ProviderRuntimeSnapshot initial/event revision 与首页 retry command response。

## 明确不做

- 不统一 zero-core 内部 REST/IPC error envelope。
- 不默认自动切换 Provider/model。
- 不让 Provider Runtime 决定 Session handoff、tool effect 或 Flow/Work retry。
- 不因 transient Provider error 把 delegated task 标成 failed。

## 完成

[Acceptance 05](acceptance-05-provider-retry-recovery.md) 通过并创建 `result-05.md`。
