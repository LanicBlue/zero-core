# sub-12:expand/search summary 截断加 "..." 标记(独立小修)

> 独立 wiki 渲染小修,非 agent-recovery 功能,无功能依赖。用户报告:expand 列表每行末尾 summary 有时被截断但无标记,易误判为完整内容。

## 背景(诊断)

`Wiki` 工具 `expand` / `search` 渲染节点 summary 时,直接输出存储的 `node.summary`(`wiki-tool.ts:344` expand 子行 `childSummary`、`:368` 自身 Summary、`:413` search 行),经 `sanitizeText`(`wiki-anchor-injection.ts:98`)只清 mojibake/空白,**不截断**。

真正的截断在**存储层** `wiki-skeleton-service.ts` 的 `ensureSummary` 懒计算里,**截断无标记**:
- `summarizeCodeFile`([:679](../../../src/server/wiki-skeleton-service.ts#L679)):`Head: ${head.slice(0, 120)}` —— head 截到 120 字符,无标记。
- `summarizeDocFile`([:691](../../../src/server/wiki-skeleton-service.ts#L691)/[:693](../../../src/server/wiki-skeleton-service.ts#L693)):`.slice(0, 200)` —— heading / firstPara 截到 200,无标记。

→ summary 末尾可能停在半句,expand/search 原样输出 → 用户/agent 误以为是完整摘要。

## 任务

在**截断源头**加 "..."(或 `…`)后缀:仅当 `slice` 实际截短时(原长 > 上限)追加标记。
- `summarizeCodeFile` head 段:`head.length > 120` 时 `head.slice(0,120) + "…"`。
- `summarizeDocFile` heading/firstPara:`length > 200` 时 `slice(0,200) + "…"`。
- 修在源头(expand + search 共用 `node.summary`,一处修两处受益),**不改 `wiki-tool.ts` 渲染层**(渲染层无法区分"截断存储"与"天然等长")。

## 范围

- 只改 `wiki-skeleton-service.ts` 两处截断。
- `exportsList.slice(0,6)`(代码文件导出列表)非末尾摘要,本次**不动**(已在 Exports: ... 句中,截断语义不同)。

## 风险 / 取舍

- **旧数据**:已缓存(materialized)的 summary 行无标记,`ensureSummary` 只在 summary 空/含 mojibake 时重算 → 旧行不会自动补标记,直到源文件变 / summary 被清。**接受**(新摘要有标记;旧行自愈需触发重算,不在本次)。计划里标注,不掩盖。
- 标记字符用 `…`(U+2026,1 字符)省 token;或 `...`(3 字符)更直白。**选 `…`**(紧凑,与既有 `…(N more)` 风格一致,见 search `:411`)。

## 验收

见 `acceptance-12.md`。
