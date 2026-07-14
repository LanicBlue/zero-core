# Design:execution-entry-redesign

> 状态:**定稿,待进 plan**。
> 对应 issue:[`./issue.md`](./issue.md)。

## 问题回顾(详见 ./issue.md)

执行入口碎片化(Subagent/TaskStart 各承载 blocking/后台委派;Shell/TaskStart{shell} 各承载 blocking/后台 shell)+ Task 家族 6 工具拆分 + 配置项负担。目标:入口收敛 + 统一后台模型 + 固化默认。

## 关键事实(审计)

- **Subagent delegate 与 TaskStart{agent} 同源**:底层共享 delegator,`entryDisplayName` 重复两份([agent.ts:49](../../../src/tools/agent.ts#L49) / [task-start.ts:39](../../../src/tools/task-start.ts#L39))。Subagent delegate 改走 `delegateTaskBackground` 是顺势。
- **Shell 后台能力被 sub-4 移除**:[bash.ts:336-340](../../../src/tools/bash.ts#L336) 注释明确 "Shell is BLOCKING only … `background:true` was removed … a blocking call that times out throws (the auto-background safety net is a Subagent delegate concern, not a Shell one)"。超时是 kill([bash.ts:372](../../../src/tools/bash.ts#L372)),不转后台。[bash.ts:244](../../../src/tools/bash.ts#L244) 的"超时 auto-backgrounds"prompt 文案过时,与代码不符。→ **Shell 后台化(恢复 `background?` + 新实现超时转后台)是新功能,非小改**。
- **3 个 meta 在 runtime 零消费**:`isConcurrencySafe` / `isDestructive` / `isReadOnly` 只 UI 标签([ToolsPage.tsx](../../../src/renderer/components/tools/ToolsPage.tsx)),runtime 用 policy 级 `executionMode`。→ 合并/统一 meta 无运行时代价。
- **action 工具顶层 `type:object` 硬约束**([action-tool-schema.test.ts](../../../tests/unit/action-tool-schema.test.ts)):扁平 `z.object({action:z.enum([...]),...})`,非 discriminatedUnion;per-action 必填 runtime 校验。先例 [project-tool.ts:77](../../../src/tools/project-tool.ts#L77)。
- **RENAMED_TOOLS 迁移先例**:[tool-registry.ts:83](../../../src/core/tool-registry.ts#L83) 已有 task_* 旧名映射模式。

## 方案:执行入口重构

### 统一心智模型(LLM 视角)

```
派 → Subagent delegate(代理,默认后台) / Shell(命令,blocking 或 background)
等 → Wait
取 → Task get / list
控 → Task kill / finish / resume
```

统一成**单一后台模型**,去掉"blocking 直接拿结果"与"后台拿 task_id"两套时态。代价:简单委派也要 TaskGet/Wait 取结果;收益:工具数减少 + 配置固化 + 单一心智。

### 工具最终形态

**Subagent**(action: `list`, `delegate`):
- `delegate` 从 blocking(`fns.delegateTask`)→ 后台(`fns.delegateTaskBackground`),立即返回 `task_id`
- **去掉 blocking 模式**(用户:"不再阻塞")
- 去掉 `auto_background` / `auto_background_timeout` configSchema(行为固化)
- delegator autoBg 逻辑([subagent-delegator.ts:389](../../../src/runtime/subagent-delegator.ts#L389) / [subagent-delegation.ts:86](../../../src/runtime/subagent-delegation.ts#L86))简化:delegateTask 直接走 background 路径

**Shell**(`command` + `background?` + `timeout?`):
- 默认 blocking,timeout 固化默认 **300s**
- 超时**不 kill,转后台 task**(保留命令、不丢输出;新功能,改执行模型:spawn + 超时移交后台 task),返回 `task_id` + 中性提示"跑了 5min 未完,已转后台 task_id:X。**由你决定**:Task kill 终止 / Task get 看进度 / 让它跑完"—— **杀不杀交 agent 自主判断,不预设续跑**
- 加 input `background?:true` → 立即后台,返回 `task_id`(**恢复** sub-4 移除的功能,接管原 TaskStart{shell},走 runBackground)
- 去掉 timeout configSchema(固化默认)
- **实现关键(plan 阶段设计)**:"超时转后台"需把正在跑的 spawn 子进程移交进 task registry —— 复用 runBackground 的 registry,但可能要扩"接管现有进程"而非"新启动"(runBackground 现状是后者)。这是本 effort 技术风险最高的一处。

**Task**(action: `get`, `list`, `kill`, `finish`, `resume`):
- 合并原 6 工具为单 action 工具(复刻 Project 结构),**删掉 `start` action**
- start 的 type:agent 被 Subagent 接管、type:shell 被 Shell `background` 接管
- 纯生命周期管控
- meta:`isReadOnly:false / isDestructive:false / isConcurrencySafe:false`(action 惯例)
- config:原 TaskList 的 `max_completed` 挂到 Task

**前端**:去掉 Subagent/Shell 的 configSchema 项 → [ToolsPage.tsx](../../../src/renderer/components/tools/ToolsPage.tsx) 自动不渲染

**附带**:
- category 修正:Cron `agent→management`、Wait `runtime→task`(仅改 meta.category + [ToolCategory 联合类型](../../../src/core/tool-registry.ts#L29))
- 5 工具 prompt 互引术语统一为 Task action 形态(`TaskGet` → `Task action:'get'`);同步修 [bash.ts:244](../../../src/tools/bash.ts#L244) 过时文案

### 为什么 Subagent 仍独立(不并入 Task)

分工而非时态:**Subagent 是执行入口**(派子代理),**Task 是管控入口**(管派出去的所有 task,含 shell)。底层共享 delegator,但 LLM 心智上"派"和"管"是两个动作,分两个工具清晰。统一后台模型后两者职责更明确,不需合并。

## 推荐

入口收敛到 2 个语义工具(Subagent/Shell)+ Task 纯管控 + 单一后台心智 + 配置固化。真正减负。底层 Subagent/Task 后台化是顺势(共享 delegator)、3 个 meta 零消费;**唯一逆势点是 Shell 的超时转后台**(sub-4 明确移除了 Shell 后台能力,要新实现 + 改执行模型),但它是"统一后台模型"的必要组成(否则 Shell 长 command 仍是死路),值得做。

## 已决策(design gate 钉死,2026-07-13)

1. **Subagent `delegate` 默认后台**(立即返 task_id),去掉 blocking 模式,去掉 auto_background config。用户拍板。
2. **Shell**:加 `background?:true`(立即后台,恢复 sub-4 移除功能);timeout 固化默认 300s,**超时不 kill 而转后台 task**(保留命令,改执行模型 spawn+移交),返回 task_id + 提示**交 agent 决定**(Task kill 杀 / Task get 看 / 跑完);去掉 timeout config。用户拍板。
3. **删掉 Task `start` action**(agent 被 Subagent 接管、shell 被 Shell background 接管)。Task = get/list/kill/finish/resume 纯管控。用户拍板。
4. **Task 合并为单 action 工具**(复刻 Project 结构),meta false/false/false,`max_completed` config 挂 Task。
5. **前端去 config**(Subagent/Shell 的 configSchema 项)。
6. **旧名迁移**:RENAMED_TOOLS 补齐 Task 旧名(6×PascalCase + lowercase + snake_case,含 TaskStart)→ Task;Subagent 工具名不变。
7. **附带**:category 修正(Cron→management、Wait→task)+ 5 工具 prompt 互引统一 + 修 bash.ts:244 过时文案。
8. **scope = 扩展 effort + 改名**(task-tools-as-action → execution-entry-redesign)。用户拍板。

## 下一步

进 `/effort plan` 拆 sub(每个配 acceptance)。**Shell 超时转后台是技术风险最高处,plan 要重点设计"进程移交 task registry"机制**。待用户确认进 plan。
