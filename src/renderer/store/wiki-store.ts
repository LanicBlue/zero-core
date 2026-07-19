// Wiki 浏览器 Zustand store(wiki-system-redesign plan-06 §3)
//
// # 文件说明书
//
// ## 核心功能
// Wiki 浏览器(管理 UI)的状态层。**canonical path 是唯一公开 key**:
//   - children / detail / relations / source / history 各自独立缓存,key 都是
//     canonical path(`wiki-root/...`),**绝不**用内部 DB 整数 ID。
//   - children 用 cursor 分页(默认 50/页;1,000 同级 child 不一次拉完)。
//   - search 保存完整 mode/target/filter;archived 默认隐藏,管理员开关后可见。
//   - scope 支持 canonical root(`wiki-root`、`wiki-root/memory/<agentId>`...)或
//     已解析 logical address view(`memory://`、`project://<id>`...)。
//
// ## 关键不变量(plan-06 §3 / acceptance-06 §B.1 / §H)
//   - **renderer state 严禁 DB ID** —— 所有 Record<string, ...> 的 key 都是
//     canonical path。API 返回的 WikiNodeView/WikiExpandChildItem 等也不含 id。
//   - **公开 key = canonical path** —— React 组件用 path 作 key 渲染。
//   - **只失效已加载父 branch**(plan-06 §7):收到 wiki_nodes/wiki_links/wiki_sync
//     event 时,未展开的 branch 不主动拉取;move 同时清 oldPath 缓存 + 刷 old/new
//     parent。
//   - **增量同步,不全量重拉**(acceptance-06 §E.4):WS 重连后只 refresh 已加载
//     branch,不下载整棵树。
//
// ## 输入
// IPC:wikiV2:expand / read / search / create / update / delete / link / unlink /
//      move + wikiV2:readWorkspaceDoc(沙箱读 workspace 源文件)。
// Data-change:onDataChanged → 过滤 wiki_nodes/wiki_links/wiki_sync collection。
//
// ## 输出
// - childrenByPath / detailByPath / relationsByPath / sourceByPath / historyByPath
// - searchResult + lastSearchParams
// - selectedPath / scope / showArchived
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-06-data-api-browser-ui.md §3/§7
//   - docs/archive/wiki-system-redesign/acceptance-06-data-api-browser-ui.md §B/§E/§H

import { create } from "zustand";
import type {
	WikiExpandRequest, WikiExpandResult,
	WikiReadRequest, WikiReadResult,
	WikiMutationResult,
	WikiNodeView, WikiLinkView, WikiNodeKind,
	WikiAuditView,
} from "../../shared/wiki-types.js";
import type {
	WikiSearchRequest, WikiSearchResult,
} from "../../shared/wiki-search-types.js";
import { useNotificationStore } from "./notification-store.js";

const api = () => (window as any).api;

// ---------------------------------------------------------------------------
// scope — view root(canonical path 或 logical address)
// ---------------------------------------------------------------------------

/**
 * Wiki 浏览器视角。决定首屏拉哪棵子树作根。
 *
 * - `global`     → canonical root `wiki-root`(整树,逐层展开)。
 * - `knowledge`  → `wiki-root/knowledge`(知识库根)。
 * - `memory`     → `wiki-root/memory`(所有 agent memory 根,管理员视角)。
 * - `agent-memory` → `wiki-root/memory/<agentId>`(单 agent memory 子树)。
 * - `project`    → `wiki-root/projects/<projectId>`(项目镜像根;或
 *                  logical address `project://<id>` 由后端解析)。
 * - `address`    → 自定义 logical address / canonical path(由调用方解析)。
 */
export type WikiViewScope =
	| { kind: "global" }
	| { kind: "knowledge" }
	| { kind: "memory" }
	| { kind: "agent-memory"; agentId: string }
	| { kind: "project"; projectId: string }
	| { kind: "address"; address: string };

