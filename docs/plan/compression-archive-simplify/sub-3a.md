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
