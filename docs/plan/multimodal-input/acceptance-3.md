# acceptance-3:providerSupportsMultimodal + getMessages 构造

对应 `./sub-3.md`。

## 功能验收
- [ ] `getMultimodal`(或 resolveModelCapability)在 provider-factory.ts,搭 `getContextWindow` 同一条 find;返 `model?.multimodal ?? false`。
- [ ] agent-loop 在 getContextWindow 旁解析 multimodal 并传入 getMessages(**#3 wiring 真接通**,呼应 [[feedback-verify-runtime-wiring]])。
- [ ] getMessages **当前 step + image + 支持** → content array inline image part(从盘读 bytes)。
- [ ] getMessages **历史 step**(无论支持)/ PDF / 任意文件 / 不支持 → 元信息文本 part。
- [ ] "当前 step" = 最近一条 user step(同 turn 多步均当前),边界正确。

## 单测
- [ ] `tests/unit/getmessages-multimodal.test.ts`:
  - mock provider multimodal=true + 当前 image step → inline;同 image 在历史 → 元信息。
  - multimodal=false + 当前 image → 元信息。
  - PDF/任意文件 → 始终元信息(无论当前/支持)。
  - getMultimodal:multimodal=undefined → false;true → true。

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] `vitest run tests/unit/getmessages-multimodal.test.ts` 绿。
