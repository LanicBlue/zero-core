# acceptance-5:RENAMED_TOOLS 迁移 + schema 覆盖

> 对应 [./sub-5.md](./sub-5.md)。

## 功能验收

1. **旧 PascalCase 名映射 Task**:RENAMED_TOOLS["TaskStart"/"TaskGet"/"TaskList"/"TaskKill"/"TaskFinish"/"TaskResume"] === "Task"。
   - 验证:单测断言。
2. **lowercase / snake_case 映射**:RENAMED_TOOLS["taskstart"/"task_start"/...] === "Task"。
   - 验证:单测断言。
3. **历史名(task_status / TaskStop / task_stop)→ Task**:不再指向 TaskGet/TaskKill(sub-4 已删)。
   - 验证:单测 RENAMED_TOOLS["task_status"] === "Task","TaskStop" === "Task"。
4. **旧 config key 迁移**:policy.tools = `{task_get:{enabled:true}}` → buildToolsSet 输出 `{Task:{enabled:true}}`。
   - 验证:单测 buildToolsSet 含旧 key 的 policy,输出 Task enabled。
5. **action-tool-schema 覆盖 Task**:[action-tool-schema.test.ts](../../../tests/unit/action-tool-schema.test.ts) ACTION_SCHEMAS 含 Task,顶层 type:object / 无顶层 oneOf / action required enum 断言全过。
   - 验证:`action-tool-schema.test.ts` 跑过。

## build

6. **typecheck 过**。
