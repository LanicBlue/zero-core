# Final Acceptance：Session / Turn Lifecycle

## 1. 状态与身份

- [ ] 一个 Session 至多一个 active TurnRun。
- [ ] UI/API/WS 使用同一带 revision 的 snapshot。
- [ ] 旧 Turn control event 无法污染新 Turn。
- [ ] 合法 task event 能跨 Turn 到达。

## 2. Stop

- [ ] provider streaming、provider queue、tool queue、Wait、AskUser 和 blocking child 各在阻塞点
  Stop 后快速 settle。
- [ ] Stop 后普通 queue 不自动继续。
- [ ] 显式 background task 不被 Stop 隐式取消。
- [ ] 已发生副作用不会被错误报告为已回滚。

## 3. Wait 与后台任务

- [ ] 后台任务存在期间没有“无 Turn 承接”窗口。
- [ ] Agent 忽略 Wait 提醒后进入不耗模型的 barrier。
- [ ] Stop 后 continuation、task terminal 后恢复、新 invocation handoff 均符合设计。
- [ ] 重复/晚到 task event 幂等，旧 foreground completion 被 fencing。

## 4. 输入与交互

- [ ] next_turn FIFO、Stop pause、next_step deferred commit/rollback 和降级均通过。
- [ ] Wait/AskUser 中用户输入、Cron、Work handoff 不丢失旧后台任务。
- [ ] 普通 queue 保持内存态；WorkRun durability 未被削弱。

## 5. Provider Retry 与恢复

- [ ] Provider stream 先形成完整 `ModelStepProposal`，未提交前不执行本地工具。
- [ ] transient Provider retry 不污染 conversation，provisional preview 可按 attempt 原子撤销。
- [ ] Stop、handoff、supersede 和新 Turn fencing 能覆盖 stream、timer、capacity 与 circuit waiter。
- [ ] 429、5xx、network、auth/config 使用共享 circuit、backoff 和公平恢复，无 thundering herd。
- [ ] maxAttempts 耗尽后进入可取消、可持久恢复的 suspended/quota wait，不终止 Turn/Child task。
- [ ] quota resetAt 已知时定时恢复；未知时等待 revision/显式 retry，不做无限紧循环。
- [ ] 首页同时显示所有 Provider runtime state，并可展开 availability key 与受影响任务。
- [ ] 首页手动 retry 每次只放一个受 revision/circuit/minProbeAt 保护的实际 waiter probe。
- [ ] Session/Task 页面没有第二套 retry 控制；Provider 配置仍由 Settings 管理。
- [ ] Main Agent 与 Subagent 保持原 Turn/Child Session/task identity 恢复。
- [ ] Provider route、context 或 effect 语义变化时，责任 Agent 收到一次 sanitized recovery notice。
- [ ] 无法证明副作用安全时进入 `recovery_required`，不猜测成功或自动重跑。

## 6. Compacting

- [ ] UI 可见 preparing/running/commit/blocked、Memory/Compression branch 和 compression pass progress。
- [ ] Stop、input、task event、Provider preview reset 与 commit 的竞争测试通过。
- [ ] 不存在半提交 cursor/context。

## 7. 质量门禁

- [ ] typecheck、build:lib、unit、build、相关 E2E、check:links 全绿。
- [ ] 无 skipped/only、timeout 掩盖或兼容双状态源。
- [ ] 所有阶段 result 与 commit 可追踪。
- [ ] 非主要实施 Agent 完成最终独立验收。
- [ ] 用户决定是否合并；未得到同意前不自动合并。
