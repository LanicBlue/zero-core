# acceptance-3:Shell 超时转后台

> 对应 [./sub-3.md](./sub-3.md)。

## 功能验收

1. **超时不 kill,转后台**:Shell blocking 命令跑超 timeout(测试用小 timeout 如 1s + sleep 命令)→ 不报 "Command timed out",而是返回 task_id + 提示文本。
   - 验证:单测 spawn mock + 小 timeout + sleep,断言 execute 返回 task_id 且文本含 "Backgrounded"。
2. **命令不丢,继续跑**:转后台后子进程仍在运行(没被 kill)。
   - 验证:单测转后台后检查子进程仍 alive,或 task 状态为 running。
3. **输出保留**:转后台前已收集的 stdout 不丢;转后台后继续收集。
   - 验证:单测命令先输出 "part1" 再 sleep 超时 → 转后台 → task collected output 含 "part1";命令续输出 "part2" → task 最终 result 含 "part1"+"part2"。
4. **task 进 registry**:转后台的 task_id 能被 TaskGet/TaskList 查到。
   - 验证:集成测 超时转后台 → TaskGet(task_id) → 拿到 task info。
5. **agent 可 kill 该 task**:转后台后 TaskKill(task_id) → 子进程被 kill,task 终态。
   - 验证:单测 TaskKill 后子进程退出,task 状态 killed。
6. **中性提示(交 agent 决定)**:返回文本含决策提示(Task kill / Task get / finish / "you decide" 等),不预设续跑。
   - 验证:断言文本含决策提示关键词。

## 不破坏验收

7. **短命令仍 blocking 完成**:正常命令(< timeout)仍 blocking 返回 stdout + [Completed in Xs]。
   - 验证:现有 Shell blocking 测试仍过。
8. **background?:true 仍立即后台**(sub-2):不受影响。
   - 验证:sub-2 的 background 测试仍过。

## 进程清理

9. **无子进程泄漏**:转后台的 task 完成/kill 后子进程退出,不残留。
   - 验证:单测 task 完成/kill 后检查子进程 exited(不残留僵尸)。

## build

10. **typecheck 过**。
