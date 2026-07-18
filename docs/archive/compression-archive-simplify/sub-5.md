# sub-5:死代码清理(删 ExtractorA 主体 + compaction/context + steps.compressed + compression.enabled)

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:**sub-3 + sub-4**(ExtractorA 两处消费者已拆,才能删主体)。

## 范围

删全部死代码 / 假配置面 + ExtractorA 主体(sub-3/4 已拆耦合)。纯减法,可与前面并行但 ExtractorA 主体删除必须在 sub-3/4 后。

## 改动

- **删 ExtractorA 主体**:`extractor-a-service.ts` + sub-3/4 已拆的两处 lazy import 残留 + `buildExtractorA` wiring([server/index.ts](../../../src/server/index.ts)) + 退役的 `extraction-hooks.ts` stub。**确认 ExtractorB 不受影响**(独立 telemetry 数据流)。
- **删 compaction/context 死模块**:`compaction.ts` + `context-manager.ts` + `src/index.ts` 的 re-export。
- **删配置面**:`compaction.*` / `context.*`(只喂死模块)+ settings UI 引用。`compaction.*` 已被 sub-3 的可配压缩 prompt 取代。
- **删 steps.compressed 列**:`session-db.ts` schema + `db-migration.ts`(同步,否则 fresh DB 缺列——见项目记忆)。
- **compression.enabled 删**(未读假配置);模型配置改名 `compression.provider/model`(sub-3 已用)。

## 不做(scope 边界)

- 不动 wiki 注入(sub-1)/ 压缩(sub-3)/ 归档(sub-4)功能。
- 不删 free wikiAnchors / renderContextAnchors(sub-1 保留)。

## 验证

见 [./acceptance-5.md](./acceptance-5.md)。
