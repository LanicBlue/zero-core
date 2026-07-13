# acceptance-3:压缩流程(双机制 + 2 区 + ExtractorA 拆除)

> 对应 [./sub-3.md](./sub-3.md)。

## 功能验收

1. **Force 档**:hook 检测 cold / hot+hard 阈值 → AgentLoop 协调跑 memory ephemeral turn(sub-2)→ `compressSession`(滚动摘要)。
2. **Remind 档**:hot+soft 注入 appendMessage 提示;agent 可自写 memory。
3. **滚动摘要**:`compressSession` 用 update(旧摘要 + 被压 steps),非重述;多次压缩信息不丢(可测:压两次,关键事实仍在摘要)。
4. **handoff 前缀**:摘要含"交接说明/背景参考"语义;旧 handoff 过时指令再压缩时剥除。
5. **长度上限**:摘要不无限累积(超预算时压缩到 N 内)。
6. **数据模型 2 区**:LLM view = `[滚动摘要] + [fresh tail]`;无 stubbed 中段、无 FIFO-3(单行滚动摘要)。
7. **fresh-tail 边界**:不劈开 tool_use/result 对;边界逻辑只一份(去重)。
8. **prompt_too_long 不双触发**:只跑一套(不再 hook 压 + inline aggressivePrune 都跑)。
9. **ExtractorA compression 耦合拆除**:`compression-core.ts` 不再调 `mergeSummaryIntoWiki`(grep 零命中)。
10. **压缩 prompt 可配**:从 settings/memory 读;默认=现值;改坏走 fallbackSections。
11. **memory turn step 不落盘**:Force 档跑的 memory turn 不写 steps(回归 sub-2)。

## 不破坏验收

12. 压缩功能测试(触发/摘要/游标前进)过。
13. prompt_too_long 恢复路径过(单机制)。

## build

14. **typecheck 过**。
