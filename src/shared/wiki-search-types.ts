// Wiki 统一搜索共享契约(wiki-system-redesign plan-04 §5 / design.md §8.5)
//
// # 文件说明书
//
// ## 核心功能
// 跨 WikiSearchService / Wiki v2 tool / REST / UI 共用的搜索请求/结果类型 +
// hybrid 排序契约 + rank/score 共享模块。本文件是 v1 搜索契约的**唯一权威
// 来源**:acceptance-04 §D「hybrid 排序 oracle」与「regex 5 上限」从本文件
// 读取常量,实现必须 import,不允许散落重复魔法数字。
//
// ## 关键不变量(plan-04 §5 / acceptance-04 §A/§D/§H)
//   - 搜索结果 view 严禁携带 DB 内部整数 ID(同 WikiNodeView 纪律)。
//   - 同分顺序**不**依赖 DB 内部 ID —— 仅依赖 `(match_type_rank ASC,
//     -normalized_score ASC, canonical_path ASC, target ASC)` 这条固定 tuple。
//   - 每个模式的搜索必须先把 grants 编译为允许 scopes,**再**查询
//     (acceptance-04 §H「fetch-all-then-filter」拒绝条件)。
//   - regex 5 上限固定,production 只能由 host 收紧,不能放宽。
//
// ## 维护规则
//   - rank/score 函数改动 = oracle 改动 → 必须同步 acceptance-04 fixture。
//   - 新增 mode/target 字段:先改 design + acceptance,再改本文件。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-04-wiki-tool-search.md §5
//   - docs/archive/wiki-system-redesign/design.md §8.5

import type { WikiNodeKind } from "./wiki-types.js";

// ---------------------------------------------------------------------------
// Search mode / target / field — closed v1 sets (plan-04 §5)
// ---------------------------------------------------------------------------

/**
 * v1 搜索模式闭集(design.md §8.5):
 *   - `exact`     —— canonical name/path/字段精确匹配。
 *   - `substring` —— 子串(SQLite LIKE 或 JS includes;ASCII 大小写)。
 *   - `glob`      —— 段基 `*` / `**` / `?`(不直接等同 SQL LIKE)。
 *   - `regex`     —— JS regex,但**永远**在授权后的候选集上由 worker 执行,
 *                    且受 5 上限保护(plan-04 §5)。
 *   - `fulltext`  —— FTS5 MATCH + scope filter + snippet。
 *   - `hybrid`    —— 融合 exact + path + FTS + source,固定排序 tuple。
 *
 * 新增 mode 必须先更新 design.md + acceptance-04 + 本闭集。
 */
export type WikiSearchMode =
	| "exact"
	| "substring"
	| "glob"
	| "regex"
	| "fulltext"
	| "hybrid";

/**
 * v1 搜索目标闭集:
 *   - `wiki`   —— 只搜 wiki_nodes(FTS + 元数据)。
 *   - `source` —— 调用 sub-03 WikiSourceSearch(ripgrep + bindings)。
 *   - `both`   —— 合并 wiki + source 命中,统一 canonical path/address,保留 provenance。
 */
export type WikiSearchTarget = "wiki" | "source" | "both";

/**
 * v1 字段闭集 —— 搜索覆盖哪些字段。FTS 索引固定 name/summary/content;
 * `path` 不进 FTS(由 exact/substring/glob 单独匹配)。
 */
export type WikiSearchField = "name" | "path" | "summary" | "content";

/**
 * 搜索匹配类型标签(用于 hybrid rank + result provenance)。闭集 ——

 *   - `exact`    —— 精确命中(name/path/字段对齐)。
 *   - `path`     —— glob / 路径段匹配。
 *   - `fulltext` —— FTS5 命中。
 *   - `source`   —— 源码搜索命中(target=source/both)。
 *   - `regex`    —— regex worker 命中(wiki content)。
 *   - `substring`—— substring 命中。
 *
 * rank 顺序见 {@link MATCH_TYPE_RANK};新增需同步 oracle。
 */
export type WikiSearchMatchType =
	| "exact"
	| "path"
	| "fulltext"
	| "source"
	| "regex"
	| "substring";

// ---------------------------------------------------------------------------
// Hybrid ranking — fixed oracle (plan-04 §5 / acceptance-04 §D)
// ---------------------------------------------------------------------------

