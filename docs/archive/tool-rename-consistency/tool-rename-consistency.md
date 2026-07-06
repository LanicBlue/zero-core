# Design:工具改名一致性加固

> 状态:**✅ 已合并 master(2026-07,B + D)**。
> 对应 issue:[`./issue.md`](./issue.md)。
> 本文档是 ② design 阶段(方案讨论 + 推荐 + 决策);issue 是①问题记录。

## 问题回顾(详见 issue)

工具名有 8 个真相源,改名需全部手动同步。e8128d8 漏改 `ALL_TOOLS` key → UI 显示旧名。当前全仓已一致(2026-06 全量修复),但根因(多真相源 + 手动同步)仍在。目标:**让改名从"改 8 处"降到"改 1 处",并用 CI 兜底**。

## 关键事实(审计)

- `ALL_TOOLS`(index.ts:77)是字面量对象,key 是手写字符串。
- `registerRuntimeTools` / `buildToolsSet` / `getToolCategories` / `getAllToolInfo` 全部用 `Object.entries(ALL_TOOLS)` 的 **key** 作为工具名(注册名、门控查 `CONDITIONAL_TOOLS[name]`、`/tools` API 名)。
- `getToolName(def)`(tool-factory.ts:292)读 `def.__name`,由 `buildTool({name})` 在 tool-factory.ts:239 设置。**已存在,可直接用。**
- 每个工具文件的 `buildTool({name:"X"})` 是 canonical 名的唯一源头。
- platform 工具(`createPlatformTools()`)也走 buildTool(`__name="Platform"`),派生机制对它同样适用。
- `ALL_TOOLS[name]` 全仓仅 2 处动态 key 访问;其余靠迭代。

→ **把 `ALL_TOOLS` 的 key 从"手写字面量"改成"从工具自身 `__name` 派生"在结构上可行。**

## 方案

### A — 仅契约测试(最便宜)

加测试断言:① 每个 `ALL_TOOLS` key === `getToolName(def)`;② `CONDITIONAL_TOOLS` keys ⊆ `ALL_TOOLS` keys;③ 种子策略 tools keys ⊆ (`ALL_TOOLS` ∪ `RENAMED_TOOLS`) keys。

- ✅ 不动结构,覆盖所有真相源。
- ❌ 重复仍在,人改名仍需手改多处,只是错了 CI 红。改名成本没降。

### B — `ALL_TOOLS` key 派生 + 契约测试(推荐)

把字面量改成派生:

```ts
// 每个工具的 canonical 名只在它自己的 buildTool({name}) 里(单一来源)。
// ALL_TOOLS 的 key 由 __name 派生 —— 改名 = 只改工具文件一处 name:。
const TOOL_DEFS = [
    bashTool, fileReadTool, fileWriteTool, fileEditTool, grepTool, globTool,
    delegateTool, taskStatusTool, taskListTool, taskStopTool, waitTool,
    webSearchTool, askUserTool, todoWriteTool, webFetchTool, sequentialThinkingTool,
    orchestrateTool, projectTool, workTool, agentRegistryTool, cronTool, wikiTool, flowTool,
];
export const ALL_TOOLS: Record<string, any> = Object.fromEntries([
    ...TOOL_DEFS.map((def) => [getToolName(def), def]),
    ...Object.entries(getPlatformTools()),   // platform 工具(也带 __name,可同样派生)
]);
```

#1 与 #2 真相源从结构上**不可能不一致**。再补方案 A 的契约测试守 #3(CONDITIONAL_TOOLS)+ #6(种子策略)。

- ✅ 改名成本 "8 处 → 1 处",根除本次事故类别。
- ✅ platform 工具一并覆盖。
- ⚠️ 现有源码契约测试(`p2-agent-runtime.test.ts` 的 `/Subagent:\s*delegateTool/` 正则)失效 —— 改为运行时断言 `ALL_TOOLS["Subagent"] === delegateTool`。
- ⚠️ `/tools` 列表顺序 = `TOOL_DEFS` 数组顺序(可控,按上表保持现状顺序即可,UI 无序变化)。

### C — 全量单一来源(最彻底)

B + 把 `CONDITIONAL_TOOLS` 的门控条件挪进每个工具的 `meta.condition`,从工具 def 派生,连 #3 也消除。

- ✅ 最彻底,改名/改门控都在工具自身文件。
- ❌ 侵入面最大:动 `tool-factory` 的 `ToolMeta` 类型 + 每个条件工具(Subagent/TaskStatus/.../Project/Cron/Wiki/Flow/Orchestrate/Wait 等 ~12 个)。

