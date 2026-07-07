# sub-5:Wait 重构(通用 session 挂起)

> 依赖:**sub-3**(recovery)、**sub-4**(TaskGet/收件箱)。对应 design §3.2、§3.3。

## 目标

`Wait` 改成通用 session 挂起(不绑 task),三 wake 源(到点 / any-task-finish / user-input=turn+1);Wait 期间 session ≠ running;崩溃后 durable wait-resume。

## 范围 / 改动

- **`Wait` 输入**([tools/wait.ts](../../../src/runtime/tools/wait.ts)):去 `task_id`;保留 `timeout`(相对)+ 加 `until`(绝对时间点)。return 仅 wake 原因 + elapsed。
- **三 wake 源**(改 `suspendUntilWake` [task-registry.ts:216](../../../src/runtime/task-registry.ts#L216)):
  - 到点(`until`/`timeout`)。
  - any-task-finish(任一后台 task 完成,全局事件)。
  - user-input 打断 → **起 turn+1**(新 turn,user 消息进对话)。
- **busy 释放**:Wait 挂起期间 `busy` 释放(或引入 `waiting` 态),session 不算 running(UI 不显示 busy);wake 时重获。
- **user-input 不走 input-queue**:取消"StepStart 注入"说法;user-input-turn+1 是独立路径。
- **durable wait-resume**:
  - wait 状态 = 持久化 step 里 pending Wait 工具调用的 args(`until`/`timeout`),无独立 carrier。
  - `resume()` 检测 pending Wait 工具调用 → 读 args → 判 `until` 是否到点 → 重挂起 or 填结果。
  - **不走** `synthesizeDanglingToolResultsInPlace`([session.ts:334](../../../src/runtime/session.ts#L334))的 `[interrupted]`,走专门 wait-resume 分支。
  - 停机期间任意 task 终态 → 重挂起后 any-finish 检查自然触发。
  - 约束:相对 `timeout` 需 step 工具块存 `startedAt`;优先 `until`。

## 不在本 sub

- force-Wait hook(sub-6)。
- workbench 通道本身(sub-1)。

## 风险

- busy 释放 + user-input-turn+1 的并发:用户在 Wait 中输入,要干净地结束当前 turn、起新 turn,Wait 工具调用需合成 interrupted result(否则消息序列断裂)。
- durable wait-resume 的判定(到点/重挂起)边界:系统时钟跳变(如休眠唤醒)可能误判 until。
- 三 wake 源的优先级/竞态(同时发生时取哪个 wake 原因)。

## 验收

见 `acceptance-5.md`。
