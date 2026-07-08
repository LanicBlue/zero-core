# acceptance-5:Wait 重构

对应 `sub-5.md`。

## 用例

1. **通用挂起,无 task 绑定**:`Wait` 输入只有 `until`/`timeout`,无 `task_id`。
2. **wake:到点**:`Wait until=10s后` → 到点唤醒,return `woke: timeout` + elapsed。
3. **wake:any-task-finish**:Wait 中任一后台 task 完成 → 唤醒,return `woke: task finished`。
4. **wake:user-input=turn+1**:Wait 中用户输入 → 当前 turn 结束、Wait 返 interrupted、起**新 turn**(turn_seq+1);不走 input-queue StepStart 注入。
5. **Wait ≠ running**:Wait 期间 session 不算 running(UI 不显示 busy),`busy` 释放;wake 后重获。
6. **user 可输入**:Wait 期间 UI 允许输入(不阻塞)。
7. **durable wait-resume(未到点)**:崩溃时 pending Wait 未到 `until` → recovery 检测 pending Wait 工具调用 → 读 args → 重挂起(不合成 `[interrupted]`)。
8. **durable wait-resume(已到点)**:崩溃停机期间 `until` 已过 → recovery 填结果(`woke: timeout`),不重挂起。
9. **停机期间 task 终态**:崩溃前 Wait 等 task,停机期间 task 完成 → recovery 重挂起后 any-finish 立即触发唤醒。
10. **不走 [interrupted] 合成**:pending Wait 工具调用**不**被 `synthesizeDanglingToolResultsInPlace` 填成 `[interrupted]`(走 wait-resume 分支)。

## 验证手段

- 单测:suspendUntilWake 三源(到点/any-task/user-input)各自唤醒。
- 单测:durable —— mock resume 检测 pending Wait args,断言重挂起(未到点)/填结果(已到点),且**不**经 synthesizeDanglingToolResultsInPlace。
- 集成测:Wait 中用户输入 → turn_seq+1、新 turn 含 user 消息。
- 手测:Wait 中输入消息,确认 turn+1 + UI 不阻塞。