/** 把 scope 解析成 POST /expand 的 address 字段。 */
export function scopeToAddress(scope: WikiViewScope): string {
	switch (scope.kind) {
		case "global": return "wiki-root";
		case "knowledge": return "wiki-root/knowledge";
		case "memory": return "wiki-root/memory";
		case "agent-memory": return `memory://${scope.agentId}`;
		case "project": return `project://${scope.projectId}`;
		case "address": return scope.address;
	}
}

/**
 * 默认每页 child 数(plan-06 §4 / acceptance-06 §B.7「1,000 同级 child 不一次
 * 拉完」)。UI 可改 limit 但调用方裁剪到 [10, 500]。
 */
export const DEFAULT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Cache shapes
// ---------------------------------------------------------------------------

interface ChildPage {
	items: WikiExpandResult["children"]["items"];
	cursor: string | null;
	hasMore: boolean;
}

interface DetailCache {
	node?: WikiNodeView;
	content?: string;
	contentSlice?: { startLine: number | null; endLine: number | null; totalLines: number };
	/** error message on last fetch (undefined = no error / not yet fetched). */
	error?: string;
	loading?: boolean;
}

interface RelationsCache {
	outgoing: WikiLinkView[];
	incoming: WikiLinkView[];
	loading?: boolean;
	error?: string;
}

interface SourceCache {
	repositoryId?: string;
	sourcePath?: string;
	indexedRevision?: string;
	syncStatus?: string;
	workspaceContent?: string;
	loading?: boolean;
	error?: string;
}

interface HistoryEntry {
	auditId: string;
	action: string;
	actorAgentId: string | null;
	nodePath: string | null;
	oldRevision: number | null;
	newRevision: number | null;
	createdAt: string;
}

interface HistoryCache {
	entries: HistoryEntry[];
	loading?: boolean;
	error?: string;
}

interface NodeSummaryCache {
	/** sparse summary from expand() — displayTitle / kind / archived flag. */
	displayTitle?: string;
	kind?: WikiNodeKind;
	summary?: string;
	archived?: boolean;
}

