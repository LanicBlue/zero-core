# Issue:execution-entry-redesign

- **状态**:② design(讨论细化)
- **提出**:2026-07-13
- **类型**:改进(执行/任务工具体系重构)

## 问题

执行与任务管控的工具体系分散、时态语义不统一、配置项增加认知负担:

- **执行入口碎片化**:同一件"派子代理做事"有两条路 —— Subagent delegate(blocking)与 TaskStart{type:agent}(后台);同一件"跑 shell"也有两条 —— Shell(blocking)与 TaskStart{type:shell}(后台)。blocking/后台两套时态模型并存,LLM 要判断走哪条。
- **Task 家族拆成 6 个独立工具**(TaskStart/Get/List/Kill/Finish/Resume),是 action 形态(已被 Project/Wiki/Cron/AgentRegistry 采用)的唯一例外。
- **配置项负担**:Subagent 的 auto_background/auto_background_timeout、Shell 的 timeout,把"是否后台/何时后台"的决策丢给用户配置。

目标:执行入口收敛(Subagent + Shell 各自统一承载 blocking/后台),Task 退居纯生命周期管控,统一成单一后台心智模型,固化默认行为、去掉前端配置。

## 现状 / 真相源 / 影响面

**执行入口(4 条分散路径)**:
- [src/tools/agent.ts](../../../src/tools/agent.ts) Subagent delegate —— blocking 委派(fns.delegateTask),带 auto_background safety net
- `src/tools/task-start.ts` TaskStart{agent} —— 后台委派(fns.delegateTaskBackground);TaskStart{shell} —— 后台 shell(fns.runBackground)
- [src/tools/bash.ts](../../../src/tools/bash.ts) Shell —— blocking;**sub-4 移除了 Shell 后台能力**([bash.ts:336](../../../src/tools/bash.ts#L336) 注释:`background:true` was removed),超时是 kill([bash.ts:372](../../../src/tools/bash.ts#L372))。注:[bash.ts:244](../../../src/tools/bash.ts#L244) prompt 文案"超时 auto-backgrounds"过时,与代码不符。
- [src/tools/wait.ts](../../../src/tools/wait.ts) Wait —— 等待原语(挂起 session,wake 源含"任意后台 task 完成")

**关键事实**:Subagent delegate 与 TaskStart{agent} 底层共享 delegator,且有重复代码([agent.ts:49](../../../src/tools/agent.ts#L49) 与 `task-start.ts:39` 的 `entryDisplayName` 是同函数两份)。→ 后台化是顺势而非逆势。

**Task 家族 6 工具**:注册于 [index.ts:102](../../../src/tools/index.ts#L102);3 个 meta(isReadOnly/isDestructive/isConcurrencySafe)在 runtime **零消费**(grep 确认,只 UI 标签),action 工具惯例一律 false。

**配置项**:[agent.ts:75](../../../src/tools/agent.ts#L75) auto_background/auto_background_timeout;[bash.ts:262](../../../src/tools/bash.ts#L262) timeout。delegator autoBg 逻辑见 [subagent-delegator.ts:389](../../../src/runtime/subagent-delegator.ts#L389) / [subagent-delegation.ts:86](../../../src/runtime/subagent-delegation.ts#L86)。前端 [ToolsPage.tsx:324](../../../src/renderer/components/tools/ToolsPage.tsx#L324) 按 configSchema 渲染。

**category 错位**:Cron 归 agent(实为 management CRUD)、Wait 归 runtime(实为 task 配套)。

**影响面**:Subagent / Shell / Task 三个工具的形态与默认行为、**Shell 执行模型改造**(超时转后台是新功能)、delegator autoBg 逻辑、前端 configSchema 渲染、[RENAMED_TOOLS](../../../src/core/tool-registry.ts#L83) 旧名迁移、[action-tool-schema.test.ts](../../../tests/unit/action-tool-schema.test.ts) 覆盖、`sub4-task-tools.test.ts` 测试改写、5 工具 prompt 互引术语。

## 下一步

② design 已完成方案细化(见 [./design.md](./design.md)),待进 plan。
