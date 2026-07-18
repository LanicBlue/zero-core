# sub-3:Shell 超时转后台(进程移交)

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:sub-2(Shell background 基础)。
> **技术风险最高处** —— plan 重点设计。

## 范围

Shell blocking 命令超时(默认 300s)时,**不 kill,改成转后台 task**(保留命令 + 已收集输出),返回 task_id + 中性提示,杀不杀交 agent 决定。

## 现状(为什么是"新功能")

[bash.ts:336-374](../../../src/tools/bash.ts#L336):`execFileAsync` + timeout,超时 `err.killed` → 返回 "Command timed out after Xs",命令被 kill、丢失。sub-4 注释明确 "Shell 超时 throws,auto-background 是 Subagent concern"。

## 改动方向

### 执行模型改造
- 从 `execFileAsync`(一次性收集 + 超时 kill)改成 `spawn` + 手动超时检测 + 输出增量收集
- 5min 到:**不 kill 子进程**,把"子进程 + 已收集 stdout/stderr"移交进 task registry → 返回 task_id

### 进程移交机制(关键设计)
- **现状 runBackground**(TaskStart{shell} / sub-2 background 用的)是"新启动一条后台命令"(`task-start.ts:98`)。它不能直接接管已 spawn 的进程。
- **方案 A(推荐)**:扩 task registry 支持"接管现有 spawn 子进程"—— 新增 API(如 `adoptBackgroundTask(childProcess, command, collectedOutput)`)注册一个已存在的进程为 task,后续输出持续收集进 task result。
- 方案 B:超时后用 runBackground **重启**命令 —— 简单但命令从头跑(前 5min 输出丢 + 副作用风险,如 download 重下)。**否决**(违背"保留命令 + 输出")。
- 实施时先读 runBackground / task registry 实现([subagent-delegator.ts](../../../src/runtime/subagent-delegator.ts) 的 runBackground + task 状态机),扩 adopt 能力。

### 返回文本
- 超时转后台后:`"Command ran ${timeout}s without finishing. Backgrounded as task_id: ${id}. You decide: Task kill to stop / Task get to watch / let it finish."`
- task 的 result 字段持续收集子进程后续输出(直到完成),TaskGet 能看到。

### 前端/UI
- 转后台的 task 和其他后台 task 一样在 workbench / Task list 显示。

## 不做(scope 边界)

- background?:true(sub-2)
- 删 TaskStart(sub-4)
- 改 Task 工具(sub-4)

## 风险与止损

- spawn + 移交的执行模型改造较大,要保证:
  - 输出不丢(增量收集 + 移交后继续收集)
  - task lifecycle 正确(完成/失败/killed 状态转移)
  - 不泄漏子进程(主进程退出时清理)
- **如果实施发现"接管现有进程"机制太复杂**(要大改 registry / task 状态机),**STOP 报告**,问用户是否退回方案 B(重启,接受输出丢)或调整 scope。

## 验证

见 [./acceptance-3.md](./acceptance-3.md)。