/**
 * Hybrid 排序固定 tuple(plan-04 §5):
 *
 *   `(match_type_rank ASC, -normalized_score ASC, canonical_path ASC, target ASC)`
 *
 * 每个元素的语义:
 *   1. **match_type_rank ASC** —— exact < path < fulltext < source < regex < substring
 *      (越精准越靠前;exact 是最强信号)。rank 值由 {@link MATCH_TYPE_RANK} 闭集提供。
 *   2. **-normalized_score ASC** —— normalized_score DESC(分数越高越靠前)。
 *      normalized_score ∈ [0,1];不同 match_type 有不同的归一化函数
 *      ({@link normalizeScore});**任何**情况下都不得低于 0 或高于 1。
 *   3. **canonical_path ASC** —— 同 rank + 同分时按 canonical path 字典序。
 *   4. **target ASC** —— 同 canonical_path(同节点)时按 target(`source` < `wiki`)
 *      保证稳定。
 *
 * 关键不变量(acceptance-04 §D「同分不依赖内部 ID」):
 *   - tuple 的 4 个字段**都不能**含 DB 内部整数 ID。
 *   - 同输入 + 同 revision → 输出顺序可重复(deterministic)。
 *
 * 排序实现见 {@link compareHybridHits}。Oracle fixture 在 tests 里以
 * 硬编码 expected order 锁定本表。
 */
export const MATCH_TYPE_RANK: Readonly<Record<WikiSearchMatchType, number>> = {
	// ASC: 数字越小越靠前(exact 最强信号 → 0)。
	exact: 0,
	path: 1,
	fulltext: 2,
	source: 3,
	regex: 4,
	substring: 5,
};

/**
 * 把原始分数归一化到 [0,1]。每种 match_type 单独定义归一化函数 —— 接收原始
 * 信号(如 FTS rank、substring 命中率、source 命中数),输出 [0,1] 内的 float。
 *
 * v1 实现:
 *   - `exact`   —— 1.0(精确命中,最高分)。
 *   - `path`    —— 0.9(glob/段匹配次之)。
 *   - `fulltext`—— 来自 FTS5 rank 的 normalized 形式:1 / (1 + bm25_rank)。
 *                  SQLite FTS5 `rank` 列是 BM25 negative(越低越好);这里转成
 *                  「越高越好」的 [0,1]。
 *   - `source`  —— 0.7(默认;后续可按 ripgrep 命中密度细化)。
 *   - `regex`   —— 0.6。
 *   - `substring` —— 0.5(最弱信号;模糊)。
 *
 * **fixture 锁定**:tests 必须用本函数的精确返回值构造 expected order。
 * 修改本函数 = oracle 变更,必须同步 acceptance-04。
 *
 * @param matchType 命中类型
 * @param rawScore 原始分数(可选;对 FTS 是 BM25 negative rank)
 */
export function normalizeScore(
	matchType: WikiSearchMatchType,
	rawScore?: number,
): number {
	switch (matchType) {
		case "exact":
			return 1.0;
		case "path":
			return 0.9;
		case "fulltext": {
			// FTS5 rank = BM25 negative;越小越好。
			// 1 / (1 + |rank|) 把 [0, ∞) 映射到 (0, 1];rank=0 → 1.0(完美匹配)。
			const r = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;
			const absRank = Math.abs(r);
			return 1 / (1 + absRank);
		}
		case "source":
			return 0.7;
		case "regex":
			return 0.6;
		case "substring":
			return 0.5;
		default:
			return 0.0;
	}
}

/**
 * 比较两个 hybrid 排序键,按固定 tuple 返回 -1/0/1。稳定、确定性,不依赖
 * DB 内部 ID(acceptance-04 §D)。
 *
 * 调用方传入两个 hit 的 `{matchType, normalizedScore, canonicalPath, target}`,
 * 本函数返回排序方向。Array.sort(compareHybridHits) 后即得到 oracle 顺序。
 */
export interface HybridSortKey {
	matchType: WikiSearchMatchType;
	normalizedScore: number;
	canonicalPath: string;
	target: WikiSearchTarget;
}

export function compareHybridHits(a: HybridSortKey, b: HybridSortKey): number {
	// 1. match_type_rank ASC
	const rankA = MATCH_TYPE_RANK[a.matchType];
	const rankB = MATCH_TYPE_RANK[b.matchType];
	if (rankA !== rankB) return rankA - rankB;
	// 2. -normalized_score ASC (即 normalized_score DESC)
	if (a.normalizedScore !== b.normalizedScore) {
		// 高分在前 → b - a
		return b.normalizedScore - a.normalizedScore;
	}
	// 3. canonical_path ASC(字典序)
	if (a.canonicalPath < b.canonicalPath) return -1;
	if (a.canonicalPath > b.canonicalPath) return 1;
	// 4. target ASC(source < wiki;字母序)
	if (a.target < b.target) return -1;
	if (a.target > b.target) return 1;
	return 0;
}

// ---------------------------------------------------------------------------
// Regex worker limits — fixed v1 defaults (plan-04 §5 / acceptance-04 §D)
// ---------------------------------------------------------------------------

