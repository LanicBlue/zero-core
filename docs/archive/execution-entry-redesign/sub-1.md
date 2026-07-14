# sub-1:Subagent delegate 后台化

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:无(独立,为 sub-4 删 TaskStart{agent} 铺路)。

## 范围

把 Subagent delegate 从 blocking 委派改成**默认后台**(立即返回 task_id),去掉 blocking 模式和 auto_background 配置。

## 改动

### src/tools/agent.ts
- `delegate` action:从 `fns.delegateTask`(blocking,等结果)改成 `fns.delegateTaskBackground`(立即返回 task_id)
- 返回文本改成 TaskStart{agent} 风格:`"Background sub-agent started.\ntask_id: X\nUse TaskGet to drill in..."`(参照 [task-start.ts:187](../../../src/tools/task-start.ts#L187) 的 agent 分支返回;此时 Task 工具仍是 6 个独立工具,引用 TaskGet,sub-5 统一改)
- 去掉 blocking 等待逻辑(execute 里 `await delegateTask` 那段)
- 去掉 `configSchema` 的 auto_background / auto_background_timeout 两项([agent.ts:75](../../../src/tools/agent.ts#L75))
- 保留 `list` action 不变
- 保留 subagent 命名解析逻辑(LIVE 解 caller + 目标身份),底层从 delegateTask 换 delegateTaskBackground

### ⚠️ Orchestrate 不能断(关键决策)
- Orchestrate 的 task 节点走 `fns.delegateTask`(blocking,[orchestrate-tool.ts:262](../../../src/tools/orchestrate-tool.ts#L262)),依赖 blocking 语义(pipeline 前一节点输出灌后一节点)。
- **决策**:保持 `delegateTask` blocking 不变(Orchestrate 用),Subagent delegate **直接调 `delegateTaskBackground`**(不经 delegateTask)。Orchestrate 不受影响,Subagent 后台化。
- 即:只改 agent.ts 的 delegate 用哪个 fn,不动 delegator 的 delegateTask 本身。

### delegator autoBg 简化
- [subagent-delegator.ts:389](../../../src/runtime/subagent-delegator.ts#L389) 和 [subagent-delegation.ts:86](../../../src/runtime/subagent-delegation.ts#L86) 的 autoBg 逻辑(auto_background config 判断 + 超时转后台):Subagent delegate 不再经此路径(直接 delegateTaskBackground),autoBg 对 Subagent 失效。
- **先确认两个 delegator 文件的关系**(哪个在用 / 都活 / 一个废弃),再决定:删 autoBg 逻辑,还是保留(delegateTask 还在被 Orchestrate 用,但 Orchestrate 不传 auto_background config → autoBg 永不触发 → 可安全删)。
- 倾向:删 Subagent 相关 autoBg(config 读取 + 判断),delegateTask 保持纯 blocking。

## 不做(scope 边界)

- 不删 TaskStart{agent}(sub-4;这里 Subagent 接管但 TaskStart 暂留作冗余)
- 不改 Task 工具(sub-4)
- 不改 Orchestrate(保持 blocking)
- 不改前端代码(configSchema 去掉后 ToolsPage 自动不渲染)
- 不改 prompt 互引(sub-5)

## 验证

见 [./acceptance-1.md](./acceptance-1.md)。
