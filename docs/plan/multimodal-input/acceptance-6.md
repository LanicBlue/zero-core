# acceptance-6:模型模态显示

对应 `./sub-6.md`。

## 功能验收
- [ ] `sessionsGetInit` payload 含当前模型 multimodal(经 getMultimodal 解)。
- [ ] `ContextInfo` 加 `modelMultimodal` 字段;ChatPanel context-usage 条旁渲染模态标识。
- [ ] multimodal=true → 显示 image 支持;undefined → "未知";false → 不支持标识。
- [ ] provider 配置页:模型可手填 multimodal(true/false);手填值进 ProviderModel.multimodal。

## 单测
- [ ] `tests/unit/model-multimodal-display.test.ts`:sessionsGetInit payload 带 multimodal;ContextInfo 字段流转。
- [ ] provider 配置页保存 multimodal → ProviderModel.multimodal 持久化。

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] `vitest run tests/unit/model-multimodal-display.test.ts` 绿。
