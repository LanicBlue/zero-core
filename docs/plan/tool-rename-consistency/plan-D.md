# Plan-D:删除 CONDITIONAL_TOOLS + 启动校验

> 节点 D(架构简化,与 B 并列)。验收见 [acceptance-D.md](acceptance-D.md)。设计依据见 [`../../design/tool-rename-consistency/tool-rename-consistency.md`](../../design/tool-rename-consistency/tool-rename-consistency.md) §决策。

## 目标

CONDITIONAL_TOOLS 在当前代码 100% 死/冗余(7 委派永远在 + 6 服务启动时常驻)。删除它,把门控收敛为**单一门控 = toolPolicy**(能力由 `capabilityHandlesFor` 从 policy 派生注入);把"policy 启用但服务没初始化"的静默藏换成 `capabilityHandlesFor` 的 loud 信号。

## 改动

### `src/runtime/tools/index.ts`
- 删除 `CONDITIONAL_TOOLS` map(index.ts:120-143)。
- `buildToolsSet` 删除 ② 层(index.ts:221-223 `const condition = CONDITIONAL_TOOLS[name]; if (condition && !condition(context)) continue;`)。循环只剩 ① 黑名单 + ③ `isEnabled`。

### `src/server/agent-service.ts`
- `capabilityHandlesFor`(line 433-446)加 loud 信号:当 `on("Wiki")` 等 policy 启用了某服务工具,但对应 `this.wikiStore`/`this.management`/`this.requirementStore`/`this.pmService` 未初始化时,`console.warn` 一条明确信息(如 `tool-policy enables Wiki but wikiStore is not initialized — tool will be offered but fail at call time`)。
  - **用 warn 不用 throw**:避免破坏构造部分 session 的测试 fixture;生产里服务永远在(启动时无条件 new),warn 永不触发,纯兜底。
  - 不改变 caps 的注入逻辑(仍 `service && on(tool)` 才注入)。

### 测试改写(行为变化)
- `tests/unit/f1-flow-tool.test.ts:245-260` "Flow tool · gating" 段:
  - 删除 "buildToolsSet excludes Flow when ctx has no requirementStore"(被移除的行为)。
  - 改为:"buildToolsSet includes Flow whenever policy enables(autoApprove * 或 toolPolicy),不再受 ctx.requirementStore 影响"。
  - 保留 "Flow is in ALL_TOOLS"。
- `tests/unit/tool-name-migration.test.ts:10` 注释:去掉"CONDITIONAL_TOOLS 过滤掉"叙事,改为说明"门控只靠 toolPolicy"。
- `tests/unit/m4-pm-tool.test.ts:171` 注释:"bypasses CONDITIONAL_TOOLS gating" → "bypasses toolPolicy gating"(或类似,语义对齐)。

### 验证 delegator 永远注入(支撑删 7 委派条件)
- 加一条测试:断言 `agent-loop.ts` 构造的 ctx 总有 `delegateTask/getTaskResult/listTasks/stopTask/suspendUntilWake`(或源码断言这些在构造器里无条件赋值)。作为"删 Subagent/Task*/Wait 条件安全"的契约。

## 不在范围
- RENAMED_TOOLS 迁移 map(保留,back-compat)。
- toolPolicy 本身的语义(不动)。
- renderer TOOL_DISPLAY_NAMES(B 的契约测试已守,不改)。

## 风险
- **行为变化**:原来"服务没初始化时静默藏工具"→ 现在"工具照常出现,调用时才报错 + 启动 warn"。生产无影响(服务永远在);测试 fixture 需自查是否构造了"无服务 + 启用该工具"的场景(会被新 warn 噪音或调用时错误影响)。
- f1-flow 测试改写是必须项(它正断言被删行为)。
- 删 ② 层后 `buildToolsSet` 签名不变(`context` 仍传,其它地方可能用),确认 context 参数仍被消费(如 mcpTools 合并、isEnabled 不用 context)。若 context 变成无人用,可后续清理参数(本 sub 不强求)。