## 推荐:**B**

B 消除了本次实际事故的根因(key↔name 不一致),改名降到一处,成本/收益最优。C 的边际收益(门控也单一来源)不足以抵消其侵入面 —— 可作为未来单独 issue 增量推进(若 CONDITIONAL_TOOLS 再出问题)。

## 待决策(进③ plan 前需定)

1. **选 A / B / C?**(推荐 B)
2. **B 的列表顺序**:上表 `TOOL_DEFS` 顺序是否保持当前 ALL_TOOLS 字面量顺序?(影响 `/tools` API/UI 列表呈现;建议保持,避免无谓 UI diff)
3. **CONDITIONAL_TOOLS 是否本次一并纳入派生?**(即直接做 C;默认不做,留 B)

## 下一步

用户拍板 → ③ `docs/plan/tool-rename-consistency/` 拆 sub(sub1:派生 ALL_TOOLS + platform;sub2:契约测试;sub3:源码契约测试改造)→ branch 逐 sub 实施 + 验收 → 合并 → 归档。

---

## 决策(2026-07-04 讨论后)

**采用 B + D(删 CONDITIONAL_TOOLS),C 作废。**

讨论中追问"门控为什么在工具这里"引出对 CONDITIONAL_TOOLS 的审计,结论:

### CONDITIONAL_TOOLS 在当前代码 100% 死/冗余

`buildToolsSet` 三层过滤(① 黑名单 / ② CONDITIONAL / ③ policy),其中 ② 检查 `ctx` 有没有工具的运行时依赖句柄。但:

- **能力注入已由 toolPolicy 派生**(`agent-service.ts:433 capabilityHandlesFor`):`ctx.wikiStore` 当且仅当 `on("Wiki") && this.wikiStore` 才注入。所以 ② 和 ③ 在正常路径完全等价。
- **7/13 条件纯死代码**:Subagent/Orchestrate/TaskStatus/TaskList/TaskStop/Wait 检查的 delegator 方法在 `agent-loop.ts:173-181` 永远注入(`delegateTask is wired on every session`,代码注释自证)。
- **6/13 条件生产里永不 fire**:Project/Work/AgentRegistry/Cron/Wiki/Flow 的 backing 服务(management/wikiStore/requirementStore/pmService)在 `server/index.ts:128/161/163/234/516` 全部**启动时无条件 `new`**,setXxx 也不在 if 里 → 服务永远在 → `!!ctx.X` 永远真。
- **唯一能 fire 的场景**("policy 启用但服务没初始化")在生产不会发生;且"静默藏工具"是反模式(policy 撒谎),应换成启动 loud 校验。

→ **删除整个 CONDITIONAL_TOOLS**。配套:删 `buildToolsSet` 的 ② 层;在 `capabilityHandlesFor` 加 loud 信号(policy 启用了某服务工具但该服务未初始化 → warn/throw,把静默藏换成显式报错)。这把门控收敛为**单一门控 = toolPolicy**(能力由 policy 派生注入)。

### 顺带消解改名真相源

删 CONDITIONAL_TOOLS 后,改名少一个同步点;B(派生 ALL_TOOLS key)即完整单一来源,C(把条件挪进 meta)作废——没有 CONDITIONAL_TOOLS 可挪了。

### 测试影响(D 必须处理)

- `tests/unit/f1-flow-tool.test.ts:252` 断言"没 requirementStore → Flow 被排除"——正是被移除的行为,需改写为新语义(或删)。
- `tests/unit/tool-name-migration.test.ts:10` 注释引用 CONDITIONAL_TOOLS 过滤行为,需同步。
- 无测试直接 import CONDITIONAL_TOOLS(它是 index.ts 内部 const,不导出)。

## 最终方案(两并列工作流,同一 effort/branch)

- **sub-B:ALL_TOOLS key 派生** —— key 从 `getToolName(def)` 派生(platform 工具同法),顺序保持;迁移 `p2-agent-runtime` 源码契约正则为运行时断言;加契约测试(ALL_TOOLS key === getToolName(def);种子策略 ⊆ ALL_TOOLS ∪ RENAMED_TOOLS)。
- **sub-D:删 CONDITIONAL_TOOLS + 启动校验** —— 删 map + buildToolsSet ② 层;`capabilityHandlesFor` 加服务缺失 loud 信号;改写 f1-flow / tool-name-migration 受影响测试;验证 delegator 永远注入。

互不阻塞,但同在 `src/runtime/tools/index.ts`,按 B → D 顺序提交。详见 [`./`](./)(plan-B/acceptance-B/plan-D/acceptance-D)。
