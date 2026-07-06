# acceptance-4:Task 工具族 + blocking-only

对应 `sub-4.md`。

## 用例

1. **TaskStart 显式后台**:`TaskStart {type:"agent", task}` / `{type:"shell", command}` → 返 task_id,task 进 registry,父 workbench 显 running。
2. **Subagent/Shell 只 blocking**:`Subagent delegate` / `Shell` 默认 blocking,返 result;无 `non_blocking` / `background:true` 参数。
3. **超时自动后台保留**:blocking 调用超时 → 自动转后台 task(父得 task_id,不卡死)。
4. **TaskGet(running)**:返近 N=3 条工具调用记录(name+args),不返输出。
5. **TaskGet(completed)**:返完整 result + acknowledge → task 出 registry/workbench。
6. **TaskGet(interrupted)**:返 registry 信息 + waited + "[interrupted by restart]";近期调用记录空(子冻结)。
7. **TaskKill**:running→kill(进程停);interrupted→abandon(turn_state 标终态,workbench 移除)。
8. **TaskFinish / TaskResume 仅 agent**:对 bash task 报错/拒绝。
9. **⚠️ TaskResume 不 turn+1**:TaskResume 调 resume 前预填 turn_seq → 续原 turn,turn_seq 不变(关键回归测)。
10. **notification hook 删除**:完成 task 仍可见(收件箱),无 addMessage 持久通知;`notified` 标志移除。
11. **改名生效**:`TaskGet`/`TaskKill` 可用;旧 `TaskStatus`/`TaskStop` 名移除。

## 验证手段

- 单测:TaskStart 两种 type;TaskGet 三状态分支;TaskKill running/interrupted。
- 单测(关键):TaskResume 后 turn_seq == 原 interrupted turn 的 seq(不 +1),TurnStart 被守卫跳过。
- 集成测:notification hook 删除后,完成 task 经 workbench 可见、TaskGet 消费后消失。
- 手测:跑 delegate(blocking)+ TaskStart(后台),确认行为。
