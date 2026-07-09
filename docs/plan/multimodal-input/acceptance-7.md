# acceptance-7:E2E 全链路

对应 `./sub-7.md`。

## 功能验收(E2E,跑构建产物)
- [ ] 粘贴图片 → 待发送区缩略图 → 发送 → mock 支持 provider 收到 **inline image** content array。
- [ ] mock 不支持 provider(multimodal=false)→ 收到**元信息文本**(非 inline)。
- [ ] 发送后切走再切回(或重启)→ 历史附件缩略图经 `attachments:content` 端点**正常显示**。
- [ ] context-usage 条旁**模态标识**正确(支持/未知/不支持)。
- [ ] 仅附件无文本可发送。
- [ ] +号导入 / 拖拽 两入口同样跑通。

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] 全量 `vitest run`(单测,--no-file-parallelism 如需)绿。
- [ ] E2E `tests/e2e/multimodal-input.spec.ts` 绿(经 ZERO_CORE_TEST_FIXTURE + mock provider)。
