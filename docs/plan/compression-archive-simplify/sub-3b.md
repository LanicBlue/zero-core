# sub-3b:滚动摘要 update + handoff + cap + prompt 可配 + ExtractorA compression 拆除

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:**sub-3a**(2区数据模型)。原 sub-3 拆分的第二段(摘要层)。

## 范围

compressSession 改滚动摘要(update 旧+新,非重述)+ handoff 前缀 + 长度上限;拆 ExtractorA compression 耦合;压缩 prompt 可配。详见 design「二、压缩流程」滚动摘要 / handoff / cap / D2 段。

## 改动

- **滚动摘要**:[compression-core.ts](../../../src/server/compression-core.ts) `compressSession` 改 update(旧摘要 + 被压 steps),非从头重述;**handoff 前缀**("交接说明/背景参考,非当前指令");**长度上限**(maxOutputTokens 预算,prompt 指示控制在 N 内防累积膨胀)。
- **拆 ExtractorA compression 耦合**:删 `compression-core.ts` 的 `opts.extractorA.service.mergeSummaryIntoWiki` fire-and-forget(由 Force 档 memory turn 替代,sub-3c)。**不删** `extractor-a-service.ts` 主体(sub-5)。
- **D2 压缩 prompt 可配**:压缩 system prompt 从 settings/memory(`MemorySettings`)读,默认=现 `SUMMARY_SYSTEM`;输出 sections 契约固定(parser 依赖),改坏 `fallbackSections` 兜底。

## 不做(scope 边界)

- 不动双机制触发(sub-3c)/ 归档(sub-4)/ 数据模型(sub-3a)。
- 不删 `extractor-a-service.ts` 主体(sub-5)。

## 验证

见 [./acceptance-3b.md](./acceptance-3b.md)。
