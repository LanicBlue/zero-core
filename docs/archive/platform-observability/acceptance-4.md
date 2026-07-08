# acceptance-4:① session 观测暴露

对应 `sub-4.md`。

## 用例

1. **Platform List**:父 agent session 各一行,含 status(running/waiting/idle)+ 相对时间 + turns;文本格式。
2. **只父 session**:delegated 子 session 不在 List(它们走 TaskList)。
3. **status 正确**:runStates 有条目且 isBusy → running;waiting=true → waiting;无条目 → idle。
4. **Detail task tree**:传 sessionId → 返 getRuntimeTaskTree 输出(task/delegation 树)。
5. **Detail 最近3step**:返最近 3 step,{stepSeq, toolCalls[{name,argsBrief}], status, time};**无 tokens**。
6. **IPC sessions:parents**:返父 session List JSON(供看板)。
7. **IPC sessions:detail**:返 Detail JSON(task tree + steps)。
8. **相对时间**:"last 2s ago" / "last 1m ago" 风格。

## 验证手段

- 单测:mock runStates/agentStore,Platform sessions List 输出正确 status + 过滤父。
- 单测:Detail task tree + 最近3step(无 tokens)。
- 单测:IPC 两端返同源数据。
- typecheck 三层 + vitest(sibling cwd)。
