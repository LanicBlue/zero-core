# sub-6:模型模态显示(补在 context-usage 旁)

- **effort**:multimodal-input
- **依赖**:sub-3(getMultimodal 已可解析)
- **关联**:组件 7

## 范围

现有 `context-usage` 条(ChatPanel.tsx:742-767)旁补**模态标识**(当前模型支持哪些输入模态),数据源 `ProviderModel.multimodal`(读 sub-3 的 `getMultimodal`)。数据通路:`sessionsGetInit` payload(agent-service.ts:1708)补当前模型 multimodal → chat-store `ContextInfo` 加字段 → ChatPanel 渲染。`multimodal===undefined` 显示"未知"。provider 配置页可手填 multimodal(true/false)。

## 交付物

- `src/server/agent-service.ts`:`sessionsGetInit` payload 加 `modelMultimodal`(从 getMultimodal 解)。
- `src/renderer/store/chat-store.ts`:`ContextInfo` 加 `modelMultimodal?: boolean`。
- `src/renderer/components/layout/ChatPanel.tsx`:context-usage 条旁渲染模态标识(🖼 image 支持 / 未知)。
- provider 配置页:模型编辑可手填 `multimodal`(覆盖 OpenRouter 未覆盖的模型)。
- 单测。

## 不做

E2E(sub-7)。

## 验收

见 `./acceptance-6.md`。
