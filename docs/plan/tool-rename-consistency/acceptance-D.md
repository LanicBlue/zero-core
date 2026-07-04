# Acceptance-D:删除 CONDITIONAL_TOOLS + 启动校验

> 节点 D 验收。对应 [plan-D.md](plan-D.md)。

## 实施核对(review sub-D 改动)

- [ ] `src/runtime/tools/index.ts`:`CONDITIONAL_TOOLS` 整个删除;`buildToolsSet` 循环只剩 ① 黑名单 + ③ isEnabled(无 ② capability 层)。
- [ ] `src/server/agent-service.ts`:`capabilityHandlesFor` 在 policy 启用服务工具但服务未初始化时 `console.warn`(warn 不 throw;注入逻辑不变)。
- [ ] grep:`src/` 内无 `CONDITIONAL_TOOLS` 残留。

## 测试(sub2 写 + 跑绿)

- [ ] **delegator 永远注入契约**:新测试断言 agent-loop 构造的 ctx 无条件带 `delegateTask/getTaskResult/listTasks/stopTask/suspendUntilWake`(或源码断言无条件赋值)→ 支撑删 7 委派条件。
- [ ] **f1-flow-tool.test.ts**:"Flow tool · gating" 段改写:删"无 requirementStore → 排除";加"policy 启用即包含,不受 ctx.requirementStore 影响"。
- [ ] **tool-name-migration / m4-pm-tool** 注释对齐(无功能断言变化)。
- [ ] **新行为契约**:buildToolsSet 在 autoApprove ["*"] 下,无论 ctx 有没有 wikiStore/management/requirementStore,Wiki/Project/Flow 都被包含(单一门控 = policy)。
- [ ]capabilityHandlesFor warn 触发测试:构造"policy 启用 Wiki 但 wikiStore 未设"→ 断言 console.warn 被调用(spawnAgent 路径或单测 capabilityHandlesFor)。

## 构建 + 回归
- [ ] `npm run build:lib`(tsc)绿。
- [ ] `vitest` 全绿(基线 = sub-B 完成时的数量)。
- [ ] grep `src/` 无 `CONDITIONAL_TOOLS`。

## 完成
全绿 → commit(`refactor(tools): 删除 CONDITIONAL_TOOLS,门控收敛为单一 toolPolicy + 启动 warn`)→ 整个 effort(sub-B + sub-D)完成 → 用户同意合并 master → 归档 `docs/archive/tool-rename-consistency/`。不绿 → review 意见回 sub-D。
