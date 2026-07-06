# sub-4:Task 工具族 + Subagent/Shell blocking-only

> 依赖:**sub-1**(workbench 收件箱)、**sub-3**(interrupted 显示)。对应 design §4。

## 目标

后台任务全部归 **Task** 命名空间;Subagent/Shell 只 blocking(超时自动后台保留);显式后台唯一入口 `TaskStart`。task 通用操作对 subagent 和 bash 都生效。

## 范围 / 改动

### 新 Task 工具(`src/runtime/tools/`)
- **`TaskStart`**:显式后台启动(agent 或 shell),返 task_id。
- **`TaskList`**:列表 + tree(`taskIds?: string[]` 过滤,树结构文本),属性比 workbench 多。
- **`TaskGet`**:单 task 钻取,按状态分返 —— running→近期调用记录(N=3);interrupted→registry 信息+waited+"[interrupted by restart]";completed→完整 result + `acknowledge`(消费即删)。
- **`TaskKill`**:丢弃 —— running→kill,interrupted→abandon(标 turn_state 终态 + 出 registry)。
- **`TaskFinish`**:优雅收尾(advisory + turn budget),**仅 agent**。
- **`TaskResume`**:解冻冻结子(懒建 loop + resume,非阻塞),**仅 agent**。

### 新 ctx 方法
- **`ctx.getTaskRecentCalls(taskId)`**:N=3,只返工具调用记录(name+args 摘要),不返输出。
  - agent:子 loop 同进程,读近期 step tool-call 块(UI 同源)。
  - bash:status+elapsed+command(不暴露 stdout)。

### 改 / 删
- **`Subagent`**:去 `mode:non_blocking`(只 blocking);去 `stop`/`complete`/`request_finish`/`tree`(归 Task);保留 `delegate`(blocking)/ `list`(可委派角色)。
- **`Shell`**:去 `background:true`(只 blocking;超时自动后台保留 safety net)。
- **删 `notification-hooks.ts`** + `notified` 标志(workbench 收件箱取代)。
- 改名:`TaskStatus`→`TaskGet`,`TaskStop`→`TaskKill`。

### ⚠️ TaskResume turn_seq 守卫(关键)
`TaskResume` 调 `loop.resume()` **前必须预填 turn_seq**:`setSessionTurnSeq(childSessionId, turn.turnSeq)` + `setTurnSeq(childSessionId, turn.turnSeq)`(复用 `doRecoverIncompleteSessions` 模式,[agent-service.ts:1074](../../../src/server/agent-service.ts#L1074))。否则 TurnStart 会当新 turn 分配 seq → **turn+1 bug**。

## 不在本 sub

- Wait 重构(sub-5)。
- force-Wait hook(sub-6)。

## 风险

- 工具改名/删除会断现有 prompt 引用 —— 同步改工具 prompt 描述 + 任何硬编码工具名引用。
- TaskResume 漏预填 turn_seq → 续子时 turn+1(本 sub 验收强测)。
- 收件箱语义:终态留到 TaskGet 消费,确认 UI TaskTree 也遵循(不提前清)。

## 验收

见 `acceptance-4.md`。
