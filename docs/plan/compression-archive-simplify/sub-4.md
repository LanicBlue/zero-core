# sub-4:归档(Q5b + re-activate + 即时原子 export + DB 锁 + ExtractorA archive 耦合拆除)

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:**sub-2**(ephemeral turn)。

## 范围

归档改两阶段(Q5b memory + 即时原子 export)+ 子 agent re-activate(GAP2)+ per-session DB 锁;拆 archive-service 的 ExtractorA 耦合。详见 design「三、归档流程」。

## 改动

- **归档流程**:`memory ephemeral turn(sub-2,自写 wiki)→ mark(archived=1,瞬态)→ 原子 export(tmp+rename+校验可解析)+ 删行`。export 无 LLM,廉价。
- **子 agent(GAP2 = re-activate)**:`fireOnTaskTerminal` 后,**从没压缩过**的短 session → re-activate 跑一轮 memory ephemeral turn → export;**压缩过**的长 session(compression memory turn 已写 wiki)→ 直接 export(不 re-activate)。
- **手动归档**:活跃 session 先跑 memory ephemeral turn → mark → export。
- **原子 export**:写 `<id>.json.tmp` → 校验 JSON 可解析 → `rename` → 才删 DB 行。任一步失败不删。
- **可恢复**:启动扫 `archived=1 且仍有行` 的 session,重跑 export(mark→export 间崩的兜底)。
- **per-session DB 锁**:归档并发(手动 vs 自动同 session)抢锁(原子 acquire + TTL 恢复,hermes 式);防竞态。
- **砍 final compression(D4)**:归档不再跑 `compressSession`;删 `buildFinalCompressOpts` 复制。
- **拆 ExtractorA archive 耦合**:删 `archive-service.ts` 的 ExtractorA lazy import + `mergeSummaryIntoWiki`(由 Q5b memory turn 替代)。不删主体(sub-5)。
- **optional(可 deferred)**:restore 通路(IPC 读 JSON 重建 session 行)、archives 轮转/上限。本 sub 至少留接口,实现可 deferred 并标注。

## 不做(scope 边界)

- 不删 `extractor-a-service.ts` 主体(sub-5)。
- 不动压缩(sub-3)。

## 验证

见 [./acceptance-4.md](./acceptance-4.md)。
