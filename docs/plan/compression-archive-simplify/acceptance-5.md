# acceptance-5:死代码清理

> 对应 [./sub-5.md](./sub-5.md)。

## 功能验收

1. **ExtractorA 全删**:`extractor-a-service.ts` 文件不存在;grep `ExtractorAService` / `mergeSummaryIntoWiki` / `buildExtractorA` 在 `src/` **零命中**(注释除外)。
2. **extraction-hooks 清**:退役 stub 删除或确认无引用。
3. **compaction/context 死模块删**:`compaction.ts` / `context-manager.ts` 不存在;`src/index.ts` re-export 删;grep `shouldCompact` / `shouldPrune` / `pruneMessages` 零生产命中。
4. **配置面清**:`compaction.*` / `context.*` 配置键 + settings UI 引用删除;config 类型不再含这些键。
5. **steps.compressed 删**:列从 schema 删;`db-migration.ts` 同步(fresh DB 不缺列——验证 fresh DB 启动 OK)。
6. **compression.enabled 删**;`compression.provider/model` 配置项在(sub-3 用)。
7. **ExtractorB 不受影响**:其服务/测试仍过(tool telemetry 数据流独立)。

## 不破坏验收

8. 全套测试过。
9. **typecheck 过 + `build:lib` 过**。
