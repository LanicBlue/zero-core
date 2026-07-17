// WikiSearchService — 统一 Wiki + source 搜索(wiki-system-redesign plan-04 §5)
//
// # 文件说明书
//
// ## 核心功能
// Wiki 数据面的统一搜索入口。给 Wiki v2 工具 / REST / UI 提供:
//
//   - 6 mode:exact / substring / glob / regex / fulltext / hybrid
//   - 3 target:wiki / source / both
//   - field / case / kind / scope / limit / cursor 过滤
//   - source 模式调用 sub-03 WikiSourceSearch(ripgrep;cwd-by-binding)
//   - both 合并保留 provenance + 用 hybrid 排序 tuple
//
// ## 关键不变量(plan-04 §5 / acceptance-04 §D/§H)
//   - **grants 编译先于查询**:所有 mode 先把 `search` action grants 编译为
//     canonical scopes,再在 scopes 内查询。**绝不**fetch-all-then-filter。
//   - **regex 不在主线程无界运行**:永远走 `node:worker_threads`,受 5 上限保护
//     (pattern / candidates / content / wall time / results)。
//   - **同分不依赖 DB 内部 ID**:hybrid 排序 tuple (match_type_rank ASC,
//     -normalized_score ASC, canonical_path ASC, target ASC) 来自共享契约,
//     不含整数 ID。
//   - **不泄露未授权信息**:secret path / snippet / count 不可被推断。
//   - **不读 AgentStore / 不读 input agentId/projectId/cwd**:ctx.access 是
//     唯一身份来源。
//
// ## 不做
//   - 不实现 embedding / semantic search(v1 不做)。
//   - 不在 SQLite 主线程跑全库 JS regex。
//   - 不暴露 ripgrep 原始 stdout(经 SourceSearchHit 映射回 canonical path)。
//   - 不接受任意 cwd(source 搜索永远走 binding + workspaceDir)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-04-wiki-tool-search.md §5
//   - docs/plan/wiki-system-redesign/design.md §8.5
//   - src/shared/wiki-search-types.ts (oracle 契约)
//   - src/server/wiki/wiki-source-search.ts (sub-03 ripgrep wrapper)

import type Database from "better-sqlite3";
import { WikiAuthorizationService } from "./wiki-authorization-service.js";
import { WikiAddressService } from "./wiki-address-service.js";
import type { WikiNodeRepository, WikiNodeRow } from "./wiki-node-repository.js";
import { wikiError } from "./wiki-errors.js";
import { isSameOrDescendant } from "./wiki-path.js";
import type {
	CompiledWikiAccess,
	WikiNodeKind,
	WikiRequestContext,
} from "../../shared/wiki-types.js";
import type { WikiRepositoryStore } from "./wiki-repository-store.js";
import type {
	SourceSearchHit,
	SourceSearchRequest,
	WikiSourceSearch,
} from "./wiki-source-search.js";
import {
	WIKI_REGEX_DEFAULT_LIMITS,
	compareHybridHits,
	normalizeScore,
	resolveRegexLimits,
	type WikiRegexLimits,
	type WikiSearchField,
	type WikiSearchHit,
	type WikiSearchMatchType,
	type WikiSearchMode,
	type WikiSearchRequest,
	type WikiSearchResult,
	type WikiSearchTarget,
	type WikiSourceSearchHit,
} from "../../shared/wiki-search-types.js";
import { log } from "../../core/logger.js";

// ---------------------------------------------------------------------------
// Regex worker bootstrap — inline source + lazy singleton pool.
// ---------------------------------------------------------------------------

/**
 * Inline worker source. Runs the regex match loop with wall-clock + content
 * budget caps; communicates results or a closed-set error code back to main.
 *
 * Worker payload: pattern, flags, candidates (already filtered to authorized
 * scopes by the main thread), and the resolved limits. Worker never touches
 * the database or the filesystem.
 *
 * **Wall-clock self-check**: the worker inspects `Date.now() - start` after
 * each candidate and posts a REGEX_TIMEOUT message back to main if exceeded.
 * Main thread also runs a setTimeout safety net (limits.wallMs + slack) to
 * reject pending requests if the worker is unresponsive.
 */
