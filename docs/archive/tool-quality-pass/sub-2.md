# sub-2 Wait:#7 until optional + #8 finishedTaskIds

> 对应 design:[`../design.md`](../design.md) #7 #8。范围:`src/tools/wait.ts`、`src/runtime/task-registry.ts`、`src/runtime/types.ts`(WaitWakeResult)。

## #7 until 必填(一行 schema bug)

**现状**:[wait.ts:68](../../../src/tools/wait.ts#L68) `until: z.string()` 无 `.optional()`,与 prompt "Parameters (provide one): until or timeout" 矛盾。`{timeout:30}` 缺 until 被 zod 拒。execute 逻辑([L77-86](../../../src/tools/wait.ts#L77))本就支持 timeout-only。

**做法**:`until: z.string().optional()`。execute 无需改(已支持)。一行。

## #8 wake 带 finishedTaskIds

**现状**:[tryWake()](../../../src/runtime/task-registry.ts#L300) 触发 `waitResolver("task finished")` 不带 id;[wait.ts:127](../../../src/tools/wait.ts#L127) 只返 `woke: ${reason} elapsed Ns`。

**做法**:
- `TaskRegistry` 加 `private finishedDuringWait: string[] = []`。
- `complete/fail/kill/acknowledge` 四处:在现有 `tryWake()` **之前**,若 `this.waitResolver` 活跃(non-null),把当前 taskId push 进 `finishedDuringWait`。
- `suspendUntilWake` 返回时:若 `reason === "task finished"`,把 `finishedDuringWait` 快照放进结果并**清空**数组;`WaitWakeResult` 加 `finishedTaskIds?: string[]`。
- [wait.ts](../../../src/tools/wait.ts#L124-L131) execute:reason="task finished" 且 `finishedTaskIds?.length` → text = `woke: task finished elapsed Ns finishedTaskIds: [id1, id2]`;否则原样 `woke: <reason> elapsed Ns`。结构化 data 也带 `finishedTaskIds`。

## 注意

- push 必须在 `tryWake()` 之前(否则 resolver 已 resolve,但 id 还没记)——顺序见四处现有代码(都先 update 状态再 tryWake,在 tryWake 前 push)。
- finishedDuringWait 在 wake 返回时清空,保证下次 Wait 从空开始。
- 只有 waitResolver 活跃时才记(没人在 Wait,push 无意义)。

## 不在范围

- 不改 wake 优先级(user input > task > timeout)。
- 不改 timeout/until 的 durable 语义。

## 验收见 [`./acceptance-2.md`](./acceptance-2.md)
