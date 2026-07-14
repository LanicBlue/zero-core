# acceptance-3a:数据模型 2区 + 边界 + 去双触发

> 对应 [./sub-3a.md](./sub-3a.md)。

## 功能验收

1. **2区模型**:LLM view = `[滚动摘要] + [fresh tail]`;无 stubbed 中段、无 FIFO-3(单行滚动摘要 + 游标)。
2. **fresh-tail 边界不劈对**:边界处不劈开 tool_use/result 对(tool_use 总与对应 result 在同一区)。
3. **fresh-tail 边界逻辑只一份**:`computeFreshTailStartSeq` 与 session.ts 的边界复制去重(grep 确认单一来源)。
4. **prompt_too_long 不双触发**:只跑一套(不再 hook 压 + inline aggressivePrune 都跑)。

## 不破坏验收

5. 压缩功能测试(触发 / 摘要 / 游标前进)过。

## build

6. **typecheck 过**(`build:lib`)。
