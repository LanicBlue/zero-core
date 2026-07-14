# acceptance-3b:滚动摘要 + handoff + cap + prompt 可配 + ExtractorA 拆除

> 对应 [./sub-3b.md](./sub-3b.md)。

## 功能验收

1. **滚动摘要**:`compressSession` 用 update(旧摘要 + 被压 steps),非重述;多次压缩信息不丢(测:压两次,关键事实仍在摘要)。
2. **handoff 前缀**:摘要含"交接说明/背景参考"语义;旧 handoff 过时指令再压缩时剥除。
3. **长度上限**:摘要不无限累积(超预算时压缩到 N 内)。
4. **ExtractorA compression 拆除**:`compression-core.ts` 不再调 `mergeSummaryIntoWiki`(grep 零命中)。
5. **压缩 prompt 可配**:从 settings/memory 读;默认=现 `SUMMARY_SYSTEM`;改坏走 `fallbackSections`。

## 不破坏验收

6. 压缩摘要测试过。

## build

7. **typecheck 过**(`build:lib`)。