/**
 * Regex worker v1 默认上限闭集(plan-04 §5 + design.md §8.5)。Production
 * 由 host 通过 `WikiRegexLimits` 注入收紧(**不得**放宽)。
 *
 * acceptance-04 §D「5 个阈值分别有边界测试」从本常量读取。
 */
export const WIKI_REGEX_DEFAULT_LIMITS: Readonly<{
	patternBytes: number;
	authorizedCandidates: number;
	contentBytes: number;
	wallMs: number;
	results: number;
}> = Object.freeze({
	/** regex pattern 最大 UTF-8 字节数。超 → REGEX_LIMIT_EXCEEDED。 */
	patternBytes: 2048,
	/** 授权候选节点数上限。超 → REGEX_LIMIT_EXCEEDED(避免 O(N) regex 爆栈)。 */
	authorizedCandidates: 50_000,
	/** 在 worker 中扫描的正文总字节上限。超 → REGEX_LIMIT_EXCEEDED。 */
	contentBytes: 16 * 1024 * 1024, // 16 MiB
	/** worker wall time 上限(ms)。超 → REGEX_TIMEOUT(terminate worker)。 */
	wallMs: 250,
	/** 返回结果数上限。超 → 截断 + 标 truncated。 */
	results: 200,
});

/**
 * Host 可注入的 regex 限制集(只能收紧,不得放宽)。
 * 缺失字段回退到 {@link WIKI_REGEX_DEFAULT_LIMITS}。
 *
 * acceptance-04 要求测试可通过 DI 缩短 timeout;production 由 host 决定。
 */
export interface WikiRegexLimits {
	patternBytes?: number;
	authorizedCandidates?: number;
	contentBytes?: number;
	wallMs?: number;
	results?: number;
}

/**
 * 把 host 提供的 limits 与默认合并,** clamp 到绝不低于默认值**(production
 * 不能放宽;testing 可以收紧)。
 *
 * 注意:测试场景下 host 传更小的值;production 不传 → 全用默认。
 * 本函数语义:**取 host 与 default 的较小值**(收紧)。
 */
export function resolveRegexLimits(
	host?: WikiRegexLimits,
): typeof WIKI_REGEX_DEFAULT_LIMITS {
	const d = WIKI_REGEX_DEFAULT_LIMITS;
	if (!host) return d;
	const min = (a: number, b: number) => (a < b ? a : b);
	return {
		patternBytes: min(host.patternBytes ?? d.patternBytes, d.patternBytes),
		authorizedCandidates: min(
			host.authorizedCandidates ?? d.authorizedCandidates,
			d.authorizedCandidates,
		),
		contentBytes: min(host.contentBytes ?? d.contentBytes, d.contentBytes),
		wallMs: min(host.wallMs ?? d.wallMs, d.wallMs),
		results: min(host.results ?? d.results, d.results),
	};
}

// ---------------------------------------------------------------------------
// Search request / result views
// ---------------------------------------------------------------------------

/**
 * Wiki 搜索 hit(wiki 子树命中)。不含 DB 内部整数 ID —— canonical path 是
 * Agent 唯一资源 key(同 WikiNodeView 纪律)。
 */
export interface WikiSearchHit {
	/** 节点 canonical path(`wiki-root/...`)。 */
	path: string;
	/** 节点 name(最后一段)。 */
	name: string;
	/** v1 闭合 kind。 */
	kind: WikiNodeKind;
	/** display title(= attributes.display_name ?? name)。 */
	displayTitle: string;
	/** 命中字段(name/path/summary/content)。 */
	matchedField: WikiSearchField;
	/**
	 * 命中类型(hybrid rank 用)。**Primary** —— 该节点 best-rank 命中类型
	 * (按 {@link MATCH_TYPE_RANK} 最优);hybrid 排序 tuple 第 1 元素以此为准。
	 */
	matchType: WikiSearchMatchType;
	/**
	 * 聚合证据(round-6 NODE-SEMANTICS,hybrid 专属):
	 *
	 * hybrid 模式 wikiHits **按 canonical path 去重** —— 一节点一 hit。一个节点
	 * 可能同时被多种 matchType 命中(如 summary 含 token:substring + fulltext;
	 * 或 name 精确对齐:exact + substring + fulltext)。primary {@link matchType}
	 * 只能保留一个值,故在此字段**聚合全部命中类型**作为该节点的证据,供 Agent 在
	 * 单条 hit 上看到该节点被哪些模式命中。
	 *
	 * - 长度 ≥ 2 时,该节点有 ≥2 种 matchType 命中;primary 是其中 best-rank。
	 * - 长度 === 1 或 undefined 时,该节点仅被一种 matchType 命中(等同 primary);
	 *   实现可选择省略 undefined 以减少载荷。
	 *
	 * 顺序未规定(不参与 hybrid 排序 tuple);调用方不应依赖顺序。**去重保证**:
	 * 不含重复 matchType。
	 *
	 * 非 hybrid 模式通常 undefined 或仅含单个值(与 matchType 相同)。
	 */
	matchTypes?: WikiSearchMatchType[];
	/** 归一化分数 [0,1](越高越好;hybrid 排序 tuple 第 2 元素)。 */
	normalizedScore: number;
	/** snippet(命中字段的紧凑切片;已权限过滤)。 */
	snippet: string;
	/** 节点当前 revision(UI staleness 检查)。 */
	revision: number;
	/** target 标签(wiki/source/both 合并时用于 provenance)。 */
	target: WikiSearchTarget;
}

