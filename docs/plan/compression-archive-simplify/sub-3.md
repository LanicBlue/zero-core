# sub-3:压缩流程(双机制 + ExtractorA compression 耦合拆除 + 2 区)

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:**sub-2**(ephemeral turn)、sub-1(冻结快照——cache 受益,非硬依赖)。

## 范围

重构压缩为**双机制** + **滚动摘要 + handoff**;数据模型 **3 区 → 2 区**;拆 compression-core 的 ExtractorA 耦合(由 memory turn 替代);压缩 prompt 可配。详见 design「二、压缩流程」。

## 改动

- **Force 档**(cold / hot+hard):compression-trigger hook 检测到阈值 → **不直接 compress,改 signal AgentLoop**;Loop 协调:跑 memory ephemeral turn(sub-2,`persist:false`)→ `compressSession`。
  - 压缩是结构改动:hook 不能跑嵌套 turn,必须 Loop 协调。
- **Remind 档**(hot+soft):hook 注入 appendMessage 提示("上下文偏大,可写 memory;若认为该压缩就表示")→ agent 自写 memory + 自判压缩。(agent "请求压缩"机制——ack 解析 vs Compress 工具——本 sub 内定。)
- **滚动摘要**:`compressSession` 改 update(旧摘要 + 被压 steps),非从头重述;**handoff 前缀**("交接说明/背景参考,非当前指令");**长度上限**(maxOutputTokens 预算,prompt 指示控制在 N 内防累积膨胀)。
- **数据模型 3 区 → 2 区**:LLM view = `[滚动摘要(handoff)] + [fresh tail]`。删 FIFO-3、stubbed 中段、messages 多行 FIFO(改单行滚动摘要 + 游标)。
- **fresh-tail 边界**:两份复制(`compression-core.ts` + `session.ts`)去重成一份;**按 step 原子切,不劈开 tool_use/result 对**。
- **去 prompt_too_long 双触发**:留 hook 的 `compressSession`,删/改 inline `aggressivePrune`(明确分工,不再两套都跑)。
- **拆 ExtractorA compression 耦合**:删 `compression-core.ts:438` 的 `opts.extractorA.service.mergeSummaryIntoWiki` fire-and-forget(由 Force 档 memory turn 替代)。**不删** `extractor-a-service.ts` 主体(sub-5)。
- **D2 压缩 prompt 可配**:压缩 system prompt 从 settings/memory(`MemorySettings`)读,默认=现 `SUMMARY_SYSTEM`;输出 sections 契约固定(parser 依赖),改坏 `fallbackSections` 兜底。复活死掉的 `compaction.customInstructions` 配置面为真生效(或新键)。

## 不做(scope 边界)

- 不删 `extractor-a-service.ts` 主体(sub-5)。
- 不动归档(sub-4)/ archive 的 ExtractorA 耦合(sub-4)。
- 不动 wiki 注入默认根(sub-1)。

## 验证

见 [./acceptance-3.md](./acceptance-3.md)。
