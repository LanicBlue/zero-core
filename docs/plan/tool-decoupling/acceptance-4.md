# acceptance-4:session 作用域工具批迁

对应 `sub-4.md`。

## 用例

1. **TodoWrite 经访问器**:execute 经 `callerCtx.todos` 读写本 session todos;不直接碰 loop 内部。
2. **Task 经 registry 访问器**:TaskStart/Get/Kill 等经 `callerCtx.taskRegistry`;只操作本 session(callerCtx 给的)。
3. **Wait + emit**:Wait 经 callerCtx 挂起/唤醒;emit 报状态。
4. **委派类经单例+callerCtx**:Subagent delegate 经 `getAgentService()` + `callerCtx.agentId` 解 per-agent 配置(含 getMcpTools);spawn 子 loop 不回归。
5. **UI 调 session 工具返示例**:Tool 页(dispatcher)调 TodoWrite/Task,callerCtx 无 loop 状态 → 返默认/示例值(不崩,有预览)。
6. **隔离**:工具只碰 callerCtx 给的访问器,碰不到别的 loop 的 todos/registry(安全)。
7. **旧 ctx 清理**:`ToolExecutionContext` 中被取代的服务字段删;buildTool 只认 JSON+format(无双返值);AgentLoop 只建 callerCtx。
8. **不回归**:TodoWrite/Task/Subagent 在真实 agent 运行中行为同今天。

## 验证手段

- 单测:TodoWrite/Task 经 callerCtx 访问器;Subagent 经单例+callerCtx。
- 单测:UI 调(无 loop 状态)返默认示例。
- 单测:隔离(工具碰不到别的 loop 状态)。
- grep:旧 ctx 服务字段已删;buildTool 无双返值分支。
- typecheck 三层 + vitest(主 cwd)全套。
