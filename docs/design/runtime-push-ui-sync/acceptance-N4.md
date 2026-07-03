# acceptance-N4 — 配置字段热更 · 测试要求

> 节点 N4 验收。对应 [plan-N4.md](plan-N4.md)。

## 完成判定
agent 任意行为字段(model/provider/contextConfig/thinkingLevel/skillPolicy/knowledgeBaseIds)在 loop 忙时改,下轮即生效;UI(经 N1 data:changed)与运行时同步,无"配了没生效"。

## 单元测试(vitest)
1. **model/provider**:构造 loop(providerName/modelId = A)→ `applyConfigUpdate({providerName:B, modelId:C})` → `this.config.providerName===B && modelId===C` → 下一轮 `executeStream` 的 `resolveModel` 用 B/C(mock providers + spy 断言)。
2. **contextConfig**:`applyConfigUpdate({contextConfig:{useGuidelines:false}})` → `this.config.contextConfig` 更新 + `promptAssembler.invalidate("base")` 被调 → 下一轮组 prompt 不含 guidelines。
3. **thinkingLevel**:写回 `this.config.thinkingLevel`;下一轮 providerOptions 携带新值。
4. **skillPolicy**:`applyConfigUpdate({skillPolicy:{enabledSkills:["X"]}})` → `this.toolContext`/config 同步 → 下一轮 buildToolsSet 含技能 X。
5. **knowledgeBaseIds**:写回 + 同步 context bundle 组装。
6. **调用侧**:agent-service `store.onChange`(loop busy 分支)传新 model/provider/contextConfig/skillPolicy/knowledgeBaseIds/thinkingLevel 到 applyConfigUpdate(改 AgentRecord → 触发)。

## e2e / 手动
- agent 正在运行 → 改 model → **下一轮**用新 model(日志/provider 调用断言模型变了)。
- 运行中 → 关掉 device context(useDeviceContext:false)→ 下一轮 prompt 不含设备上下文。
- 运行中 → 启用某技能 → 下一轮工具集含该技能。
- UI 侧(AgentEditor)显示的新值 == 运行时下轮用到的新值(经 N1 data:changed 同步)。

## 不变量 1 验收
- 编辑任意 AgentRecord 行为字段(忙/闲)→ UI 显新 + 运行时下轮吃到,**无窗口期分歧**。
- 空闲时仍走整 loop 重建(agent-service 既有逻辑),全字段生效——回归不破。

## 非目标
- maxTokens/temperature(非 AgentRecord 字段)。
