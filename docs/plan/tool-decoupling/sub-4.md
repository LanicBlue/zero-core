# sub-4:session 作用域工具批迁(TodoWrite / Task / Wait / 委派类)

> 决策 1(G1 per-session 访问器)+ 2/3。session 作用域工具迁新模型。依赖 sub-1/2/3。迁完删旧 ctx,过渡期结束(G3)。

## 任务

一次性迁:

1. **TodoWrite**:经 `callerCtx.todos` 访问器读写(loop 注入,数据"过 tool 一圈"回 loop)。
2. **Task 工具族**(Start/Get/List/Kill/Resume/Finish):经 `callerCtx.taskRegistry` 访问器操作本 session registry。
3. **Wait**:经 callerCtx + emit(挂起/唤醒流式)。
4. **委派类**(Subagent / Agent / Orchestrate):`getAgentService()` 单例 + `callerCtx.agentId` 解 per-agent 配置(含 getMcpTools,G4);spawn 子 loop。
5. **input-queue 相关**:经 callerCtx 访问器。

## UI 调用(G1)

- session 工具**也暴露给 UI**(dispatcher):callerCtx 无 loop 状态时 → 工具**返默认/示例值**(Tool 页测试预览)。

## 收尾(过渡期结束)

- 删旧 `ctx`(ToolExecutionContext)中已被单例/访问器取代的服务字段。
- buildTool wrapper 删"双返值支持"(只认 JSON+format)。
- AgentLoop 不再建旧 ctx,只建 callerCtx。

## 风险

- per-session 访问器接口设计(todos/registry 的读写形状)要稳。
- 委派类最复杂(spawn 子 loop + per-agent 配置),易回归。
- UI 默认/示例值要合理(让 Tool 页测试有意义)。

## 验收

见 `acceptance-4.md`。
