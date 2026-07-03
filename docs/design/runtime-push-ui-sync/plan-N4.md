# plan-N4 — 配置字段热更(不变量 1:所见即所跑)

> 节点 N4(无依赖,纯 agent-loop)。目标:agent 任意字段在 loop 忙时改,下轮即生效;UI 与运行时无"配了没生效"缝隙。对应 design §5 不变量 1、§7。

## 范围
补全 [applyConfigUpdate](../../../src/runtime/agent-loop.ts#L475) 未覆盖的 AgentRecord 行为字段,使忙时改也能下轮吃到。

## 实现步骤(已核实字段)
1. **model / provider**:[agent-loop.ts](../../../src/runtime/agent-loop.ts) `applyConfigUpdate` 接收并写回 `this.config.providerName`/`this.config.modelId`。`executeStream` 每轮已 `resolveModel(this.providers, this.config.providerName, this.config.modelId)`(L577)重读 → 下轮自动用新模型。轮间切模型安全(每轮是独立 LLM 调用)。
2. **contextConfig**(useDeviceContext/useGuidelines/useMemoryContext):applyConfigUpdate 写回 `this.config.contextConfig` + 按新值 re-resolve 进 systemPrompt/contextBundle + `this.promptAssembler.invalidate("base")`(同 systemPrompt 热更的失效机制)。
3. **thinkingLevel**:写回 `this.config.thinkingLevel`;确认每轮 providerOptions 读它(若缓存则同步到 per-turn 组装处)。
4. **skillPolicy**(enabledSkills):写回 `this.config.skillPolicy` + 同步 `this.toolContext`(技能作为工具,影响 buildToolsSet;每轮已重读 toolPolicy,技能同款)。
5. **knowledgeBaseIds**:写回 `this.config.knowledgeBaseIds` + 同步 context bundle 组装(影响 per-turn 注入)。
6. **调用侧**:[agent-service.ts](../../../src/server/agent-service.ts) `store.onChange` 的 `applyConfigUpdate({...})` 调用,补传上述新字段(从新 `agent` record 取)。

## 关键文件
`src/runtime/agent-loop.ts`(applyConfigUpdate + 确认 per-turn 消费)· `src/server/agent-service.ts`(store.onChange 传字段)

## 不涉及(核实非 gap)
- `maxTokens`/`temperature` —— 非 AgentRecord 字段(maxTokens 属 ProviderModel)。

## 风险
- contextConfig re-resolve 要复用建 loop 时的同一套解析(device context/guidelines/memory 组装),避免逻辑分叉。
- skillPolicy/knowledgeBaseIds 的 per-turn 消费点要核实(是否每轮重读);若缓存则一并同步。
- model 切换 mid-turn 不可能(一轮一流),applyConfigUpdate 在轮间生效,符合预期。
