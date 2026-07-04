# acceptance-N4 — 配置字段热更 · 测试要求

> 节点 N4 验收。对应 [plan-N4.md](plan-N4.md)。

## 范围收窄(实现时核实)

原验收覆盖 model/provider/contextConfig/thinkingLevel/skillPolicy/knowledgeBaseIds 六字段。**实现时审计后收窄为三字段**:仅 model / provider / thinkingLevel 在本节点接通。

**理由**:`contextConfig` / `skillPolicy` / `knowledgeBaseIds` 经核实为 **Electron 路径死字段**(DB 存 + UI 可编辑,但 runtime/server 零消费;仅 headless CLI `cli.ts:196` 的 `buildSystemPrompt` 读 `contextConfig/enabledSkills`)。当前不构成『所见≠所跑』冲突(无『所跑』),接通属单独功能开发、不在本努力范围。详见 plan-N4.md 文首 + design §5/§9。

因此下方第 2 / 4 / 5 条(contextConfig / skillPolicy / knowledgeBaseIds)**取消**(死字段,非本节点)。第 1 / 3 / 6 条(model/provider、thinkingLevel、调用侧)为本节点实际验收。

## 完成判定
agent 行为字段 model / provider / thinkingLevel 在 loop 忙时改,下轮即生效;UI(经 N1 data:changed)与运行时同步,无"配了没生效"。(contextConfig/skillPolicy/knowledgeBaseIds 不在本节点——死字段,见上。)

## 单元测试(vitest)
1. **model/provider**:构造 loop(providerName/modelId = A)→ `applyConfigUpdate({providerName:B, modelId:C})` → `this.config.providerName===B && modelId===C` → 下一轮 `executeStream` 的 `resolveModel` 用 B/C(mock providers + spy 断言)。
2. **~~contextConfig~~** —— **取消(死字段,非本节点)**。contextConfig 经审计为 Electron 路径死字段(runtime/server 零消费),当前不构成『所见≠所跑』冲突。接通属单独功能开发。
3. **thinkingLevel**:写回 `this.config.thinkingLevel`;下一轮 providerOptions 携带新值。
4. **~~skillPolicy~~** —— **取消(死字段,非本节点)**。skillPolicy 经审计为 Electron 路径死字段(buildToolsSet 不读 skillPolicy;仅 headless CLI 读 enabledSkills)。
5. **~~knowledgeBaseIds~~** —— **取消(死字段,非本节点)**。knowledgeBaseIds 经审计为 Electron 路径死字段(context bundle 组装不读它)。
6. **调用侧**:agent-service `store.onChange`(loop busy 分支)传新 model/provider/thinkingLevel 到 applyConfigUpdate(改 AgentRecord → 触发)。(contextConfig/skillPolicy/knowledgeBaseIds 不传——死字段。)

## e2e / 手动
- agent 正在运行 → 改 model → **下一轮**用新 model(日志/provider 调用断言模型变了)。
- 运行中 → 改 thinkingLevel → 下一轮 providerOptions 携带新 budget。
- ~~运行中 → 关掉 device context(useDeviceContext:false)→ 下一轮 prompt 不含设备上下文。~~ **取消(死字段)**:contextConfig 在 runtime/server 零消费,改它本就无『所跑』侧效应。
- ~~运行中 → 启用某技能 → 下一轮工具集含该技能。~~ **取消(死字段)**:skillPolicy 在 buildToolsSet 不被读取。
- UI 侧(AgentEditor)显示的新值 == 运行时下轮用到的新值(经 N1 data:changed 同步)。

## 不变量 1 验收
- 编辑 model / provider / thinkingLevel(忙/闲)→ UI 显新 + 运行时下轮吃到,**无窗口期分歧**。
- 空闲时仍走整 loop 重建(agent-service 既有逻辑),全字段生效——回归不破。
- contextConfig / skillPolicy / knowledgeBaseIds 不在不变量 1 本节点验收(死字段,见文首)。

## 非目标
- maxTokens/temperature(非 AgentRecord 字段)。