const REGEX_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (req) => {
  const { pattern, flags, candidates, limits, id } = req;
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, code: "REGEX_INVALID", message: "invalid regex: " + (err && err.message) });
    return;
  }
  if (candidates.length > limits.authorizedCandidates) {
    parentPort.postMessage({ id, ok: false, code: "REGEX_LIMIT_EXCEEDED", message: "candidates " + candidates.length + " > " + limits.authorizedCandidates });
    return;
  }
  let totalBytes = 0;
  // rawMatchCount counts ALL matches discovered (not just the ones shipped back).
  // round-3 B1+C2 fix: previously the worker break-ed out of the loop as soon
  // as hits.length >= limits.results (200), so the service could never learn
  // whether more than 200 matches existed -- WikiSearchResult.truncated was
  // structurally always false. Now the worker keeps iterating candidates
  // (still bounded by authorizedCandidates / contentBytes / wallMs) and reports
  // the raw match total so the service can compute truncated correctly.
  let rawMatchCount = 0;
  const hits = [];
  const start = Date.now();
  try {
    for (const c of candidates) {
      if (Date.now() - start > limits.wallMs) {
        parentPort.postMessage({ id, ok: false, code: "REGEX_TIMEOUT", message: "wall time > " + limits.wallMs + "ms" });
        return;
      }
      const text = c.content || "";
      totalBytes += Buffer.byteLength(text, "utf-8");
      if (totalBytes > limits.contentBytes) {
        parentPort.postMessage({ id, ok: false, code: "REGEX_LIMIT_EXCEEDED", message: "content bytes > " + limits.contentBytes });
        return;
      }
      const m = regex.exec(text);
      if (m) {
        rawMatchCount++;
        if (hits.length < limits.results) {
          const idx = m.index;
          const startSnip = Math.max(0, idx - 200);
          const endSnip = Math.min(text.length, idx + m[0].length + 200);
          const snippet = text.slice(startSnip, endSnip);
          hits.push({
            path: c.path,
            name: c.name,
            kind: c.kind,
            displayTitle: c.displayTitle,
            summary: c.summary,
            revision: c.revision,
            snippet,
            columnStart: idx,
            columnEnd: idx + m[0].length,
          });
        }
      }
    }
    parentPort.postMessage({ id, ok: true, hits, scanned: candidates.length, rawMatchCount });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, code: "REGEX_INVALID", message: "regex exec failed: " + (err && err.message) });
  }
});
`;

/**
 * Singleton regex worker pool. Worker starts lazily on first regex request;
 * subsequent requests reuse the same worker via postMessage (id correlation).
 *
 * **Timeout semantics (round-2 FIX 5 / plan-04 §5: "worker timeout → terminate,
 * subsequent runs immediately")**: when wallMs is exceeded, the parent-side
 * setTimeout fires and **terminates** the worker via `worker.terminate()`.
 *
 * 为什么必须 terminate:worker 的 wallMs self-check 只在 **candidate 之间**
 * 跑,不在单次 `regex.exec` 内。catastrophic regex(如 `(a+)+b` vs 30k chars)
 * 会让一次 `regex.exec` 阻塞 worker 线程数秒;self-check 永远跑不到。唯一的
 * 抢占手段是 `terminate()`(Node 唯一能从外部打断 worker 同步执行的原语)。
 *
 * terminate 后 `this.worker = null` + `this.initPromise = null`,下一次
 * `ensureWorker()` 会 spawn 一个 fresh worker(~5-10ms restart overhead,可接受)。
 * 同时把所有 pending entries 都 reject 为 REGEX_TIMEOUT —— 因为 worker 一死,
 * 它们都没有机会收到响应了(不能让它们等自己的 setTimeout 才超时)。
 */
class RegexWorkerPool {
	private worker: import("node:worker_threads").Worker | null = null;
	private initPromise: Promise<import("node:worker_threads").Worker | null> | null = null;
	private nextId = 1;
	private pending: Map<number, {
		resolve: (msg: unknown) => void;
		timer: NodeJS.Timeout;
	}> = new Map();
	private workerThreads: typeof import("node:worker_threads") | null = null;
	private workerAvailable: boolean | null = null;

	private async loadModule(): Promise<typeof import("node:worker_threads") | null> {
		if (this.workerAvailable === false) return null;
		if (!this.workerThreads) {
			try {
				this.workerThreads = await import("node:worker_threads");
				this.workerAvailable = true;
			} catch (err) {
				log.warn("wiki-search", "worker_threads unavailable; regex mode disabled", (err as Error).message);
				this.workerAvailable = false;
				return null;
			}
		}
		return this.workerThreads;
	}

	private async ensureWorker(): Promise<import("node:worker_threads").Worker | null> {
		if (this.worker) return this.worker;
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
			const wt = await this.loadModule();
			if (!wt) return null;
			const worker = new wt.Worker(REGEX_WORKER_SOURCE, { eval: true });
			worker.on("message", (msg: { id: number; ok: boolean }) => {
				const slot = this.pending.get(msg.id);
				if (!slot) return;
				clearTimeout(slot.timer);
				this.pending.delete(msg.id);
				slot.resolve(msg);
			});
			worker.on("error", (err: Error) => {
				// Reject all pending; worker is dead, force restart on next call.
				for (const [id, slot] of this.pending) {
					clearTimeout(slot.timer);
					this.pending.delete(id);
					slot.resolve({ id, ok: false, code: "REGEX_INVALID", message: `worker error: ${err.message}` });
				}
				this.worker = null;
				this.initPromise = null;
			});
			this.worker = worker;
			return worker;
		})();
		try {
			return await this.initPromise;
		} finally {
			this.initPromise = null;
		}
	}

	/**
	 * Run a regex search on the candidate set.
	 * Returns hits on success or a closed-set error code on failure.
	 */
	async run(
		pattern: string,
		flags: string,
		candidates: Array<{
			path: string;
			name: string;
			kind: string;
			displayTitle: string;
			summary: string;
			content: string;
			revision: number;
		}>,
		limits: typeof WIKI_REGEX_DEFAULT_LIMITS,
	): Promise<
		| {
			ok: true;
			hits: Array<{
				path: string;
				name: string;
				kind: string;
				displayTitle: string;
				summary: string;
				revision: number;
				snippet: string;
				columnStart: number;
				columnEnd: number;
			}>;
			scanned: number;
			/** Total matches discovered across all candidates (pre-results-cap). round-3 B1+C2. */
			rawMatchCount: number;
		}
		| {
			ok: false;
			code: "REGEX_INVALID" | "REGEX_LIMIT_EXCEEDED" | "REGEX_TIMEOUT";
			message: string;
		}
	> {
		const worker = await this.ensureWorker();
		if (!worker) {
			return {
				ok: false,
				code: "REGEX_INVALID",
				message: "worker_threads unavailable in this environment",
			};
		}
		const id = this.nextId++;
		return await new Promise((resolve) => {
			const timer = setTimeout(() => {
				// round-2 FIX 5: terminate the runaway worker. Catastrophic regex
				// (e.g. `(a+)+b` vs 30k chars) blocks a single regex.exec for
				// seconds; wallMs self-check runs BETWEEN candidates, not during
				// exec, so the worker cannot self-cancel. `terminate()` is the
				// only way to preempt.
				this.pending.delete(id);
				// Null out FIRST so concurrent ensureWorker() spawns a fresh
				// worker instead of postMessage-ing the dying one.
				if (this.worker === worker) {
					this.worker = null;
					this.initPromise = null;
				}
				// Reject all OTHER pending entries — worker is dying, their
				// postMessage'd requests will never get responses.
				for (const [otherId, slot] of this.pending) {
					clearTimeout(slot.timer);
					this.pending.delete(otherId);
					slot.resolve({
						id: otherId,
						ok: false,
						code: "REGEX_TIMEOUT",
						message: `parent timeout (worker terminated) after ${limits.wallMs}ms`,
					});
				}
				// Terminate asynchronously; ignore rejection (already dead).
				worker.terminate().catch(() => { /* already terminated */ });
				resolve({
					ok: false,
					code: "REGEX_TIMEOUT",
					message: `parent timeout after ${limits.wallMs}ms`,
				});
			}, limits.wallMs + 50); // small slack for worker self-check
			this.pending.set(id, {
				resolve: (msg) => resolve(msg as any),
				timer,
			});
			worker.postMessage({ id, pattern, flags, candidates, limits });
		});
	}
}

/** Process-wide singleton. WikiSearchService instances share it. */
const REGEX_POOL = new RegexWorkerPool();

/**
 * Internal mode outcome (round-3 B1+C2 fix).
 *
 * Each wiki search mode returns BOTH the post-slice hits (≤ 200, the public
 * contract) AND the **pre-slice raw match count**. The service `search()`
 * computes `truncated = rawCount > limits.results` from this. Without
 * `rawCount`, every mode would silently cap to 200 inside itself and the
 * `truncated` flag would always be false (the round-2 bug).
 *
 * `rawCount` is **internal-only** — it does NOT appear on the public
 * {@link WikiSearchResult} contract (which only exposes `truncated: boolean`).
 *
 * Semantics per mode:
 *   - exact / substring / glob — total rows that satisfied the SQL+JS filters
 *     across all allowedScopes (multi-scope aggregate, dedup not needed since
 *     rows are scoped to non-overlapping subtrees).
 *   - fulltext — sum of `COUNT(*)` per scope (FTS may match the same row text
 *     in overlapping scopes; scopes are non-overlapping in practice so sum
 *     is the right aggregate).
 *   - regex — `rawMatchCount` returned by the worker (counts every candidate
 *     node with at least one regex match — increment once per candidate where
 *     `regex.exec(text)` is truthy; one node contributes at most 1).
 *   - hybrid — `Math.max(dedup.size, max(component rawCounts))` where
 *     dedup.size is the **path-keyed distinct matched node count** across the
 *     merged (pre-final-slice) survivors. **Node semantics** (round-6
 *     contract): `truncated=true` iff distinct matched nodes > cap — same
 *     node hit by multiple matchTypes counts as 1 node, so Agent pagination
 *     always yields NEW nodes rather than redundant matchType views.
 *     The component max backstops single-component internal overflow (one
 *     component pre-slice total >200 while its hits are sliced to 200
 *     internally, which dedup alone — seeing only survivors — would miss).
 *     union (max) — not sum — because cross-component overlap would
 *     over-count duplicates; both bounds are ≤ true distinct-node count, and
 *     either >200 ⟺ true distinct-node count >200 (no false-positive or
 *     false-negative). wikiHits are likewise path-deduped — one hit per node,
 *     with the best-rank matchType as primary and all matchTypes aggregated
 *     onto the `matchTypes` evidence field.
 */
interface WikiModeOutcome {
	hits: WikiSearchHit[];
	rawCount: number;
}

// ---------------------------------------------------------------------------
// WikiSearchService — public API
// ---------------------------------------------------------------------------

/**
 * WikiSearchService 依赖。
 *
 * `sourceSearch` 可选(target=source/both 时必须;缺失则 source 路径返空)。
 * `regexLimits` 可选(只能收紧;production 用默认,测试用更小 wallMs)。
 */
export interface WikiSearchServiceDeps {
	/** 直读 better-sqlite3 句柄(FTS5 / scope-prefixed LIKE 需要原生 SQL)。 */
	readonly db: Database.Database;
	readonly nodeRepo: WikiNodeRepository;
	readonly repositoryStore: WikiRepositoryStore;
	readonly addressService: WikiAddressService;
	readonly authorizationService: WikiAuthorizationService;
	/** sub-03 source 搜索(target=source/both 时必须)。 */
	readonly sourceSearch?: WikiSourceSearch;
	/** Host 注入的 regex 限制(只能收紧)。 */
	readonly regexLimits?: WikiRegexLimits;
}

/**
 * WikiSearchService —— 统一 Wiki + source 搜索。
 *
 * **不持有 Agent 身份**:每次 search 调用从 `ctx: WikiRequestContext` 取
 * `access` + `agentId` + `activeProjectId`。ctx 是 host 注入,绝不被
 * LLM input 覆盖(acceptance-04 §H)。
 */
export class WikiSearchService {
	private readonly deps: WikiSearchServiceDeps;

	constructor(deps: WikiSearchServiceDeps) {
		this.deps = deps;
	}

	/**
	 * 统一搜索入口。
	 */
	async search(
		req: WikiSearchRequest,
		ctx: WikiRequestContext,
	): Promise<WikiSearchResult> {
		// ── 1. 编译 grants → canonical search scopes(acceptance-04 §H)。 ──
		// 先于任何节点查询 / FTS / source 调用。
		const allowedScopes = this.deps.authorizationService.prepareSearchScopes(
			ctx.access,
			req.scope ?? null,
		);
		const mode: WikiSearchMode = req.mode ?? "fulltext";
		const target: WikiSearchTarget = req.target ?? "wiki";
		const limits = resolveRegexLimits(this.deps.regexLimits);

		if (allowedScopes.length === 0) {
			// 无 search grant:返回空(不报 ACCESS_DENIED 以免泄露"存在但不可见";
			// 与 NOT_FOUND 同外观 —— acceptance-02 §C / plan-04 §E)。
			return this.emptyResult(req, mode, target);
		}

		// ── 2. regex pattern up-front validation(pattern bytes + syntax)。 ──
		if (mode === "regex") {
			const patternBytes = Buffer.byteLength(req.query, "utf-8");
			if (patternBytes > limits.patternBytes) {
				throw wikiError(
					"REGEX_LIMIT_EXCEEDED",
					`regex pattern too long: ${patternBytes} > ${limits.patternBytes} bytes`,
				);
			}
			try {
				// Compile to validate syntax; do NOT execute here.
				new RegExp(req.query, this.regexFlags(req.caseSensitive ?? false));
			} catch (err) {
				throw wikiError(
					"REGEX_INVALID",
					`invalid regex: ${(err as Error).message}`,
				);
			}
		}

		// ── 3. 按 target 分发。 ──
		const wikiHits: WikiSearchHit[] = [];
		const sourceHits: WikiSourceSearchHit[] = [];
		// round-3 B1+C2: rawCount is the wiki-side pre-slice match total. Used
		// for the `truncated` flag — `all.length` was always ≤ 200 because every
		// mode sliced internally before returning, so the previous check
		// (`all.length > limits.results`) was structurally false.
		let wikiRawCount = 0;

		if (target === "wiki" || target === "both") {
			const r = await this.searchWiki(req, mode, allowedScopes, ctx, limits);
			wikiHits.push(...r.hits);
			wikiRawCount = r.rawCount;
		}
		if (target === "source" || target === "both") {
			const r = await this.searchSource(req, mode, allowedScopes, ctx);
			sourceHits.push(...r);
		}

		// ── 4. 合并 + cursor + limit 截断。 ──
		const limit = this.clampLimit(req.limit ?? 20);
		const all = this.mergeForPagination(wikiHits, sourceHits, target);
		const cursorIdx = this.decodeCursor(req.cursor ?? null);
		const startIdx = cursorIdx;
		const endIdx = Math.min(startIdx + limit, all.length);
		const slice = all.slice(startIdx, endIdx);
		const hasMore = endIdx < all.length;
		const nextCursor = hasMore ? this.encodeCursor(endIdx) : null;
		// round-3 B1+C2: truncated reflects the wiki-side raw match total
		// (independent of pagination limit; target=source → always false since
		// source owns its own pagination via sub-03). For target=both, only the
		// wiki portion contributes — source has its own limits/cursor.
		const truncated = wikiRawCount > limits.results;

		const slicedWiki = slice.filter(
			(h): h is WikiSearchHit => h.target !== "source",
		);
		const slicedSource = slice.filter(
			(h): h is WikiSourceSearchHit => h.target === "source",
		);

		return {
			wikiHits: slicedWiki,
			sourceHits: slicedSource,
			cursor: nextCursor,
			hasMore,
			limits,
			target,
			mode,
			effectiveScope: req.scope ?? null,
			truncated,
		};
	}

	// =========================================================================
	// Wiki search — 6 modes
	// =========================================================================

	private async searchWiki(
		req: WikiSearchRequest,
		mode: WikiSearchMode,
		allowedScopes: string[],
		_ctx: WikiRequestContext,
		limits: typeof WIKI_REGEX_DEFAULT_LIMITS,
	): Promise<WikiModeOutcome> {
		switch (mode) {
			case "exact":
				return this.searchExact(req, allowedScopes);
			case "substring":
				return this.searchSubstring(req, allowedScopes);
			case "glob":
				return this.searchGlob(req, allowedScopes);
			case "fulltext":
				return this.searchFulltext(req, allowedScopes);
			case "regex":
				return this.searchRegex(req, allowedScopes, limits);
			case "hybrid":
				return this.searchHybrid(req, allowedScopes, limits);
		}
	}

	/**
	 * exact:canonical name/path/字段精确匹配。
	 *
	 * 实现:SQL `name = ? OR path = ? OR summary = ?` 在 scope 范围内查。
	 * case sensitivity:默认 SQLite `=` 区分大小写(精确匹配);
	 * case_sensitive=false → `COLLATE NOCASE`(ASCII-only,诚实限制)。
	 *
	 * **round-2 FIX 3**:COLLATE 必须在 bound param `?` **之后**,而不是夹在
	 * `=` 和 `?` 之间(`name = COLLATE NOCASE ?` 是非法 SQL —— SQLite 把
	 * COLLATE 视为后缀运算符,不接受 infix 形式)。正确形式:`name = ? COLLATE NOCASE`。
	 */
	private async searchExact(
		req: WikiSearchRequest,
		allowedScopes: string[],
	): Promise<WikiModeOutcome> {
		const caseCollation = req.caseSensitive ? "" : "COLLATE NOCASE";
		const predicate = `(name = ? ${caseCollation} OR path = ? ${caseCollation} OR summary = ? ${caseCollation})`;
		const rows = this.queryNodesInScopes(allowedScopes, () => predicate, [
			req.query, req.query, req.query,
		], req.kinds);
		// round-3 B1+C2: rawCount = rows.length BEFORE slice; truncated flag
		// is computed off this in search().
		const hits = rows.slice(0, 200).map((r) => this.rowToExactHit(r, req));
		return { hits, rawCount: rows.length };
	}

	/**
	 * substring:子串匹配。SQL `LIKE` + ESCAPE。
	 *
	 * **ASCII-only case folding 限制**(plan-04 §5「不能因 SQLite NOCASE 只
	 * 覆盖 ASCII 而声称完整 Unicode」):默认 LIKE case-insensitive 只对 ASCII
	 * 有效。中文不受影响;带音标拉丁/Cyrillic/希腊等需要后续接 ICU tokenizer。
	 *
	 * **round-2 FIX 4**:round-1 实现 `LIKE ? BINARY ESCAPE` 是非法 SQL
	 * (SQLite LIKE 不接受 bare `BINARY` token)。但经验证 SQLite 的
	 * `LIKE ? COLLATE BINARY` **也不会**切换 LIKE 的大小写语义(只有
	 * `PRAGMA case_sensitive_like=ON` 真正生效,而该 PRAGMA 是连接级全局状态,
	 * 在共享连接上切换有竞态风险)。**可靠路径**:SQL 用默认 NOCASE LIKE
	 * 取一个超集,caseSensitive=true 时在 JS 层做精确大小写 post-filter。
	 * 保留 SQL 里的 `COLLATE BINARY` 作为意图 hint(对未来 SQLite 版本或
	 * ICU collation 切换友好),但行为真相在 JS post-filter。
	 */
	private async searchSubstring(
		req: WikiSearchRequest,
		allowedScopes: string[],
	): Promise<WikiModeOutcome> {
		const pattern = `%${this.escapeLike(req.query)}%`;
		const escape = "ESCAPE '\\'";
		const cmp = req.caseSensitive
			? `LIKE ? COLLATE BINARY ${escape}`
			: `LIKE ? ${escape}`;
		const predicate = `(name ${cmp} OR summary ${cmp} OR content ${cmp})`;
		let rows = this.queryNodesInScopes(allowedScopes, () => predicate, [
			pattern, pattern, pattern,
		], req.kinds);
		// caseSensitive=true: SQLite LIKE 忽略 COLLATE BINARY(见上方注释),
		// 必须在 JS 层做精确大小写 post-filter 才能保证 `Needle` ≠ `needle`。
		if (req.caseSensitive) {
			const q = req.query;
			rows = rows.filter((r) =>
				this.caseSensitiveSubstringMatch(r, q, req.fields),
			);
		}
		const hits = rows.slice(0, 200).map((r) =>
			this.rowToSubstringHit(r, req, this.detectSubstringField(r, req)),
		);
		return { hits, rawCount: rows.length };
	}

	/**
	 * caseSensitive substring 匹配 helper(round-2 FIX 4):检查 row 的指定
	 * 字段(或默认 name/summary/content)中是否有任何一个**case-sensitively**
	 * 包含 query。`String.prototype.includes` 是字节级比较(对 BMP 字符等同
	 * 大小写敏感),满足 ASCII case-sensitive 需求。
	 */
	private caseSensitiveSubstringMatch(
		row: WikiNodeRow,
		query: string,
		fields: WikiSearchField[] | undefined,
	): boolean {
		const list: WikiSearchField[] = fields && fields.length > 0
			? fields
			: ["name", "summary", "content"];
		return list.some((f) => fieldText(row, f).includes(query));
	}

	/**
	 * glob:段基 `*`(不跨段)/ `**`(跨段)/ `?`(单字符)。
	 *
	 * 两阶段:
	 *   1. SQL LIKE 粗筛(path/name)。
	 *   2. JS segment-aware glob 精确校验(过滤 LIKE 的跨段误报 + 大小写)。
	 *
	 * **round-2 FIX 4**:caseSensitive=true 时 SQL 仍用 `LIKE ? COLLATE BINARY ESCAPE`
	 * (round-1 `LIKE ? BINARY ESCAPE` 是非法语法)。注意 SQLite LIKE 实际**不**会
	 * 因为 `COLLATE BINARY` 切换大小写(见 searchSubstring 注释);真实的大小写
	 * 区分由 `compileGlobMatcher(req.query, caseSensitive)` 在 JS 层 enforce。
	 */
	private async searchGlob(
		req: WikiSearchRequest,
		allowedScopes: string[],
	): Promise<WikiModeOutcome> {
		const sqlPattern = this.globToSqlLike(req.query);
		const escape = "ESCAPE '\\'";
		const cmp = req.caseSensitive
			? `LIKE ? COLLATE BINARY ${escape}`
			: `LIKE ? ${escape}`;
		const predicate = `(path ${cmp} OR name ${cmp})`;
		const rows = this.queryNodesInScopes(allowedScopes, () => predicate, [
			sqlPattern, sqlPattern,
		], req.kinds);
		const matcher = compileGlobMatcher(req.query, req.caseSensitive ?? false);
		const verified = rows.filter((r) => matcher(r.path) || matcher(r.name));
		const hits = verified.slice(0, 200).map((r) =>
			this.rowToGlobHit(r, req, matcher(r.path) ? "path" : "name"),
		);
		return { hits, rawCount: verified.length };
	}

	/**
	 * fulltext:FTS5 MATCH + scope filter + snippet。
	 *
	 * 实现:join wiki_nodes_fts + wiki_nodes,在 WHERE 子句加段基 scope 过滤
	 * `(n.path = ? OR n.path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')`
	 * (round-2 FIX 2 —— 不再用字典序 `>= ? AND <= ?`,避免 `-`/`.`/`~` 等
	 * 字符在校验 `/` 之前导致 sibling 路径泄露)。
	 */
	private async searchFulltext(
		req: WikiSearchRequest,
		allowedScopes: string[],
	): Promise<WikiModeOutcome> {
		const ftsQuery = this.buildFtsQuery(req.query);
		const limit = 200;
		const allRows: Array<{ row: WikiNodeRow & { fts_rank: number }; rank: number }> = [];
		// round-3 B1+C2: rawCount must reflect the total FTS match count across
		// all allowedScopes, not just the rows that survived the per-scope
		// `LIMIT 200` fetch. Run a parallel COUNT(*) per scope (cheap aggregate,
		// no row materialization) and sum.
		let rawCount = 0;
		const { clause: kindsClause, params: kindsParams } = this.kindsClauseAndParams(req.kinds);
		for (const scope of allowedScopes) {
			const escapedScope = this.escapeLike(scope);
			const sql = `SELECT n.*, f.rank AS fts_rank
					FROM wiki_nodes_fts f
					JOIN wiki_nodes n ON n.id = f.rowid
					WHERE wiki_nodes_fts MATCH ?
					  AND n.archived_at IS NULL
					  AND (n.path = ? OR n.path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')${kindsClause}
					ORDER BY f.rank
					LIMIT ?`;
			const result = this.deps.db.prepare(sql).all(
				ftsQuery, scope, escapedScope, ...kindsParams, limit,
			) as Array<WikiNodeRow & { fts_rank: number }>;
			// round-3 B1+C2: parallel COUNT(*) for rawCount (cheap aggregate).
			const countSql = `SELECT COUNT(*) AS c
					FROM wiki_nodes_fts f
					JOIN wiki_nodes n ON n.id = f.rowid
					WHERE wiki_nodes_fts MATCH ?
					  AND n.archived_at IS NULL
					  AND (n.path = ? OR n.path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')${kindsClause}`;
			const countRow = this.deps.db.prepare(countSql).get(
				ftsQuery, scope, escapedScope, ...kindsParams,
			) as { c: number } | undefined;
			if (countRow && typeof countRow.c === "number") {
				rawCount += countRow.c;
			}
			for (const r of result) {
				// JS defense-in-depth(SQLite LIKE 实际仍 NOCASE):段基 + 大小写敏感。
				if (isSameOrDescendant(scope, r.path)) {
					allRows.push({ row: r, rank: r.fts_rank });
				}
			}
		}
		const hits = allRows.slice(0, 200).map(({ row, rank }) => {
			const snippet = this.buildSnippet(row, req.query);
			return this.rowToFulltextHit(row, req, snippet, rank);
		});
		return { hits, rawCount };
	}

	/**
	 * regex:Wiki 正文 regex 搜索 —— **worker_threads** + 5 上限。
	 *
	 * 流程:
	 *   1. 从 allowedScopes 拉候选节点(scope + archived 过滤)。
	 *   2. 候选数 ≤ limits.authorizedCandidates;超 → REGEX_LIMIT_EXCEEDED。
	 *   3. 把候选序列化给 worker;worker 在 pattern + flags 上跑 RegExp。
	 *   4. worker 自检 wallMs / contentBytes / results;主线程额外 setTimeout 兜底。
	 *   5. 返回命中(已包含 snippet + 列范围)。
	 *
	 * **永不**在主线程跑无界 regex(acceptance-04 §H 拒绝条件)。
	 */
	private async searchRegex(
		req: WikiSearchRequest,
		allowedScopes: string[],
		limits: typeof WIKI_REGEX_DEFAULT_LIMITS,
	): Promise<WikiModeOutcome> {
		// 1. 拉 candidates。每个候选只携带必要字段(不传 id)。
		// **round-2 FIX 2**:段基 scope 过滤,不再用字典序 `>= ? AND <= ?`
		// (避免 sibling `wiki-root/a/alpha-secret` 被错误纳入 scope
		// `wiki-root/a/alpha0` —— `-`(0x2D)排在校验 `/`(0x2F)之前)。
		// round-3 C1: kinds 过滤下沉到 SQL 谓词,候选集只包含请求的 kinds。
		const { clause: kindsClause, params: kindsParams } = this.kindsClauseAndParams(req.kinds);
		const candidates: Array<{
			path: string;
			name: string;
			kind: string;
			displayTitle: string;
			summary: string;
			content: string;
			revision: number;
		}> = [];
		for (const scope of allowedScopes) {
			const escapedScope = this.escapeLike(scope);
			const rows = this.deps.db
				.prepare(
					`SELECT * FROM wiki_nodes
					 WHERE archived_at IS NULL
					   AND (path = ? OR path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')${kindsClause}
					 ORDER BY path ASC`,
				)
				.all(scope, escapedScope, ...kindsParams) as WikiNodeRow[];
			for (const r of rows) {
				// JS defense-in-depth(SQLite LIKE 实际仍 NOCASE):段基 + 大小写敏感。
				if (!isSameOrDescendant(scope, r.path)) continue;
				candidates.push({
					path: r.path,
					name: r.name,
					kind: r.kind,
					displayTitle: this.displayTitleOf(r),
					summary: r.summary,
					content: r.content,
					revision: r.revision,
				});
			}
		}
		// 2. 候选数检查(worker 也会查;主线程提前 fail-fast 节省 worker 调度)。
		if (candidates.length > limits.authorizedCandidates) {
			throw wikiError(
				"REGEX_LIMIT_EXCEEDED",
				`authorized candidates ${candidates.length} > ${limits.authorizedCandidates}`,
			);
		}
		// 3. 跑 worker。
		const flags = this.regexFlags(req.caseSensitive ?? false);
		const result = await REGEX_POOL.run(req.query, flags, candidates, limits);
		if (!result.ok) {
			throw wikiError(result.code, result.message);
		}
		// 4. 转 hit。round-3 B1+C2: rawCount 来自 worker 的 rawMatchCount
		// (worker 统计所有候选上的 regex 命中,不被 limits.results 截断)。
		const field: WikiSearchField = req.fields?.[0] ?? "content";
		const hits = result.hits.map((h) => ({
			path: h.path,
			name: h.name,
			kind: h.kind as WikiNodeKind,
			displayTitle: h.displayTitle,
			matchedField: field,
			matchType: "regex" as WikiSearchMatchType,
			normalizedScore: normalizeScore("regex"),
			snippet: h.snippet,
			revision: h.revision,
			target: "wiki" as WikiSearchTarget,
		}));
		return { hits, rawCount: result.rawMatchCount };
	}

	/**
	 * hybrid:融合 exact + substring + fulltext + source,固定排序 tuple。
	 *
	 * 实现:
	 *   1. 并发跑 exact / substring / fulltext(若 target=source/both 也并发 source)。
	 *   2. 不做 embedding(v1 不做)。
	 *   3. 按 hybrid 排序 tuple 合并:exact < path < fulltext < source < substring。
	 *   4. **round-6 NODE-SEMANTICS**:wikiHits 按 **canonical path** 去重 ——
	 *      一节点一 hit(不再按 path × matchType × matchedField tuple)。
	 *      同节点命中多 matchType 时:hit 主体取 best-rank,全部命中类型
	 *      聚合到 `matchTypes` 证据字段。truncated=distinct 节点 > cap;
	 *      翻页获得新节点而非同节点的其他 matchType 视图。
	 */
	private async searchHybrid(
		req: WikiSearchRequest,
		allowedScopes: string[],
		limits: typeof WIKI_REGEX_DEFAULT_LIMITS,
	): Promise<WikiModeOutcome> {
		// 把 hybrid 请求拆成 3 个子查询(mode 固定;query/case/fields/scope 同 req)。
		const subReq = (m: WikiSearchMode): WikiSearchRequest => ({ ...req, mode: m });
		const [exactOut, substringOut, fulltextOut] = await Promise.all([
			this.searchExact(subReq("exact"), allowedScopes),
			this.searchSubstring(subReq("substring"), allowedScopes),
			this.searchFulltext(subReq("fulltext"), allowedScopes),
		]);
		// round-6 NODE-SEMANTICS — fusion + 去重 + matchType 聚合。
		//
		// 用户决策(2026-07-17):hybrid 的 `truncated` 与 wikiHits 集合语义按
		// **节点**(canonical path),不是按 (path × matchType × matchedField)
		// tuple。核心契约 5 点:
		//   1. `truncated=true` **仅当**匹配的不同节点数 > cap(200)。
		//   2. 同一节点命中多个 matchType 只算 1 个节点;matchType 作为该结果的
		//      **聚合证据**(wikiHits 按 canonical path 去重,一节点一 hit)。
		//   3. 恰好 200 个不同节点且全部返回 → truncated=false。
		//   4. 组件计数(rawCount)也必须按不同节点,不能按 tuple 数。
		//   5. 游标翻页应获得**新节点**,不应返回同一节点的其他命中类型视图。
		//
		// 实现:
		//   - dedup Map key 改为 `path`(canonical path)。一节点只留一条 hit。
		//   - 遍历 exact+substring+fulltext 的 hits 时,对同 path 的多条命中:
		//     · 保留 **best-rank**(按 MATCH_TYPE_RANK 最优)那条作为 hit 主体
		//       (其 matchType/matchedField/normalizedScore 取最优那条)。
		//     · 把该节点的所有 matchType 聚合到 `matchTypes` 证据字段(去重)。
		//   - 排序仍按 acceptance-04 §D oracle tuple(每节点 best-rank)。
		//   - rawCount: dedup.size 即 distinct 节点数;max(component rawCounts)
		//     兜底单组件内部溢出(组件已 slice 到 200 但 rawCount 仍是 >200
		//     的 pre-slice 节点总数)。
		//
		// dedup key 改 path 后 uniquePaths Set 冗余,已删除。
		const dedup = new Map<string, WikiSearchHit>();
		const matchTypesByPath = new Map<string, WikiSearchMatchType[]>();
		for (const h of [...exactOut.hits, ...substringOut.hits, ...fulltextOut.hits]) {
			const key = h.path;
			// 聚合 matchType 证据(去重,顺序按发现顺序,不参与 oracle 排序)。
			const evid = matchTypesByPath.get(key) ?? [];
			if (!evid.includes(h.matchType)) evid.push(h.matchType);
			matchTypesByPath.set(key, evid);
			// 保留 best-rank(hit 主体):用 compareHybridHits 比较,较小的胜出。
			// 与最终 sorted 同一 oracle,保证 hit 主体 = 该节点在最终序中的代表。
			const existing = dedup.get(key);
			if (
				!existing ||
				compareHybridHits(
					{ matchType: h.matchType, normalizedScore: h.normalizedScore, canonicalPath: h.path, target: h.target },
					{ matchType: existing.matchType, normalizedScore: existing.normalizedScore, canonicalPath: existing.path, target: existing.target },
				) < 0
			) {
				dedup.set(key, h);
			}
		}
		// 把聚合证据挂到每条幸存的 hit(length ≥ 2 时才有信息增量;length === 1
		// 时 primary matchType 已足够,省略 matchTypes 减少载荷)。
		for (const [path, hit] of dedup) {
			const evid = matchTypesByPath.get(path);
			if (evid && evid.length >= 2) {
				hit.matchTypes = evid;
			}
		}
		const sorted = Array.from(dedup.values()).sort((a, b) =>
			compareHybridHits(
				{ matchType: a.matchType, normalizedScore: a.normalizedScore, canonicalPath: a.path, target: a.target },
				{ matchType: b.matchType, normalizedScore: b.normalizedScore, canonicalPath: b.path, target: b.target },
			),
		);
		// round-6 NODE-SEMANTICS: rawCount = distinct 节点数,不是 tuple 数。
		//   - dedup.size 是 path-keyed 后的幸存节点并集(组件已 slice 到 200,
		//     所以 dedup 只看到各组件返回的 survivors;多组件去重后 union ≤
		//     各组件 hits 数之和,通常 ≪ 600 因 exact⊆substring⊆fulltext)。
		//   - max(component rawCounts) 兜底:某组件 pre-slice 节点数 >200 而
		//     返回被 slice 到 200 时,dedup 只看到 200,但该组件 rawCount(如
		//     250)记录了真实 pre-slice 节点总数。
		//   - 可证正确(节点语义):
		//     · 无 false-positive:dedup.size ≤ 真 distinct 节点并集;组件
		//       rawCount ≤ 该组件真 distinct 节点数(total,非 tuple)≤ 真
		//       distinct 节点并集。故 max(·) ≤ 真 distinct 节点数 → 若
		//       max(·) > 200 则真 distinct 节点数 >200 → truncated=true 合理。
		//     · 无 false-negative:真 distinct 节点数 >200 ⟹ 至少一个组件
		//       pre-slice 命中 >200(否则该组件返回的 ≤200 节点 ∪ 其他组件
		//       ≤200 节点 无法超过 200)。该组件 rawCount >200 ⟹ max(·) >200
		//       ⟹ truncated=true。
		//   - 组件 rawCounts 全部经独立验证为节点数(exact/substring/glob =
		//     rows.length;fulltext = COUNT(*) over wiki_nodes_fts.rowid =
		//     wiki_nodes.id,external-content FTS5 一文档一节点;regex =
		//     worker rawMatchCount,每候选节点最多 +1)。
		const hits = sorted.slice(0, limits.results);
		return {
			hits,
			rawCount: Math.max(dedup.size, exactOut.rawCount, substringOut.rawCount, fulltextOut.rawCount),
		};
	}

	// =========================================================================
	// Source search — delegates to sub-03 WikiSourceSearch
	// =========================================================================

	private async searchSource(
		req: WikiSearchRequest,
		mode: WikiSearchMode,
		allowedScopes: string[],
		ctx: WikiRequestContext,
	): Promise<WikiSourceSearchHit[]> {
		if (!this.deps.sourceSearch) {
			// target=source/both 但未注入 sourceSearch → 空结果(不报错)。
			return [];
		}
		// Map hybrid → substring fallback (source has no FTS).
		const sourceMode: SourceSearchRequest["mode"] =
			mode === "exact" ? "exact"
			: mode === "substring" ? "substring"
			: mode === "glob" ? "glob"
			: mode === "regex" ? "regex"
			: "substring"; // fulltext/hybrid → substring
		// Source 搜索只在 project scope 内有意义。
		const projectScopes = allowedScopes.filter((s) =>
			s.startsWith("wiki-root/projects/"),
		);
		if (projectScopes.length === 0) return [];
		const projectScope = projectScopes[0];
		const parts = projectScope.split("/");
		const projectId = parts[2]; // wiki-root/projects/<id>/...
		if (!projectId || !ctx.access.activeProjectId) return [];
		const sourceRelScope = this.canonicalToSourceRel(projectScope, projectScope);

		const sourceReq: SourceSearchRequest = {
			projectId,
			mode: sourceMode,
			pattern: req.query,
			caseSensitive: req.caseSensitive ?? false,
			scope: sourceRelScope,
			limit: req.limit ?? 200,
			cursor: req.cursor,
			workspace: req.sourceView === "dirty" ? true : false,
			fileGlobs: req.fileGlobs,
		};
		const outcome = await this.deps.sourceSearch.search(sourceReq);
		if (!outcome.ok) {
			throw wikiError(outcome.code, outcome.message);
		}
		return outcome.result.hits.map((h) => sourceHitToView(h));
	}

	// =========================================================================
	// Helpers — scope-aware node query, snippet, cursor
	// =========================================================================

	/**
	 * 取所有 active 节点 in allowedScopes(段基 scope 匹配)。
	 *
	 * **关键不变量(round-2 FIX 2 / acceptance-04 §H)**:WHERE 子句在 SQL 层
	 * 使用段基 predicate `(path = ? OR path LIKE ? || '/%' ESCAPE '\\')`,
	 * scope 已 LIKE-escape(`%`/`_`/`\`)。**绝不**用 `path >= ? AND path <= ?`
	 * 字典序范围 —— `-`(0x2D)/`.`(0x2E)/`~`(0x7E)等字符排在校验 `/`(0x2F)
	 * 之前,字典序范围会把 sibling `wiki-root/a/alpha-secret` 错误纳入 scope
	 * `wiki-root/a/alpha0`,泄露未授权 path + snippet。
	 *
	 * **JS 二次校验**:SQLite LIKE 即便写 `COLLATE BINARY` 也不会真切换大小写
	 * (见 searchSubstring 注释;只有 `PRAGMA case_sensitive_like=ON` 真正生效,
	 * 但 PRAGMA 是连接级全局状态,共享连接上切换有竞态)。本方法在 SQL 取 rows 后,
	 * 用 `isSameOrDescendant(scope, row.path)` 做**段基 + 大小写敏感**的二次校验
	 * 作为 defense-in-depth,防止任何 case-folding 误匹配导致的越权泄露。
	 */
	private queryNodesInScopes(
		allowedScopes: string[],
		buildPredicate: (scope: string) => string,
		params: string[],
		kinds?: WikiNodeKind[],
	): WikiNodeRow[] {
		const out: WikiNodeRow[] = [];
		// round-3 C1: kinds filter applied at SQL layer so rawCount reflects
		// post-filter total (not pre-filter, which would over-count and skew
		// truncated). Empty/undefined kinds → no filter.
		const { clause: kindsClause, params: kindsParams } = this.kindsClauseAndParams(kinds);
		for (const scope of allowedScopes) {
			const escapedScope = this.escapeLike(scope);
			const predicate = buildPredicate(scope);
			const sql = `SELECT * FROM wiki_nodes
					WHERE archived_at IS NULL
					  AND (path = ? OR path LIKE ? || '/%' COLLATE BINARY ESCAPE '\\')
					  AND ${predicate}${kindsClause}
					ORDER BY path ASC`;
			const allParams = [scope, escapedScope, ...params, ...kindsParams];
			const stmt = this.deps.db.prepare(sql);
			const rows = stmt.all(...allParams) as WikiNodeRow[];
			// Defense-in-depth:段基 + 大小写敏感的二次校验。SQL LIKE 即便带
			// COLLATE BINARY 仍是 NOCASE,可能 over-fetch case-different siblings
			// (如 scope `wiki-root/knowledge` 命中 `wiki-root/Knowledge/...`)。
			// 这里严格用 isSameOrDescendant 收紧。
			for (const row of rows) {
				if (isSameOrDescendant(scope, row.path)) {
					out.push(row);
				}
			}
		}
		return out;
	}

	/**
	 * Build SQL clause + params for `req.kinds` filter (round-3 C1).
	 *
	 * Returns `{ clause: " AND kind IN (?, ?, ...)", params: kinds }` when kinds
	 * is non-empty, or `{ clause: "", params: [] }` when undefined/empty (= no
	 * filter). Applied at SQL layer so the predicate participates in query
	 * planning and rawCount reflects post-filter total.
	 */
	private kindsClauseAndParams(
		kinds: WikiNodeKind[] | undefined,
	): { clause: string; params: WikiNodeKind[] } {
		if (!kinds || kinds.length === 0) {
			return { clause: "", params: [] };
		}
		const placeholders = kinds.map(() => "?").join(",");
		return { clause: ` AND kind IN (${placeholders})`, params: kinds };
	}

	private emptyResult(
		req: WikiSearchRequest,
		mode: WikiSearchMode,
		target: WikiSearchTarget,
	): WikiSearchResult {
		return {
			wikiHits: [],
			sourceHits: [],
			cursor: null,
			hasMore: false,
			limits: resolveRegexLimits(this.deps.regexLimits),
			target,
			mode,
			effectiveScope: req.scope ?? null,
			truncated: false,
		};
	}

	private regexFlags(caseSensitive: boolean): string {
		return caseSensitive ? "" : "i";
	}

	/**
	 * FTS5 安全 query:把 query 包成 `"token"*`(phrase + prefix match)。
	 * 不暴露 AND/OR/NEAR 高级语法(避免注入 + 简化测试 oracle)。
	 */
	private buildFtsQuery(query: string): string {
		const safe = query.replace(/["*]/g, " ").trim();
		if (!safe) return '""';
		return `"${safe}"*`;
	}

	private escapeLike(s: string): string {
		return s.replace(/[%_\\]/g, (c) => "\\" + c);
	}

	/**
	 * glob → SQL LIKE pattern 编译(粗筛)。JS glob matcher 做精确段级 verify。
	 *
	 *   - `**` → SQL `%`
	 *   - `*`  → SQL `%`
	 *   - `?`  → SQL `_`
	 */
	private globToSqlLike(glob: string): string {
		const escaped = glob.replace(/[%_\\]/g, (c) => "\\" + c);
		const withDouble = escaped.replace(/\*\*/g, " ");
		const withSingle = withDouble.replace(/\*/g, "%");
		const restored = withSingle.replace(/ /g, "%");
		const withQuestion = restored.replace(/\?/g, "_");
		return `%${withQuestion}%`;
	}

	private buildSnippet(row: WikiNodeRow, query: string): string {
		const src = row.summary.length > 0 ? row.summary : row.content;
		if (!src) return "";
		const idx = src.toLowerCase().indexOf(query.toLowerCase());
		if (idx < 0) return src.slice(0, 200);
		const start = Math.max(0, idx - 80);
		const end = Math.min(src.length, idx + query.length + 120);
		return src.slice(start, end);
	}

	private clampLimit(n: number): number {
		return Math.max(1, Math.min(Math.floor(n), 200));
	}

	private encodeCursor(idx: number): string {
		return Buffer.from(JSON.stringify({ i: idx }), "utf-8").toString("base64");
	}

	private decodeCursor(c: string | null): number {
		if (!c) return 0;
		try {
			const j = Buffer.from(c, "base64").toString("utf-8");
			const parsed = JSON.parse(j);
			if (typeof parsed?.i === "number" && parsed.i >= 0) return parsed.i;
		} catch {
			// 非法 cursor → 从头开始。
		}
		return 0;
	}

	private mergeForPagination(
		wikiHits: WikiSearchHit[],
		sourceHits: WikiSourceSearchHit[],
		target: WikiSearchTarget,
	): Array<WikiSearchHit | WikiSourceSearchHit> {
		const toKey = (h: WikiSearchHit | WikiSourceSearchHit) => ({
			matchType: h.matchType,
			normalizedScore: h.normalizedScore,
			canonicalPath: h.path,
			target: h.target,
		});
		if (target === "wiki") {
			return [...wikiHits].sort((a, b) => compareHybridHits(toKey(a), toKey(b)));
		}
		if (target === "source") {
			return [...sourceHits].sort((a, b) => compareHybridHits(toKey(a), toKey(b)));
		}
		// both: 合并 + 排序(保留 provenance,不合并同 path 命中)。
		const all = [...wikiHits, ...sourceHits] as Array<WikiSearchHit | WikiSourceSearchHit>;
		return all.sort((a, b) => compareHybridHits(toKey(a), toKey(b)));
	}

	private canonicalToSourceRel(canonicalScope: string, projectScope: string): string {
		const stripped = canonicalScope.startsWith(projectScope)
			? canonicalScope.slice(projectScope.length).replace(/^\/+/, "")
			: "";
		return stripped;
	}

	// -------------------------------------------------------------------------
	// Row → Hit converters
	// -------------------------------------------------------------------------

	private rowToExactHit(row: WikiNodeRow, req: WikiSearchRequest): WikiSearchHit {
		return {
			path: row.path,
			name: row.name,
			kind: row.kind as WikiNodeKind,
			displayTitle: this.displayTitleOf(row),
			matchedField: this.detectExactField(row, req),
			matchType: "exact",
			normalizedScore: normalizeScore("exact"),
			snippet: row.summary.slice(0, 200),
			revision: row.revision,
			target: "wiki",
		};
	}

	private rowToSubstringHit(
		row: WikiNodeRow,
		req: WikiSearchRequest,
		field: WikiSearchField,
	): WikiSearchHit {
		return {
			path: row.path,
			name: row.name,
			kind: row.kind as WikiNodeKind,
			displayTitle: this.displayTitleOf(row),
			matchedField: field,
			matchType: "substring",
			normalizedScore: normalizeScore("substring"),
			snippet: this.buildSnippet(row, req.query),
			revision: row.revision,
			target: "wiki",
		};
	}

	private rowToGlobHit(
		row: WikiNodeRow,
		req: WikiSearchRequest,
		field: WikiSearchField,
	): WikiSearchHit {
		return {
			path: row.path,
			name: row.name,
			kind: row.kind as WikiNodeKind,
			displayTitle: this.displayTitleOf(row),
			matchedField: field,
			matchType: "path",
			normalizedScore: normalizeScore("path"),
			snippet: this.buildSnippet(row, req.query),
			revision: row.revision,
			target: "wiki",
		};
	}

	private rowToFulltextHit(
		row: WikiNodeRow,
		req: WikiSearchRequest,
		snippet: string,
		rawRank: number,
	): WikiSearchHit {
		return {
			path: row.path,
			name: row.name,
			kind: row.kind as WikiNodeKind,
			displayTitle: this.displayTitleOf(row),
			matchedField: this.detectFulltextField(row, req),
			matchType: "fulltext",
			normalizedScore: normalizeScore("fulltext", rawRank),
			snippet,
			revision: row.revision,
			target: "wiki",
		};
	}

	private detectExactField(row: WikiNodeRow, req: WikiSearchRequest): WikiSearchField {
		const q = req.query;
		const eq = req.caseSensitive
			? (a: string, b: string) => a === b
			: (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		if (eq(row.name, q)) return "name";
		if (eq(row.path, q)) return "path";
		if (eq(row.summary, q)) return "summary";
		return "content";
	}

	private detectFulltextField(row: WikiNodeRow, req: WikiSearchRequest): WikiSearchField {
		const q = req.query.toLowerCase();
		if (row.name.toLowerCase().includes(q)) return "name";
		if (row.summary.toLowerCase().includes(q)) return "summary";
		return "content";
	}

	private detectSubstringField(row: WikiNodeRow, req: WikiSearchRequest): WikiSearchField {
		// round-2 FIX 4: caseSensitive=true 时不大写化,精确字节比较。
		const caseSensitive = req.caseSensitive ?? false;
		const q = caseSensitive ? req.query : req.query.toLowerCase();
		const match = (v: string): boolean =>
			caseSensitive ? v.includes(q) : v.toLowerCase().includes(q);
		if (req.fields && req.fields.length > 0) {
			for (const f of req.fields) {
				if (match(fieldText(row, f))) return f;
			}
		}
		if (match(row.name)) return "name";
		if (match(row.summary)) return "summary";
		return "content";
	}

	private displayTitleOf(row: WikiNodeRow): string {
		if (!row.attributes_json) return row.name;
		try {
			const a = JSON.parse(row.attributes_json);
			return a?.display_name ?? row.name;
		} catch {
			return row.name;
		}
	}
}

// ---------------------------------------------------------------------------
// Free helpers — glob matcher, source hit mapping
// ---------------------------------------------------------------------------

/**
 * 编译 segment-aware glob matcher。
 *
 *   - `*`   单段内任意字符(不跨 `/`)
 *   - `**`  跨段任意(可跨 `/`)
 *   - `?`  单字符
 *
 * 实现把 glob 翻译为 RegExp:
 *   - 先 escape RegExp meta 字符。
 *   - `**` → `.*`
 *   - `*` → `[^/]*`
 *   - `?` → `.`
 */
export function compileGlobMatcher(glob: string, caseSensitive: boolean): (input: string) => boolean {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 2;
				if (glob[i] === "/") i++; // allow optional `/` after `**`(e.g. `**/foo`)
			} else {
				re += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			re += ".";
			i++;
		} else if (/[.+^${}()|[\]\\]/.test(ch)) {
			re += "\\" + ch;
			i++;
		} else {
			re += ch;
			i++;
		}
	}
	const flags = caseSensitive ? "" : "i";
	const regex = new RegExp(`^${re}$`, flags);
	return (input: string) => regex.test(input);
}

function fieldText(row: WikiNodeRow, f: WikiSearchField): string {
	switch (f) {
		case "name": return row.name;
		case "path": return row.path;
		case "summary": return row.summary;
		case "content": return row.content;
		default: return "";
	}
}

/**
 * 把 sub-03 SourceSearchHit 转 WikiSourceSearchHit(strip 内部 id;带 score)。
 */
function sourceHitToView(h: SourceSearchHit): WikiSourceSearchHit {
	const matchType: WikiSearchMatchType = "source";
	return {
		path: h.nodePath,
		sourcePath: h.sourcePath,
		line: h.line,
		text: h.text,
		columnStart: h.columnStart,
		columnEnd: h.columnEnd,
		origin: h.origin,
		dirty: h.dirty,
		sourceKind: h.sourceKind,
		indexedRevision: h.indexedRevision,
		matchedField: "content",
		matchType,
		normalizedScore: normalizeScore(matchType),
		target: "source",
	};
}

// Re-exports.
export type { CompiledWikiAccess };
