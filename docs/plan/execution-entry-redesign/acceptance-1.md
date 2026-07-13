# acceptance-1:Subagent delegate 后台化

> 对应 [./sub-1.md](./sub-1.md)。验收 checklist(每条可独立验证)。

## 功能验收

1. **Subagent delegate 立即返回 task_id**:调 `Subagent {action:'delegate', task:'...'}` → 立即返回(不等子代理跑完),返回文本含 `task_id: <id>`。
   - 验证:单测 mock delegateTaskBackground 返回固定 task_id,断言 execute 返回的 data.text 含 task_id 且 ok:true。
2. **不阻塞**:delegate 调用后 callerCtx 立即拿到结果(子代理在后台继续)。
   - 验证:单测里 delegateTaskBackground 是 stub(立即返回 id,不 await 子代理),execute 同步/微任务内返回。
3. **该 task 进 registry,可 TaskGet 取**:delegate 返回的 task_id 能被 TaskGet 查到。
   - 验证:集成测 —— delegate → TaskGet(task_id) → 拿到 task info(running/completed)。
4. **named subagent 仍工作**:delegate 带 `subagent` 参数(named role agent)→ 用目标 agent 身份后台跑。
   - 验证:单测 mock resolveAgent 返回目标身份,断言 delegateTaskBackground 收到 targetAgentId/systemPrompt/model/toolPolicy。
5. **list 不变**:`Subagent {action:'list'}` 仍返回可委派角色列表。
   - 验证:单测 list action 返回和改动前一致。
6. **configSchema 去掉 auto_background**:Subagent 工具 configSchema 不再含 auto_background / auto_background_timeout。
   - 验证:读 getToolConfigSchema(Subagent) → 无这两字段。

## 不破坏验收

7. **Orchestrate 仍 blocking**:Orchestrate task 节点仍走 delegateTask(blocking),pipeline 前一节点输出仍灌后一节点。
   - 验证:Orchestrate 现有测试(若有)仍过;或单测 delegateTask 仍 blocking 等结果。
8. **TaskStart{agent} 仍工作**:TaskStart{type:agent} 未动(sub-4 才删)。
   - 验证:TaskStart 现有测试([sub4-task-tools.test.ts](../../../tests/unit/sub4-task-tools.test.ts))仍过。

## 前端验收

9. **ToolsPage 不渲染 Subagent config**:Subagent 工具详情不显示 auto_background / auto_background_timeout。
   - 验证:configSchema 去掉后 [ToolsPage.tsx:324](../../../src/renderer/components/tools/ToolsPage.tsx#L324) 不渲染;或 e2e 截图确认。

## build

10. **typecheck 过**:`npm run build:lib`(tsc)无类型错误。
