# sub-3a:数据模型 3区→2区 + fresh-tail 边界 + 去 prompt_too_long 双触发

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:无(基础,sub-3b/3c 前驱)。原 sub-3 拆分的第一段(数据层)。

## 范围

LLM view 数据模型从 3 区收敛 2 区;fresh-tail 边界逻辑去重 + 按 step 原子切;去 prompt_too_long 双触发。详见 design「二、压缩流程」数据模型 / 边界 / 双触发段。

## 改动

- **3区→2区**:[session.ts](../../../src/runtime/session.ts) `assembleLLMView` 改 `LLM view = [滚动摘要(handoff)] + [fresh tail]`。删 FIFO-3、stubbed 中段、messages 多行 FIFO(改单行滚动摘要 + 游标)。
- **fresh-tail 边界去重**:[compression-core.ts](../../../src/server/compression-core.ts) `computeFreshTailStartSeq` 与 session.ts 的边界逻辑两份复制合并成一份;**按 step 原子切,不劈开 tool_use/result 对**。
- **去 prompt_too_long 双触发**:留 hook 的 `compressSession`,删/改 inline `aggressivePrune`(明确分工,不再两套都跑)。

## 不做(scope 边界)

- 不改 compressSession 的滚动摘要/handoff/cap 逻辑(sub-3b)。
- 不拆 ExtractorA(sub-3b)/ 不动双机制触发(sub-3c)/ 不动归档(sub-4)。

## 验证

见 [./acceptance-3a.md](./acceptance-3a.md)。

## 探查结论(2026-07-13 实施交接)

> 主对话 session 探查 sub-3a 后 context 偏紧,开新 session fresh context 接手。以下省重复探查。

**3区现状**(`session.ts` assembleLLMView L608-663):
- Zone1 [summary]:`db.getSummaries`(≤3 FIFO),system role(`renderSummaryText` L670)。
- Zone2 [middle:tool stub]:postCursor seq < freshTailStart,`appendStepsAsMessages{stubToolResults:true}`(L656);tool result → `STUB_SENTINEL`(L810),tool_use 保留(对完整)。
- Zone3 [fresh tail:verbatim]:seq >= freshTailStart,`appendStepsAsMessages{stubToolResults:false}`(L660)。
- 切分:`compressionCursor`(`db.getCompressionCursor` L617)+ `freshTailStartSeq`(`computeFreshTailBoundary` L704);postCursor = seq > cursor(L644)。
- `computeFreshTailBoundary`(L704-728):`min(32K, ctx*20%)` 预算,newest-first walk,保最新 step;**按 step 原子切**(对不劈,已满足 acceptance #2)。

**2区改法**:
1. **删 Zone2**(`assembleLLMView` L651-661):postCursor 全 verbatim(单次 `append{stubToolResults:false}`)。LLM view = `[summary] + [postCursor]`。依赖压缩 cursor 前进(sub-3b/c)保证 postCursor 在预算内;sub-3a 中间态长 session context 风险(单元测不触发,接受)。
2. `appendStepsAsMessages` 的 `stubToolResults` 参数 / `STUB_SENTINEL` / stub 分支:删 middle 后 grep 确认无别处用 → 删(design「删 stubbed 中段」)。
3. **边界去重**:`session.computeFreshTailBoundary`(L704)↔ `compression-core.computeFreshTailStartSeq`(L228)→ 单源(compression-core 调 session,或共享 helper)。2区 LLM view 不再用 boundary(postCursor 全 verbatim),但**压缩用**(cursor 前进到 freshTailStart,sub-3b/c),保留单源。
4. **去双触发**:删 `agent-loop.ts:1768` `this.session.aggressivePrune(0.5)`(inline prompt_too_long 恢复);留 hook `compressSession`(`compression-trigger-hooks.ts`)。`aggressivePrune` 方法(`session.ts` L518)grep 确认无调用方 → 可删。

**陷阱**:
- 删 middle 破坏性(见上中间态风险;3a/b/c 全完成后消除)。
- `compression-core.computeFreshTailStartSeq`(L228):看它当前怎么被 `compressSession` 用(决定压缩范围)再定去重接法。
- `compressionCursor` 是数字 → 注意 SQLite TEXT 亲和(`feedback-sqlite-text-affinity-numeric`)。
- effort rule 8:implement ≠ verifier 分 agent。
- 验证:`build:lib`(typecheck)+ sub3a 测试 + 现压缩测试回归。

