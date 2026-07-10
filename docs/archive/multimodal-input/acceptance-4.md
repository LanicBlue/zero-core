# acceptance-4:run 签名 + chat:send 接线 + 显示通路

对应 `./sub-4.md`。

## 功能验收
- [ ] `run` 接受 `string | UserContent`;旧 string 调用点(recovery/delegation 等)仍工作。
- [ ] `chat:send` IPC 加 attachments(只 meta,含 diskPath);**不带 bytes**(原则 A)。
- [ ] chat router → agent-service → run 串通 UserContent;step 落盘 attachments(sub-2)。
- [ ] `buildStepLevelMessages` 填 `ChatMessage.attachments`;`ChatMessage` 有 attachments 字段。
- [ ] 端到端:发送带附件消息 → turns 落 attachments → sessionsGetInit 回 → ChatMessage.attachments 有值。

## 单测/接线测
- [ ] `tests/unit/chat-send-multimodal.test.ts`:chat:send 带 attachments → run 收到 UserContent → step 存储 attachments。
- [ ] buildStepLevelMessages 把 attachments 填进 ChatMessage。

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] `vitest run` 相关单测绿。
