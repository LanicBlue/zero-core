# sub-7:prompt 互引统一 + 修过时文案

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:sub-4(Task 形态确定)+ sub-1/2/3(Subagent/Shell 改完)。

## 范围

统一 Subagent/Orchestrate/Cron/Wait/Task/Shell 互相引用的 prompt 文案,指向新形态(`Task action:'get'` 等);修 [bash.ts:244](../../../src/tools/bash.ts#L244) 过时文案。**只改 prompt 文案,不改功能**。

## 改动

### prompt 互引统一(指向 Task action 形态)
- **Subagent**([agent.ts](../../../src/tools/agent.ts) prompt):delegate 现在后台 → 文案改"delegate 默认后台,立即返 task_id;结果用 `Task action:'get'`;生命周期用 `Task action:'kill'/'finish'/'resume'`"。去掉旧 "TaskGet/TaskList/TaskKill/..." 引用。
- **Task**(task-tool.ts prompt):各 action 互引用 `Task action:'...'` 形态。
- **Shell**([bash.ts](../../../src/tools/bash.ts) prompt):后台引用改"`background?:true` 立即后台;超时转后台 task;结果/控制用 `Task action`"。
- **Wait**([wait.ts](../../../src/tools/wait.ts) prompt):原"TaskStart 派后台"——start 删了,改"Subagent delegate / Shell background 派后台,Wait 等完成,`Task action:'get'` 取结果"。
- **Orchestrate**([orchestrate-tool.ts](../../../src/tools/orchestrate-tool.ts) prompt):若有 Task 引用,统一为 Task action 形态。
- **Cron**([cron-tool.ts](../../../src/tools/cron-tool.ts) prompt):若有 Task 引用,统一。

### 修 bash.ts:244 过时文案
- [bash.ts:244](../../../src/tools/bash.ts#L244) "A blocking Shell call that times out auto-backgrounds as a safety net (you get a task_id)" —— sub-3 后改反映实际行为(超时转后台 task + agent 决定杀不杀)。
- 同步 [bash.ts:267](../../../src/tools/bash.ts#L267) inputSchema timeout 描述。

## 不做(scope 边界)

- 不改功能(只改 prompt 文案)
- 不改测试逻辑(测试用 action 调用,prompt 文案不影响断言)

## 验证

见 [./acceptance-7.md](./acceptance-7.md)。
