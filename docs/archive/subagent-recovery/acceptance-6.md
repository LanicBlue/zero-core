# acceptance-6:force-Wait hook

对应 `sub-6.md`。

## 用例

1. **有后台 task 不结束**:turn 即将结束、有 running 后台 task → 注入 "请 Wait" nudge + 跑一步,turn 不结束。
2. **无后台 task 正常结束**:无 running task → 正常结束 turn,无 nudge。
3. **nudge 不死循环**:nudge 一次后设标记,同 turn-end 不重复 nudge(即便 agent 没立刻 Wait)。
4. **子跑完可结束**:后台 task 完成后 → workbench 更新 → 父 TaskGet 消费 → 再无 running task → turn 可正常结束。
5. **不干扰 Wait 中 turn**:Wait 挂起期间(turn 已非 running)不触发 turn-end nudge。
6. **走 hook**:实现是 hook(注册在 src/runtime/hooks/),无 AgentLoop 内联功能代码。

## 验证手段

- 单测:mock TaskRegistry 有 running task,触发 turn-end hook → 断言注入 nudge + 跑一步。
- 单测:无 running task → 不注入。
- 单测:nudge 标记 —— 连续两次 turn-end 只 nudge 一次。
- 集成测:跑一个 delegate(TaskStart)+ agent 想结束 → 触发 nudge → agent Wait → task 完成 → TaskGet → 结束。
