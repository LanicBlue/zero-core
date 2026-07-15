# acceptance-2 Wait(#7 + #8)

> 独立验收清单。对应 [`./sub-2.md`](./sub-2.md)。

## #7 until optional

1. **timeout-only 被接受**:`Wait { timeout: 2 }`(不传 until)不被 zod 拒,正常挂起 ~2s 后 `woke: timeout`。
2. **until-only 不回归**:`Wait { until: <ISO> }` 仍按绝对时间挂起。
3. **两者都不传**:立即 `woke: timeout ... immediate wake`(既有行为)。
4. **timeout 边界**:`timeout: 1` 接受,`timeout: 0` / `timeout: 0.5`(非整)/ `timeout: 4000`(超 3600)被 zod 拒(min/max 约束保留)。

## #8 finishedTaskIds

5. **task finished 带上 id**:Wait 挂起期间一个后台 task 完成 → wake text 含 `finishedTaskIds: [<该 task id>]`。
6. **多 task 全列**:挂起期间多个 task 完成 → finishedTaskIds 列出**全部**完成的 id(顺序不限,但数量正确)。
7. **结构化 data 也带**:`result.data.finishedTaskIds` 与 text 一致。
8. **wake 后清空**:第一次 Wait wake 后,紧接的第二次 Wait(新挂起)的 finishedTaskIds 从空开始——不复带上次的残留(用一个 task 在两次 Wait 之间完成、第二次 Wait 期间无 task 完成来验:第二次 wake 的 finishedTaskIds 为空/不含旧 id)。
9. **timeout/user-input wake 不带 task id**:timeout 醒或用户输入醒 → text 无 `finishedTaskIds` 段(或空数组)。
10. **kill/acknowledge 触发也带**:挂起期间一个 task 被 `Task kill` 或 `Task get`(acknowledge)终结 → 也计入 finishedTaskIds(四路都记)。

## 通用

11. **typecheck 绿**。
12. **既有 wait 测试不回归**:`tests/unit/sub5-wait.test.ts`、`sub9-wait-edges.test.ts` 仍绿。
