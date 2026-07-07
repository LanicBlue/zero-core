# acceptance-9:Wait 边界完整性

对应 `sub-9.md`(补完 sub-5)。

## 用例

### 相对 timeout durable
1. **startedAt 持久化**:Wait 工具块(相对 timeout)持久化含 startedAt;grep/读确认。
2. **未到剩余时间重挂起**:崩溃时 Wait 用相对 timeout、还剩 N 秒 → recovery 用 `now − startedAt` 算剩余 → 重挂起到剩余(不直接判已超时)。
3. **已超时填结果**:剩余 ≤ 0 → 填 `woke: timeout`,不重挂。
4. **旧数据兼容**:无 startedAt 的旧 Wait 块 → 按"已超时"处理(不崩)。

### resumed-suspend user-input turn+1
5. **重挂起被 user-input 唤醒 → turn+1**:durable resume 重挂起后,用户输入打断 → 置 userInterruptQueued、turn break、起 turn+1(与 runtime Wait case 4 行为一致)。
6. **重挂起被 task-finish/timeout 唤醒 → 正常续**:不走 turn+1,正常 resume。
7. **不硬编码 reason**:`endWaitSuspend`(或等价)的 reason 来自 resolver,不写死 timeout。

## 验证手段

- 单测:detectAndResumePendingWait 对相对 timeout + startedAt 的剩余计算(重挂起/已超时)。
- 单测:resumed-suspend 被 interruptWaitForUserInput 唤醒 → userInterruptQueued=true、turn+1。
- 单测:旧块(无 startedAt)不崩。
- typecheck 三层 + vitest(sibling cwd)。
