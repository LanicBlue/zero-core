# sub-9:补完 sub-5 —— Wait 边界完整性

> sub-5 欠交付/边界补完。依赖 sub-5(Wait 重构)。对应 design §3.2/§3.3。

## 背景

sub-5 实现者标了两处:
1. **相对 `timeout` 不 durable**:跨重启按"已超时"处理(design §3.2 说"相对 timeout 需 step 工具块存 startedAt,优先 until"—— 设计层面接受了,但未实现 startedAt)。
2. **resumed-suspend 的 user-input 不触发 turn+1**:`detectAndResumePendingWait` 重挂起后,`endWaitSuspend` 硬编码 reason="timeout",即便被 user-input 唤醒也不置 `userInterruptQueued` → turn 不 break。超 acceptance case 4 范围(runtime Wait 测了,resumed 没测),但 design §3.3 语义要求一致。

## 任务

1. **相对 timeout durable(存 startedAt)**:
   - step 工具块(Wait pending 块)持久化 `startedAt`(Wait 工具开始挂起的时间戳)。
   - durable resume 时,相对 `timeout` 用 `now − startedAt` 判剩余 → 重挂起到剩余时间(或已超时则填结果)。
   - 改动:turn-recorder / session.ts 工具块结构加 startedAt(若未有);synthesize Wait 分支 + detectAndResumePendingWait 用它。

2. **resumed-suspend user-input turn+1**:
   - 重挂起的 Wait 若被 user-input 唤醒(`interruptWaitForUserInput`),应像 runtime Wait 一样:置 `userInterruptQueued`、turn break、起 turn+1。
   - 修 `endWaitSuspend` 硬编码 reason —— 让 resumed-suspend 路径接收真实 wake reason(user-input / task-finished / timeout),user-input 时走 turn+1 路径。
   - 协调:`detectAndResumePendingWait` 重挂起用的是同一个 `suspendUntilWake`(三源已生效),唤醒后 endWaitSuspend 的 reason 要从 resolver 拿,不硬编码。

## 风险

- startedAt 持久化涉及工具块结构变更 → 兼容旧数据(无 startedAt 的旧块按原"已超时"处理)。
- resumed-suspend turn+1 与 runtime Wait turn+1 路径要对齐,避免两套逻辑漂移。
- 时钟跳变(休眠)对相对 timeout 的影响 —— 接受,标注。

## 验收

见 `acceptance-9.md`。
