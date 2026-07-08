# acceptance-12:expand/search summary 截断标记

对应 `sub-12.md`。

## 用例

1. **代码文件 head 截断有标记**:`summarizeCodeFile` 对 head > 120 字符的源文件,生成的 summary 末尾(head 段)带 `…`;head ≤ 120 不加。
2. **文档文件截断有标记**:`summarizeDocFile` 对 heading/firstPara > 200 字符的文档,summary 末尾带 `…`;≤ 200 不加。
3. **expand 透传标记**:被截断 summary 的节点,expand 子行 / 自身 Summary 末尾显 `…`(渲染层原样输出存储 summary,标记透传)。
4. **search 透传标记**:同上,search 行末尾显 `…`。
5. **不误加**:短 summary(未截断)末尾**无** `…`。
6. **范围限定**:只改 `wiki-skeleton-service.ts`;`wiki-tool.ts` 渲染层、`exportsList.slice(0,6)` 不动(diff 审查确认)。

## 验证手段

- 单测:mock 长源文件(>200 字符 head / >200 字符 doc heading),调 `ensureSummary`(或直接 `summarizeCodeFile`/`summarizeDocFile` 若可测),断言返回 summary 末尾含 `…`。
- 单测:短文件(≤上限)返回 summary **不含** `…`。
- diff 审查:改动仅 `wiki-skeleton-service.ts`。
- typecheck 三层 + vitest(sibling cwd)。