/**
 * Source 搜索 hit(来自 sub-03 WikiSourceSearch;字段镜像 SourceSearchHit
 * 但 strip 内部 id;Agent 只看到 canonical path)。
 */
export interface WikiSourceSearchHit {
	/** Wiki canonical path(从 binding.source_path 反推)。 */
	path: string;
	/** 仓库相对 path。 */
	sourcePath: string;
	/** 1-based 行号。 */
	line: number;
	/** 命中行文本(已 trim)。 */
	text: string;
	/** 列起始(0-based)。 */
	columnStart: number;
	/** 列结束(0-based exclusive)。 */
	columnEnd: number;
	/** 来源:indexed = HEAD git tree;workspace = dirty。 */
	origin: "indexed" | "workspace";
	/** 是否 dirty。 */
	dirty: boolean;
	/** source_kind(从 binding 读)。 */
	sourceKind: string | null;
	/** indexed_revision(从 binding / repository 读)。 */
	indexedRevision: string | null;
	/** 命中字段(source 搜索永远是 `content`)。 */
	matchedField: WikiSearchField;
	/** 命中类型(永远是 `source`)。 */
	matchType: WikiSearchMatchType;
	/** 归一化分数(source 默认 0.7)。 */
	normalizedScore: number;
	/** target 标签(source / both 合并用)。 */
	target: WikiSearchTarget;
}

/**
 * 统一搜索请求(plan-04 §5 / design.md §8.5)。LLM input schema 子集;
 * 实际搜索还需 host 注入的 grants(从 ctx.wikiAccess)。
 *
 * **不含 agentId/projectId/grants/cwd**(acceptance-04 §A 拒绝条件)。
 */
export interface WikiSearchRequest {
	/** 搜索模式(默认 fulltext)。 */
	mode?: WikiSearchMode;
	/** 搜索目标(默认 wiki)。 */
	target?: WikiSearchTarget;
	/** 搜索 pattern(含义随 mode 变; substring=字面量, regex=JS regex, ...)。 */
	query: string;
	/** 字段过滤(默认全字段)。 */
	fields?: WikiSearchField[];
	/** case sensitive(默认 false)。 */
	caseSensitive?: boolean;
	/** kind 过滤(默认不限)。 */
	kinds?: WikiNodeKind[];
	/** canonical scope 或逻辑地址(由调用方先解析为 canonical)。 */
	scope?: string | null;
	/** limit(默认 20;最大 200)。 */
	limit?: number;
	/** 上一页 cursor;首次 null。 */
	cursor?: string | null;
	/** source 模式:indexed (HEAD) 或 workspace(dirty)。 */
	sourceView?: "indexed" | "dirty" | null;
	/** glob 文件过滤(ripgrep `--glob`;target=source/both 时生效)。 */
	fileGlobs?: string[];
}

/**
 * 统一搜索结果。`wikiHits` / `sourceHits` 并列;`both` 合并时按 hybrid tuple
 * 排序后两项都可能非空,但**保留 provenance**(命中来源不丢失)。
 */
export interface WikiSearchResult {
	/** wiki 子树命中(target=wiki/both 时填)。 */
	wikiHits: WikiSearchHit[];
	/** 源码命中(target=source/both 时填)。 */
	sourceHits: WikiSourceSearchHit[];
	/** 下一页 cursor;null = 末尾。 */
	cursor: string | null;
	/** 是否还有更多。 */
	hasMore: boolean;
	/** 实际生效的 regex 限制(供 UI / audit 显示)。 */
	limits: typeof WIKI_REGEX_DEFAULT_LIMITS;
	/** 实际生效的搜索目标。 */
	target: WikiSearchTarget;
	/** 实际生效的 mode。 */
	mode: WikiSearchMode;
	/** 实际生效的 scope(canonical;null = 全授权 scope)。 */
	effectiveScope: string | null;
	/** 是否被结果数上限截断。 */
	truncated: boolean;
}
