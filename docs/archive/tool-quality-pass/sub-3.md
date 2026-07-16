# sub-3 Wiki:#2 regex + #3 计数 + #4 path 跳层

> 对应 design:[`./design.md`](./design.md) #2 #3 #4。范围:`src/tools/wiki-tool.ts`(仅此文件)。

## #2 search 正则(显式 flag)

**现状**:[search L557](../../../src/tools/wiki-tool.ts#L557) `q = query.toLowerCase()` + `.includes(q)` 子串匹配。type 过滤已有([L568/574](../../../src/tools/wiki-tool.ts#L568))。

**做法**:
- `wikiActionSchema` 加 `regex: z.boolean().optional().describe("search: treat query as regex (default false = substring)")`。
- search:`regex === true` → `new RegExp(query, "i")`(大小写不敏感,对齐现有 toLowerCase 语义),用 `regex.test(title/summary/path)`;失败(非法 regex)返友好错误 `Invalid regex: ${query}`。`regex` 未设/false → 现状子串(不回归,`.` 字面)。
- description/prompt 补一句 regex flag 说明。

## #3 expand 计数 ▾直接(总子孙)

**现状**:[L518](../../../src/tools/wiki-tool.ts#L518) `childMarker = childCount > 0 ? ▾${childCount} : " leaf"`,childCount 是直接子。

**做法**:
- 改 `▾${direct}(${total})`:direct = 直接子数(现状 byParent.get(id).length);total = 整棵子孙数。
- total 计算:对每个**渲染**节点做一次小 BFS 数子孙。为控开销,用 per-render `Map<nodeId, totalDescendants>`(同次 expand 内 cache,避免重复 BFS);或预算整棵子树一次 totalDescendants(对 root 的 totalDescendants 已有 `totalDescendants` 计算,可复用扩展到每节点)。
- 叶节点(无子)仍显 `leaf`(不带括号)。
- hiddenNote 文案不变。

## #4 expand 加 path 参数(跳层)

**现状**:expand 只接 `nodeId` + `depth`。要到深层节点得逐层 expand。

**做法**:
- schema `path` 字段已存在([L322](../../../src/tools/wiki-tool.ts#L322),现仅 doc op 用);expand 也接受它(describe 更新)。
- expand 分支:若 `input.path` 提供 → 用 title 层级走法(复用/参照 [resolveNode L279](../../../src/tools/wiki-tool.ts#L279) 的逐段 title 匹配)定位目标节点;对该节点做现有 depth expand。
- 末段 `*`:若 path 以 `/*` 结尾,strip `*`,定位到倒数第二段节点,对其做 depth=1 expand(展直接子节点)。非 `*` 结尾 → 定位到末段节点,正常 depth(默认 1)。
- **path 优先于 nodeId**:两者同传 → 用 path,nodeId 忽略(向后兼容纯 nodeId 调用)。
- path 定位失败(某段 title 不匹配)→ 返清晰错误(哪段没匹配)。

## 不在范围

- 不改 create/update/delete/doc* 行为。
- 不改 resolveNode 本身(doc op 共用,改它要确认不回归)。

## 验收见 [`./acceptance-3.md`](./acceptance-3.md)
