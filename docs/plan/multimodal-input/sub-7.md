# sub-7:E2E(多模态全链路)

- **effort**:multimodal-input
- **依赖**:sub-1~6 全部
- **关联**:组件全覆盖;[[project-e2e-test-setup]]

## 范围

E2E(Playwright + Electron + mock provider,经 `ZERO_CORE_TEST_FIXTURE`)覆盖多模态输入全链路:
- 粘贴图片 → upload 落盘 → 发送 → mock **支持** provider 收到 inline image content array。
- 配 **不支持** provider(mock multimodal=false)→ 收到元信息文本(非 inline)。
- 历史附件缩略图经 `attachments:content` 端点显示。
- context-usage 旁模态标识正确显示。
- 仅附件无文本可发送。

## 交付物

- `tests/e2e/multimodal-input.spec.ts`:上述场景。
- 跑构建产物(记忆 [[project-e2e-test-setup]])。

## 验收

见 `./acceptance-7.md`。
