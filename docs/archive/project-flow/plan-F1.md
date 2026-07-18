# plan-F1 — Flow 工具骨架 + 读

> 节点 F1(基石,无依赖)。目标:新建 Flow 工具,先开 `create`(→Found,自然发 `created`)+ `list`/`get`,与旧工具并行存在(不替换)。对应 [project-flow.md](./project-flow.md) §2/§8。

## 范围
- 新建 `src/runtime/tools/flow-tool.ts`:action 切换工具 `Flow`,首批评 action:`create` / `list` / `get`。
- 注册到 `src/runtime/tools/index.ts`(ALL_TOOLS + CONDITIONAL_TOOLS 门控)。
- agent-service 能力注入:Flow 启用 → 注入 `requirementStore`。
- `create` 写文档 **Intent 段**到 `{workspace}/docs/requirements/{id}.md`(文件,**不入 DB**)。
- **不替换**旧 CreateRequirement / verify(并行)。

## 实现步骤
1. **核实状态串**:读 [requirement-state-machine](../../../src/server/) 确认 Found 态的确切字符串(预期 `found`),以及 create 的合法初态。本阶段只用到 `found`。
2. **新建 flow-tool.ts**:`buildTool({ name:"Flow", ... })`,flat action schema(参照 project-tool.ts / agent-registry.ts 的 FLAT z.object 模式,顶层不能用 discriminatedUnion)。
   - `create`:{ projectId, title, description?, priority?, impactScope? } → `ctx.requirementStore.create({ projectId, title, description, status:"found", source:"agent", priority, impactScope, reviewer:"agent" })` 返回 record。**写文档 Intent 段**到 `{workspace}/docs/requirements/{id}.md`(服务端 fs 写,建文件 + Intent 段 = description 全文;workspace 从 session/project 上下文解析)。**发 `created`**:`RequirementStore.create` 走 SqliteStore → hub 自动发 `requirements.create`(op=create)= created 信号,无需额外 emit。
   - `list`:{ projectId?, status?, priority? } → `ctx.requirementStore.list(...)`.
   - `get`:{ id } → `ctx.requirementStore.get(id)`(本阶段只返 record,不含 messages)。
   - meta.category 用 `"management"`(暂归类管理域,F5 视情况调)。
3. **注册**:`tools/index.ts` `import { flowTool }`;`ALL_TOOLS.Flow = flowTool`;`CONDITIONAL_TOOLS.Flow = (ctx) => !!ctx.requirementStore`。
4. **能力注入**:[agent-service.ts](../../../src/server/agent-service.ts) ~L422 `capabilityHandlesFor`:把 `on("Flow")` 加进 requirementStore 注入条件(`on("Flow") || on("CreateRequirement") || on("verify")`)。verify/CreateRequirement 本阶段保留。
5. **prompt/description**:Flow 描述 create/list/get(简洁,后续 F2 扩)。

## 关键文件
`flow-tool.ts`(新)· `tools/index.ts` · `agent-service.ts`

## 不做(留其他阶段)
- 迁移 action(pick/ready/plan/startBuild/finishBuild/verify)→ F2。
- 命名迁移 hook 信号机制 → F2(create 的 created 走现成 op=create,F2 才需要扩展)。
- 拆 verify / 替换旧工具 / work 重配 → F3。

## 风险
- create 的 source/reviewer 字段:参照现 CreateRequirement 工具(`source:"analyst"`, `reviewer:"analyst"`)——本工具是通用 agent,source 用什么待定(F1 先用 `"agent"`,F3 收口时统一)。
- Found 态状态串以 requirement-state-machine 为准,别臆测。
