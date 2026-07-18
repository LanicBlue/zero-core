# Acceptance 04：Multi-pass CompressionPipeline

对应 [Plan 04](plan-04-multipass-compression.md)。

- [ ] 一 pass 与多 pass fixture 均覆盖 Snapshot 的每个 atom 恰好一次、顺序不变。
- [ ] 每个生成请求实际包含对应 transcript，不残留 `{transcript}` placeholder。
- [ ] 字符/token budget 不会让未读 Step 被 coverage/cursor 接纳。
- [ ] tool call/result、AskUser/answer 不跨 pass。
- [ ] pass N 使用 pass N-1 的内存 rolling summary；中间 summary/cursor 不写数据库。
- [ ] Compression 模型窗口小于 foreground 时可通过多个 pass 完成。
- [ ] 单 atom 超限稳定失败，不截断、不跳过、不推进。
- [ ] summary cap、target 和 preferred minimum reduction 有边界测试。
- [ ] 任一 pass failure/cancel/schema/digest 错误使 pipeline 整体失败。
- [ ] 最终 SummaryCandidate 包含完整 coverage、逐 pass digest/count 和 usage。
- [ ] Memory 逻辑 callId 数量不随 Compression pass 数变化。