interface SearchResultEntry {
	path: string;
	displayTitle: string;
	kind: WikiNodeKind;
	matchedField: string;
	matchType: string;
	normalizedScore: number;
	snippet: string;
	revision: number;
	target: string;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface WikiState {
	// ── scope & flags ────────────────────────────────────────────────
	scope: WikiViewScope;
	/** 管理员显式开"显示已归档"开关。默认 false → archived 节点不显示。 */
	showArchived: boolean;

	// ── 分离缓存(canonical path keyed)──────────────────────────────
	/** path → 直接 children 分页结果(cursor→page 累积;hasMore 控制"加载更多")。 */
	childrenByPath: Record<string, ChildPage>;
	/** path → 是否已加载首屏 children(展开/折叠追踪)。 */
	childrenLoaded: Record<string, boolean>;
	/** path → 是否正在拉 children(Loading 行 / spinner)。 */
	loadingChildren: Record<string, boolean>;
	/** path → 节点 summary 缓存(expand 结果顺手记下;displayTitle/kind/archived)。 */
	summaryByPath: Record<string, NodeSummaryCache>;
	/** path → detail(content / links / node view;按 view 拆懒加载)。 */
	detailByPath: Record<string, DetailCache>;
	/** path → relations(incoming / outgoing;按 view=links 懒加载)。 */
	relationsByPath: Record<string, RelationsCache>;
	/** path → source metadata + workspace content(view=source 懒加载)。 */
	sourceByPath: Record<string, SourceCache>;
	/** path → audit history(只读;plan-06 §6 History tab,懒加载)。 */
	historyByPath: Record<string, HistoryCache>;

	// ── 选中节点 + 搜索 ─────────────────────────────────────────────
	selectedPath: string | null;
	/** search request 保存完整 mode/target/filter(plan-06 §5)。 */
	lastSearchParams: WikiSearchRequest | null;
	/** search result(扁平 hits 数组 + 分页 cursor)。 */
	searchResult: {
		wikiHits: SearchResultEntry[];
		sourceHits: SearchResultEntry[];
		cursor: string | null;
		hasMore: boolean;
		truncated: boolean;
	} | null;
	searchLoading: boolean;
	searchError: string | null;

	// ── actions ──────────────────────────────────────────────────────
	setScope: (scope: WikiViewScope) => void;
	setShowArchived: (v: boolean) => void;
	refresh: () => Promise<void>;
	expandPath: (path: string, opts?: { reset?: boolean }) => Promise<void>;
	loadMoreChildren: (path: string) => Promise<void>;
	selectPath: (path: string | null) => void;
	loadDetail: (path: string, view?: "summary" | "content" | "all") => Promise<void>;
	loadRelations: (path: string) => Promise<void>;
	loadSource: (path: string) => Promise<void>;
	loadHistory: (path: string) => Promise<void>;
	runSearch: (req: WikiSearchRequest) => Promise<void>;
	loadMoreSearch: () => Promise<void>;
	clearSearch: () => void;

	// ── mutations(走 V2 endpoint,本地失效缓存) ─────────────────
	createChild: (input: {
		parent: string;
		name: string;
		kind?: WikiNodeKind;
		summary?: string;
		content?: string;
	}) => Promise<WikiMutationResult | null>;
	updateNode: (input: {
		address: string;
		expected_revision: number;
		summary?: string;
		content?: string;
	}) => Promise<WikiMutationResult | null>;
	deleteNode: (input: { address: string; cascade?: boolean }) => Promise<WikiMutationResult | null>;
	moveNode: (input: { address: string; newParent: string; newName?: string }) => Promise<WikiMutationResult | null>;
	linkNodes: (input: { source: string; target: string; relation: string }) => Promise<WikiMutationResult | null>;
	unlinkNodes: (input: { source: string; target: string; relation: string }) => Promise<WikiMutationResult | null>;

	// ── 工作区文件(Source tab)─────────────────────────────────────
	readWorkspaceDoc: (projectId: string, relPath: string) => Promise<{ content?: string; error?: string }>;

	// ── 增量同步 §7 ─────────────────────────────────────────────────
	_applyNodeEvent: (event: { path: string; op: string; oldPath?: string | null; parentPath?: string | null }) => void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pathParent(path: string): string | null {
	// canonical path parent: "wiki-root/a/b" → "wiki-root/a";"wiki-root" → null。
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return null;
	return path.slice(0, idx);
}

function isSameOrDescendant(ancestor: string, candidate: string): boolean {
	if (candidate === ancestor) return true;
	return candidate.startsWith(ancestor + "/");
}

/**
 * Run a V2 endpoint;returns parsed `result` on ok,or `null` + notification
 * on error. Throwing ipc-proxy 4xx 已经把 backend `{error:{code,message}}` 形态
 * 转成 Error.message。
 */
async function callV2<T>(
	endpoint: "wikiV2Expand" | "wikiV2Read" | "wikiV2Search" | "wikiV2Create" | "wikiV2Update" | "wikiV2Delete" | "wikiV2Link" | "wikiV2Unlink" | "wikiV2Move" | "wikiV2History",
	body: unknown,
	addError: (msg: string) => void,
): Promise<T | null> {
	try {
		const resp = await api()[endpoint](body) as { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
		if (resp && typeof resp === "object" && "ok" in resp) {
			if (resp.ok) return resp.result;
			addError(`${resp.error.code}: ${resp.error.message}`);
			return null;
		}
		// 不应到达;ipc-proxy 在非 2xx 时已 throw。
		addError("unexpected response shape");
		return null;
	} catch (err: any) {
		addError(err?.message || `${endpoint} failed`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useWikiStore = create<WikiState>((set, get) => ({
	scope: { kind: "global" },
	showArchived: false,

	childrenByPath: {},
	childrenLoaded: {},
	loadingChildren: {},
	summaryByPath: {},
	detailByPath: {},
	relationsByPath: {},
	sourceByPath: {},
	historyByPath: {},

	selectedPath: null,
	lastSearchParams: null,
	searchResult: null,
	searchLoading: false,
	searchError: null,

	setScope: (scope) => {
		// 切 scope → 丢弃所有缓存(新 scope 视为完全独立的视图)。不全量拉,只
		// 拉新 scope 根的首屏 children(refresh())。
		set({
			scope,
			childrenByPath: {},
			childrenLoaded: {},
			loadingChildren: {},
			summaryByPath: {},
			detailByPath: {},
			relationsByPath: {},
			sourceByPath: {},
			historyByPath: {},
			selectedPath: null,
			searchResult: null,
			lastSearchParams: null,
			searchError: null,
		});
		void get().refresh();
	},

	setShowArchived: (v) => set({ showArchived: v }),

	refresh: async () => {
		// 拉当前 scope 根的首屏 children。expandPath 会处理 loading 状态。
		const address = scopeToAddress(get().scope);
		// scope 的 root 在 store 内部用 canonical address 作 key(可能与解析后的
		// canonical path 不同 —— 比如 `memory://` 解析为 `wiki-root/memory/<id>`)。
		// 第一次 expand 用 address 作 key;返回的 result.path 是 canonical,记录
		// 时按 result.path 重新映射。
		await get().expandPath(address, { reset: true });
	},

	expandPath: async (address, opts) => {
		// expand 接受 logical address 或 canonical path;首次拉/reset 时 force 请求,
		// 否则幂等(已加载/加载中则 skip)。
		const reset = opts?.reset ?? false;
		if (!reset && (get().childrenLoaded[address] || get().loadingChildren[address])) return;
		set((s) => ({ loadingChildren: { ...s.loadingChildren, [address]: true } }));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiExpandResult>(
			"wikiV2Expand",
			{
				address,
				limit: DEFAULT_PAGE_SIZE,
				cursor: null,
				includeLinks: false,
			} satisfies WikiExpandRequest,
			addError,
		);
		if (result === null) {
			set((s) => ({ loadingChildren: { ...s.loadingChildren, [address]: false } }));
			return;
		}
		set((state) => {
			// 用 result.path(canonical)与 address 双 key 都记录 —— 后端解析后的
			// canonical path 与原始 address 都能命中缓存。如果两者相同,就只写一次。
			const childrenByPath = { ...state.childrenByPath };
			const childrenLoaded = { ...state.childrenLoaded };
			const loadingChildren = { ...state.loadingChildren };
			const summaryByPath = { ...state.summaryByPath };

			const page: ChildPage = {
				items: result.children.items,
				cursor: result.children.cursor,
				hasMore: result.children.hasMore,
			};
			childrenByPath[result.path] = page;
			childrenLoaded[result.path] = true;
			loadingChildren[result.path] = false;
			summaryByPath[result.path] = {
				displayTitle: result.displayTitle,
				kind: result.kind,
				summary: result.summary,
			};
			// 顺手记录每个 child 的 sparse summary(displayTitle / kind / archived)。
			for (const c of result.children.items) {
				summaryByPath[c.path] = {
					displayTitle: c.displayTitle,
					kind: c.kind,
					summary: c.summary,
					archived: c.archived,
				};
			}
			// 若 address 与 result.path 不同(逻辑地址解析),双 key 都记 loaded。
			if (address !== result.path) {
				childrenByPath[address] = page;
				childrenLoaded[address] = true;
				loadingChildren[address] = false;
			}

			return { childrenByPath, childrenLoaded, loadingChildren, summaryByPath };
		});
	},

	loadMoreChildren: async (address) => {
		const current = get().childrenByPath[address];
		if (!current || !current.hasMore || get().loadingChildren[address]) return;
		set((s) => ({ loadingChildren: { ...s.loadingChildren, [address]: true } }));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiExpandResult>(
			"wikiV2Expand",
			{
				address,
				limit: DEFAULT_PAGE_SIZE,
				cursor: current.cursor,
				includeLinks: false,
			} satisfies WikiExpandRequest,
			addError,
		);
		if (result === null) {
			set((s) => ({ loadingChildren: { ...s.loadingChildren, [address]: false } }));
			return;
		}
		set((state) => {
			const childrenByPath = { ...state.childrenByPath };
			const existing = childrenByPath[address] ?? { items: [], cursor: null, hasMore: false };
			childrenByPath[address] = {
				items: [...existing.items, ...result.children.items],
				cursor: result.children.cursor,
				hasMore: result.children.hasMore,
			};
			const summaryByPath = { ...state.summaryByPath };
			for (const c of result.children.items) {
				summaryByPath[c.path] = {
					displayTitle: c.displayTitle,
					kind: c.kind,
					summary: c.summary,
					archived: c.archived,
				};
			}
			return {
				childrenByPath,
				loadingChildren: { ...state.loadingChildren, [address]: false },
				summaryByPath,
			};
		});
	},

	selectPath: (path) => set({ selectedPath: path }),

	loadDetail: async (path, view = "all") => {
		// detail 懒加载(点选时触发)。view 默认 all(包含 summary/content/links);
		// 显式传 summary 只拉 node view。
		const existing = get().detailByPath[path];
		if (existing && !existing.error && !existing.loading) return;
		set((s) => ({
			detailByPath: {
				...s.detailByPath,
				[path]: { ...existing, loading: true, error: undefined },
			},
		}));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiReadResult>(
			"wikiV2Read",
			{
				address: path,
				view,
			} satisfies WikiReadRequest,
			addError,
		);
		if (result === null) {
			set((s) => ({
				detailByPath: {
					...s.detailByPath,
					[path]: { loading: false, error: "loadDetail failed" },
				},
			}));
			return;
		}
		set((state) => {
			const detailByPath = { ...state.detailByPath };
			detailByPath[path] = {
				node: result.node,
				content: result.content,
				contentSlice: result.contentSlice,
				loading: false,
			};
			const relationsByPath = { ...state.relationsByPath };
			if (result.links) {
				relationsByPath[path] = {
					outgoing: result.links.outgoing,
					incoming: result.links.incoming,
				};
			}
			const sourceByPath = { ...state.sourceByPath };
			if (result.source) {
				sourceByPath[path] = {
					repositoryId: result.source.repositoryId,
					sourcePath: result.source.sourcePath,
					indexedRevision: result.source.indexedRevision,
					syncStatus: result.source.syncStatus,
				};
			}
			// 节点 summary 同步更新(若 expand 之前记过 sparse,read 完整覆写)。
			const summaryByPath = { ...state.summaryByPath };
			summaryByPath[path] = {
				displayTitle: result.node.displayTitle,
				kind: result.node.kind,
				summary: result.node.summary,
				archived: result.node.archivedAt !== null,
			};
			return { detailByPath, relationsByPath, sourceByPath, summaryByPath };
		});
	},

	loadRelations: async (path) => {
		const existing = get().relationsByPath[path];
		if (existing && !existing.loading && !existing.error) return;
		set((s) => ({
			relationsByPath: {
				...s.relationsByPath,
				[path]: { ...(existing ?? { outgoing: [], incoming: [] }), loading: true },
			},
		}));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiReadResult>(
			"wikiV2Read",
			{ address: path, view: "links" } satisfies WikiReadRequest,
			addError,
		);
		if (result === null || !result.links) {
			set((s) => ({
				relationsByPath: {
					...s.relationsByPath,
					[path]: { outgoing: [], incoming: [], loading: false, error: "loadRelations failed" },
				},
			}));
			return;
		}
		set((s) => ({
			relationsByPath: {
				...s.relationsByPath,
				[path]: {
					outgoing: result.links!.outgoing,
					incoming: result.links!.incoming,
					loading: false,
				},
			},
		}));
	},

	loadSource: async (path) => {
		// source view: read view=source 返回 binding 元数据(indexed_revision /
		// syncStatus);workspace 内容需另调 readWorkspaceDoc(项目沙箱)。
		const existing = get().sourceByPath[path];
		if (existing && existing.repositoryId && !existing.loading) return;
		set((s) => ({
			sourceByPath: { ...s.sourceByPath, [path]: { ...existing, loading: true } },
		}));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiReadResult>(
			"wikiV2Read",
			{ address: path, view: "source" } satisfies WikiReadRequest,
			addError,
		);
		if (result === null || !result.source) {
			set((s) => ({
				sourceByPath: {
					...s.sourceByPath,
					[path]: { loading: false, error: "loadSource failed" },
				},
			}));
			return;
		}
		set((s) => ({
			sourceByPath: {
				...s.sourceByPath,
				[path]: {
					repositoryId: result.source!.repositoryId,
					sourcePath: result.source!.sourcePath,
					indexedRevision: result.source!.indexedRevision,
					syncStatus: result.source!.syncStatus,
					loading: false,
				},
			},
		}));
	},

	loadHistory: async (path) => {
		// plan-06 §6 History tab:节点 audit log(只读)。从 wikiV2History endpoint
		// 拉,后端走 WikiService.listHistory → auditRepo.listByNodePath。
		// 懒加载:已成功加载过 → 直接复用;首次 / 之前失败 → 重拉。
		const existing = get().historyByPath[path];
		if (existing && !existing.loading && !existing.error) return;
		set((s) => ({
			historyByPath: {
				...s.historyByPath,
				[path]: { ...(existing ?? { entries: [] }), entries: existing?.entries ?? [], loading: true },
			},
		}));
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiAuditView[]>(
			"wikiV2History",
			{ address: path, limit: 100 },
			addError,
		);
		if (result === null) {
			set((s) => ({
				historyByPath: {
					...s.historyByPath,
					[path]: { entries: [], loading: false, error: "loadHistory failed" },
				},
			}));
			return;
		}
		set((s) => ({
			historyByPath: {
				...s.historyByPath,
				[path]: {
					entries: result.map((a) => ({
						auditId: a.auditId,
						action: a.action,
						actorAgentId: a.actorAgentId,
						nodePath: a.nodePath,
						oldRevision: a.oldRevision,
						newRevision: a.newRevision,
						createdAt: a.createdAt,
					})),
					loading: false,
				},
			},
		}));
	},

	runSearch: async (req) => {
		set({ searchLoading: true, searchError: null });
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiSearchResult>(
			"wikiV2Search",
			{ ...req, cursor: null } satisfies WikiSearchRequest,
			addError,
		);
		if (result === null) {
			set({ searchLoading: false });
			return;
		}
		set({
			lastSearchParams: req,
			searchLoading: false,
			searchResult: {
				wikiHits: result.wikiHits.map((h) => ({
					path: h.path,
					displayTitle: h.displayTitle,
					kind: h.kind,
					matchedField: h.matchedField,
					matchType: h.matchType,
					normalizedScore: h.normalizedScore,
					snippet: h.snippet,
					revision: h.revision,
					target: h.target,
				})),
				sourceHits: result.sourceHits.map((h) => ({
					path: h.path,
					displayTitle: `${h.sourcePath}:${h.line}`,
					kind: "source_file" as WikiNodeKind,
					matchedField: h.matchedField,
					matchType: h.matchType,
					normalizedScore: h.normalizedScore,
					snippet: h.text,
					revision: 0,
					target: h.target,
				})),
				cursor: result.cursor,
				hasMore: result.hasMore,
				truncated: result.truncated,
			},
		});
	},

	loadMoreSearch: async () => {
		const last = get().lastSearchParams;
		const cur = get().searchResult;
		if (!last || !cur || !cur.hasMore || get().searchLoading) return;
		set({ searchLoading: true, searchError: null });
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiSearchResult>(
			"wikiV2Search",
			{ ...last, cursor: cur.cursor } satisfies WikiSearchRequest,
			addError,
		);
		if (result === null) {
			set({ searchLoading: false });
			return;
		}
		set((state) => ({
			searchLoading: false,
			searchResult: state.searchResult
				? {
					...state.searchResult,
					wikiHits: [
						...state.searchResult.wikiHits,
						...result.wikiHits.map((h) => ({
							path: h.path,
							displayTitle: h.displayTitle,
							kind: h.kind,
							matchedField: h.matchedField,
							matchType: h.matchType,
							normalizedScore: h.normalizedScore,
							snippet: h.snippet,
							revision: h.revision,
							target: h.target,
						})),
					],
					sourceHits: [
						...state.searchResult.sourceHits,
						...result.sourceHits.map((h) => ({
							path: h.path,
							displayTitle: `${h.sourcePath}:${h.line}`,
							kind: "source_file" as WikiNodeKind,
							matchedField: h.matchedField,
							matchType: h.matchType,
							normalizedScore: h.normalizedScore,
							snippet: h.text,
							revision: 0,
							target: h.target,
						})),
					],
					cursor: result.cursor,
					hasMore: result.hasMore,
					truncated: result.truncated,
				}
				: null,
		}));
	},

	clearSearch: () => set({
		searchResult: null,
		lastSearchParams: null,
		searchError: null,
	}),

	createChild: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Create", input, addError);
		if (result) {
			// 失效父 branch 缓存,触发重拉。
			get()._applyNodeEvent({ path: result.path, op: "create", parentPath: input.parent });
		}
		return result;
	},

	updateNode: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Update", input, addError);
		if (result) {
			// 失效该节点 detail/relations/source + 父 branch(summary 可能变)。
			get()._applyNodeEvent({ path: result.path, op: "update", parentPath: pathParent(result.path) ?? undefined });
		}
		return result;
	},

	deleteNode: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Delete", input, addError);
		if (result) {
			get()._applyNodeEvent({ path: input.address, op: "delete", parentPath: pathParent(input.address) ?? undefined });
		}
		return result;
	},

	moveNode: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Move", input, addError);
		if (result) {
			// move event: oldPath 失效 + newPath parent 刷新。
			get()._applyNodeEvent({
				path: result.path,
				op: "move",
				oldPath: input.address,
				parentPath: input.newParent,
			});
		}
		return result;
	},

	linkNodes: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Link", input, addError);
		if (result) {
			// 失效 source + target 的 relations 缓存。
			set((s) => {
				const relationsByPath = { ...s.relationsByPath };
				delete relationsByPath[input.source];
				delete relationsByPath[input.target];
				return { relationsByPath };
			});
		}
		return result;
	},

	unlinkNodes: async (input) => {
		const addError = useNotificationStore.getState().addError;
		const result = await callV2<WikiMutationResult>("wikiV2Unlink", input, addError);
		if (result) {
			set((s) => {
				const relationsByPath = { ...s.relationsByPath };
				delete relationsByPath[input.source];
				delete relationsByPath[input.target];
				return { relationsByPath };
			});
		}
		return result;
	},

	readWorkspaceDoc: async (projectId, relPath) => {
		try {
			return await api().wikiV2ReadWorkspaceDoc(projectId, relPath);
		} catch (err: any) {
			return { error: err?.message || "Failed to read workspace doc" };
		}
	},

	_applyNodeEvent: (event) => {
		// plan-06 §7 增量同步:
		//   - create/update/delete/move → 失效受影响父 branch + 该节点 detail。
		//   - move 额外:清 oldPath 整棵子树缓存,刷 old/new parent。
		//   - 未展开 branch 不主动拉取(只删它的 stale summary;等下次展开拿最新)。
		const { path, op, oldPath, parentPath } = event;
		// 抓快照:set() 内会 delete childrenLoaded[parentPath],若 set() 后再读
		// state.childrenLoaded[parentPath] 恒为 undefined → 永远走 no-op 分支,
		// 父 branch 不会被重新拉,UI 显示 stale children 直到用户手动刷新。
		// 在 set() 前抓 wasParentLoaded 快照,set() 后用它决定是否 re-fetch。
		const pre = get();
		const wasParentLoaded = !!(parentPath && parentPath !== path && pre.childrenLoaded[parentPath] !== undefined);
		set((s) => {
			const childrenLoaded = { ...s.childrenLoaded };
			const childrenByPath = { ...s.childrenByPath };
			const loadingChildren = { ...s.loadingChildren };
			const detailByPath = { ...s.detailByPath };
			const relationsByPath = { ...s.relationsByPath };
			const sourceByPath = { ...s.sourceByPath };
			const summaryByPath = { ...s.summaryByPath };

			// 该节点自己的 detail/relations/source/summary 失效(structural change)。
			delete detailByPath[path];
			delete relationsByPath[path];
			delete sourceByPath[path];

			if (op === "delete") {
				// 删该节点 + 子树所有缓存。
				delete summaryByPath[path];
				delete childrenByPath[path];
				delete childrenLoaded[path];
				for (const childPath of Object.keys(childrenByPath)) {
					if (isSameOrDescendant(path, childPath)) {
						delete childrenByPath[childPath];
						delete childrenLoaded[childPath];
						delete summaryByPath[childPath];
						delete detailByPath[childPath];
					}
				}
			} else if (op === "move" && oldPath) {
				// 清 oldPath 缓存;newPath 自己稍后由 expandPath 拉取。
				delete childrenByPath[oldPath];
				delete childrenLoaded[oldPath];
				delete summaryByPath[oldPath];
				delete detailByPath[oldPath];
				for (const childPath of Object.keys(childrenByPath)) {
					if (isSameOrDescendant(oldPath, childPath)) {
						delete childrenByPath[childPath];
						delete childrenLoaded[childPath];
						delete summaryByPath[childPath];
						delete detailByPath[childPath];
					}
				}
			}

			// 失效父 branch children 缓存,让下次 expand 重拉最新。
			if (parentPath && parentPath !== path) {
				delete childrenByPath[parentPath];
				delete childrenLoaded[parentPath];
				delete loadingChildren[parentPath];
			}
			// move 的源父也要刷新。
			if (op === "move" && oldPath) {
				const oldParent = pathParent(oldPath);
				if (oldParent && oldParent !== parentPath) {
					delete childrenByPath[oldParent];
					delete childrenLoaded[oldParent];
					delete loadingChildren[oldParent];
				}
			}

			return {
				childrenLoaded, childrenByPath, loadingChildren,
				detailByPath, relationsByPath, sourceByPath, summaryByPath,
			};
		});

		// 重新拉失效的父 branch(只在原本已 loaded 时拉,未 loaded 不管)。
		// wasParentLoaded 是 set() 前的快照 —— 见上方注释。
		if (wasParentLoaded) {
			void get().expandPath(parentPath!, { reset: true });
		}
	},
}));

// ---------------------------------------------------------------------------
// data:changed subscriptions (plan-06 §7)
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
	api()?.onDataChanged((e: { collection: string; changes?: Array<{ id: string; op: string; record?: any }> }) => {
		const collection = e.collection;
		if (collection !== "wiki_nodes" && collection !== "wiki_links" && collection !== "wiki_sync") {
			return;
		}
		const s = useWikiStore.getState();
		for (const c of e.changes ?? []) {
			const rec = c.record ?? {};
			if (collection === "wiki_nodes") {
				// id = canonical path; record = { path, op, revision, oldPath?, parentPath? }
				s._applyNodeEvent({
					path: rec.path ?? c.id,
					op: rec.op ?? c.op,
					oldPath: rec.oldPath ?? null,
					parentPath: rec.parentPath ?? null,
				});
			} else if (collection === "wiki_links") {
				// 失效两端节点的 relations 缓存(下次访问重拉)。
				const source = rec.source;
				const target = rec.target;
				if (typeof source === "string" || typeof target === "string") {
					useWikiStore.setState((st) => {
						const relationsByPath = { ...st.relationsByPath };
						if (typeof source === "string") delete relationsByPath[source];
						if (typeof target === "string") delete relationsByPath[target];
						return { relationsByPath };
					});
				}
			} else if (collection === "wiki_sync") {
				// wiki_sync:subtree path rewrite(move)。失效受影响路径整树缓存。
				const newPath = rec.path;
				const oldPath = rec.oldPath;
				if (typeof newPath === "string") {
					s._applyNodeEvent({
						path: newPath,
						op: "move",
						oldPath: typeof oldPath === "string" ? oldPath : null,
						parentPath: null,
					});
				}
			}
		}
	});
}
