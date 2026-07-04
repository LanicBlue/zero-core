# plan-N4 — 配置字段热更(不变量 1:所见即所跑)

> 节点 N4(无依赖,纯 agent-loop)。目标:agent 任意字段在 loop 忙时改,下轮即生效;UI 与运行时无"配了没生效"缝隙。对应 design §5 不变量 1、§7。

## 范围收窄(实现时核实)

原计划补 model / provider / contextConfig / thinkingLevel / skillPolicy / knowledgeBaseIds 六字段。**实现时审计后收窄为三字段**:`model` / `provider` / `thinkingLevel`。

**理由**:`contextConfig` / `skillPolicy` / `knowledgeBaseIds` 经核实为 **Electron 路径死字段**——DB 存(`agents.context_config` / `agents.skill_policy` / `agents.knowledge_base_ids`)+ UI 可编辑,但 **runtime/server 零消费**(建 loop 时未解析进 prompt/contextBundle,buildToolsSet 不读 skillPolicy,context bundle 组装不读 knowledgeBaseIds)。仅 headless CLI 路径 `cli.ts:196` 的 `buildSystemPrompt` 用 `contextConfig/enabledSkills`。当前不构成『所见≠所跑』冲突——无『所跑』侧消费它们。接通这三个字段需先在建 loop 阶段把它们接进消费链路(prompt/contextBundle/tools),再在 applyConfigUpdate 同步失效相关缓存,是**单独的功能开发**,不在本努力范围。详见 design §5 / §9 已同步更正。

本节点只做 model / provider / thinkingLevel 三字段(均有明确每轮消费点,补写回即下轮生效)。

## 范围
补全 [applyConfigUpdate](../../../src/runtime/agent-loop.ts#L475) 未覆盖的 AgentRecord 行为字段,使忙时改也能下轮吃到。

## 实现步骤(已核实字段)
1. **model / provider**:[agent-loop.ts](../../../src/runtime/agent-loop.ts) `applyConfigUpdate` 接收并写回 `this.config.providerName`/`this.config.modelId`。`executeStream` 每轮已 `resolveModel(this.providers, this.config.providerName, this.config.modelId)`(L577)重读 → 下轮自动用新模型。轮间切模型安全(每轮是独立 LLM 调用)。**[已实现]**
2. ~~**contextConfig**(useDeviceContext/useGuidelines/useMemoryContext)~~ —— **取消(死字段)**:runtime/server 零消费,接通属单独功能开发。
3. **thinkingLevel**:写回 `this.config.thinkingLevel`;`src/runtime/hooks/provider-options-hooks.ts` 在 PreLLMCall 每轮读 `ctx.config.thinkingLevel` → 下轮 providerOptions 自动用新。**[已实现]**
4. ~~**skillPolicy**(enabledSkills)~~ —— **取消(死字段)**:buildToolsSet 不读 skillPolicy。
5. ~~**knowledgeBaseIds**~~ —— **取消(死字段)**:context bundle 组装不读它。
6. **调用侧**:[agent-service.ts](../../../src/server/agent-service.ts) `store.onChange`(loop busy 分支)的 `applyConfigUpdate({...})` 调用,补传 `providerName: agent.provider` / `modelId: agent.model` / `thinkingLevel: agent.thinkingLevel`(从新 `agent` record 取,undefined/null 也要传,由 applyConfigUpdate 的 `!== undefined` guard 处理)。**[已实现]**

## 关键文件
`src/runtime/agent-loop.ts`(applyConfigUpdate + 确认 per-turn 消费)· `src/server/agent-service.ts`(store.onChange 传字段)

## 不涉及(核实非 gap)
- `maxTokens`/`temperature` —— 非 AgentRecord 字段(maxTokens 属 ProviderModel)。
- `contextConfig` / `skillPolicy` / `knowledgeBaseIds` —— Electron 路径死字段(DB 存 + UI 可编辑,runtime/server 零消费);仅 headless CLI `cli.ts:196` 的 `buildSystemPrompt` 读 `contextConfig/enabledSkills`。当前不构成『所见≠所跑』冲突。接通属单独功能开发,不在本节点。

## 风险
- ~~contextConfig re-resolve 要复用建 loop 时的同一套解析(device context/guidelines/memory 组装),避免逻辑分叉。~~ 取消(死字段,非本节点)。
- ~~skillPolicy/knowledgeBaseIds 的 per-turn 消费点要核实(是否每轮重读);若缓存则一并同步。~~ 取消(死字段,非本节点)。
- model 切换 mid-turn 不可能(一轮一流),applyConfigUpdate 在轮间生效,符合预期。
- **AgentStore 把未设的可选 TEXT 列读回为 `null`(SQLite 约定),不是 `undefined`**。applyConfigUpdate 的 guard 是 `!== undefined`,所以 `null` 会覆盖(把 config 设为 null)。实践中 UI 不会在运行中的 loop 上把这些字段清空到 null(agent editor 保留旧值或字段必填),故当前不构成问题;若日后允许清空,需在 store 边界把 `null` 规范化为 `undefined`(单独修复)。
