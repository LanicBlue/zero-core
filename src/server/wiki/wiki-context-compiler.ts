// Wiki Context → system section 编译器(wiki-system-redesign plan-05 §6)
//
// # 文件说明书
//
// ## 核心功能
// 把 AgentRecord.wikiContext 条目 + compiled access + token budgets 编译为
// 一个缓存的 system section(`## Wiki Context`),由 AgentService 作为通用
// DynamicSystemSection 注入 SessionConfig,AgentLoop 只消费通用 section 数组。
//
// ## 输出布局(plan-05 §6 / design.md §9.2)
// ```text
// ## Wiki Context
//
// Available addresses:
// - memory://  → your long-term memory (root summary)
// - project:// → active project semantic map (root summary)
//
// ### Agent Memory
// - root summary 中的稳定规则
// - durability=permanent/long_term 的高价值记忆
// - preference/procedure/experience 代表节点
// - 最近更新 / 当前 work 相关
// - 一级导航(必要二级候选)
//
// ### Active Project
// - 目标 / 技术栈 / branch / indexed revision / sync status
// - 入口 / 主要模块
// - 关键目录 summaries
// - capabilities / constraints / risks / recent changes
// - 当前 work 候选
//
// ### Retrieval guidance
// 先 search 定位,再 expand 了解结构,最后 read 正文或 source。
// ```
//
// ## 关键不变量(plan-05 §6 / acceptance-05 §C)
//   - **preview 与 runtime 同函数**(字节级一致;禁止复制一套近似渲染)。
//   - **不依赖固定子树名**(如 preferences/lessons)—— 按 attributes.memory_type
//     / durability / confidence 选,而不是路径段名。
//   - **截断顺序固定**(plan-05 §6 表):
//       地址/检索指引 → 根稳定规则 → permanent/long_term preference/procedure
//       → Project 目标/约束/sync → 当前 work 相关 → 近期高价值 → 导航补充
//   - **类内排序固定 tuple**:(priority DESC, durability rank, confidence DESC,
//     updated_at DESC, canonical path ASC)。priority 是 attributes.priority
//     (0-100,可选);durability rank: permanent > long_term > short_term。
//   - **超预算输出 truncated marker + 统计**(便于 UI preview 与 audit)。
//   - **compiler 不在 AgentLoop**(plan-05 §6 + feedback-agent-loop-hooks-only)。
//     AgentService 在 session build / hot-reload 时调用本 compiler,把结果包装
//     成 `{name:'wiki-context', compute, cacheBreak:false}` 通用 section 注入。
//
// ## 不做(明确)
//   - 不写 Wiki(authz 在 WikiService / Wiki tool);只读快照。
//   - 不依赖短 ID / nodeId / 旧 anchor(全部 canonical path + 逻辑地址)。
//   - 不为 0 节点 / 无 active project 时硬编码全树;空状态输出 empty marker。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md §6
//   - docs/plan/wiki-system-redesign/design.md §9.2

import type { WikiService } from "./wiki-service.js";
import type { CompiledWikiAccess } from "../../shared/wiki-types.js";
import type { WikiContextEntry } from "../../shared/types.js";
import {
	WIKI_ROOT_PATH,
	normalizeWikiPath,
} from "./wiki-path.js";

// ---------------------------------------------------------------------------
// 常量:profile token 预算(来自 plan-05 §6 表)
// ---------------------------------------------------------------------------

interface ProfileBudget {
	memory: number;
	project: number;
	addresses: number;
}

const PROFILE_BUDGETS: Record<WikiContextEntry["profile"], ProfileBudget> = {
	compact: { memory: 800, project: 1200, addresses: 300 },
	standard: { memory: 1800, project: 2800, addresses: 400 },
	deep: { memory: 3500, project: 5000, addresses: 500 },
};

/**
 * Memory durability 排序 rank(永久 > 长期 > 短期 > 未标)。
 * 用于类内排序 tuple 的第 2 元素(permanent 最先)。
 */
const DURABILITY_RANK: Record<string, number> = {
	permanent: 0,
	long_term: 1,
	short_term: 2,
};

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 编译输入。AgentService 在 session build / hot-reload 时构造。
 */
export interface CompileWikiContextOpts {
	/** sub-02 WikiService —— 用于读 memory root / project root / children。 */
	readonly wikiService: WikiService;
	/** Host 注入的编译后访问上下文(权威 grants 来源)。 */
	readonly access: CompiledWikiAccess;
	/** AgentRecord.wikiContext 条目(显式配置;未配则用默认 standard)。 */
	readonly entries: WikiContextEntry[];
	/**
	 * 可选当前 work context 候选(AgentService 注入):活跃 requirement id /
	 * recent file paths / task description。Project profile 用它筛"当前 work
	 * 相关"节点。可省略(非 work session)。
	 */
	readonly workContext?: {
		requirementId?: string;
		recentFiles?: string[];
		taskDescription?: string;
	};
}

/**
 * Memory / Project 子树节点快照(已读取 + 已按授权过滤)。
 *
 * 由 fetchSubtreeSnapshot 内部使用,compiler 不直接查 wiki.db。
 */
interface SubtreeNodeSnapshot {
	path: string;
	name: string;
	summary: string;
	updated_at: string;
	memory_type?: string;
	durability?: "permanent" | "long_term" | "short_term";
	confidence?: number;
	priority?: number;
	childrenCount: number;
}

/**
 * 编译输出(可直接作为 DynamicSystemSection.compute 的返回)。
 */
export interface CompiledWikiContextSection {
	/** 渲染后的 system section 文本(空 → section 被 SystemPromptAssembler 丢)。 */
	text: string;
	/** 截断统计(AgentService 可记日志 / 返给 UI preview)。 */
	stats: {
		memoryNodesTotal: number;
		memoryNodesIncluded: number;
		memoryNodesDropped: number;
		projectNodesTotal: number;
		projectNodesIncluded: number;
		projectNodesDropped: number;
		memoryTokensUsed: number;
		projectTokensUsed: number;
		truncated: boolean;
	};
	/** 输入快照 revision(plan-05 §7 hot-reload 检测变化用)。 */
	snapshot: {
		memoryRevision: number | null;
		projectRevision: number | null;
		policyRevision: number;
	};
}

/**
 * 编译 Wiki Context system section。
 *
 * 幂等 + 确定性:同输入快照 → 同输出字节级一致(acceptance-05 §C)。
 */
export async function compileWikiContext(opts: CompileWikiContextOpts): Promise<CompiledWikiContextSection> {
	const { wikiService, access, workContext } = opts;
	const entries = opts.entries.length > 0 ? opts.entries : [];

	// 决定每类 profile:取首条匹配的 entry 的 profile;无 entry → standard。
	const memoryEntry = entries.find((e) => e.address.startsWith("memory://"));
	const projectEntry = entries.find((e) => e.address.startsWith("project://")) ?? entries.find((e) => e.address === "project://");
	const memoryProfile = memoryEntry?.profile ?? "standard";
	const projectProfile = projectEntry?.profile ?? "standard";
	const memoryBudget = memoryEntry?.budgetTokens ?? PROFILE_BUDGETS[memoryProfile].memory;
	const projectBudget = projectEntry?.budgetTokens ?? PROFILE_BUDGETS[projectProfile].project;
	const addressesBudget = PROFILE_BUDGETS[memoryProfile].addresses;

	// 收集 available addresses(用于头部)。
	const addressLines = collectAddressLines(entries, access, workContext);

	// 解析 memory root canonical path(wiki-root/memory/<agentId>)。
	const memoryRootPath = `${WIKI_ROOT_PATH}/memory/${access.agentId}`;
	const projectRootPath = access.activeProjectId
		? `${WIKI_ROOT_PATH}/projects/${access.activeProjectId}`
		: null;

	// 读 memory / project 子树快照(若 agent 无 grant 看到该子树,fetch 返空)。
	const memorySnapshot = await fetchSubtreeSnapshot(wikiService, access, memoryRootPath);
	const projectSnapshot = projectRootPath
		? await fetchSubtreeSnapshot(wikiService, access, projectRootPath)
		: { root: null, children: [], total: 0, maxRevision: null };

	// 渲染 + 截断。
	const memoryRender = renderMemorySection(memorySnapshot, memoryProfile, memoryBudget, workContext);
	const projectRender = projectRootPath
		? renderProjectSection(projectSnapshot, projectProfile, projectBudget, workContext)
		: renderEmptyProjectSection();
	const addressesRender = renderAddressesSection(addressLines, addressesBudget);
	const retrievalGuidance = renderRetrievalGuidance();

	// 组装最终文本。截断顺序按 plan-05 §6 表(地址/检索 → 根规则 → …)。
	const lines: string[] = [];
	lines.push("## Wiki Context");
	lines.push("");
	if (addressesRender) {
		lines.push(addressesRender);
		lines.push("");
	}
	if (memoryRender.text) {
		lines.push(memoryRender.text);
		lines.push("");
	}
	if (projectRender.text) {
		lines.push(projectRender.text);
		lines.push("");
	}
	lines.push(retrievalGuidance);

	const text = lines.join("\n").trim();
	return {
		text,
		stats: {
			memoryNodesTotal: memorySnapshot.total,
			memoryNodesIncluded: memoryRender.included,
			memoryNodesDropped: memorySnapshot.total - memoryRender.included,
			projectNodesTotal: projectSnapshot.total,
			projectNodesIncluded: projectRender.included,
			projectNodesDropped: projectSnapshot.total - projectRender.included,
			memoryTokensUsed: memoryRender.tokensUsed,
			projectTokensUsed: projectRender.tokensUsed,
			truncated: memoryRender.truncated || projectRender.truncated,
		},
		snapshot: {
			memoryRevision: memorySnapshot.maxRevision,
			projectRevision: projectSnapshot.maxRevision,
			policyRevision: access.policyRevision,
		},
	};
}

// ---------------------------------------------------------------------------
// 内部:地址段
// ---------------------------------------------------------------------------

function collectAddressLines(
	entries: WikiContextEntry[],
	access: CompiledWikiAccess,
	_workContext: CompileWikiContextOpts["workContext"],
): Array<{ address: string; hint: string }> {
	const out: Array<{ address: string; hint: string }> = [];
	const seen = new Set<string>();
	// 入口显式声明的地址。
	for (const e of entries) {
		if (e.channel === "off") continue;
		if (seen.has(e.address)) continue;
		seen.add(e.address);
		out.push({ address: e.address, hint: hintFor(e.address, access) });
	}
	// 若 entries 为空,补默认两条(同 plan-05 §2 默认 context)。
	if (out.length === 0) {
		out.push({ address: "memory://", hint: hintFor("memory://", access) });
		if (access.activeProjectId) {
			out.push({ address: "project://", hint: hintFor("project://", access) });
		}
	}
	return out;
}

function hintFor(address: string, access: CompiledWikiAccess): string {
	if (address.startsWith("memory://")) {
		return `your long-term memory (wiki-root/memory/${access.agentId})`;
	}
	if (address.startsWith("project://")) {
		return access.activeProjectId
			? `active project semantic map (wiki-root/projects/${access.activeProjectId})`
			: "inactive — no active project";
	}
	if (address.startsWith("runtime://")) {
		return "administrator-registered alias";
	}
	if (address.startsWith("wiki-root/")) {
		return `canonical path (${address})`;
	}
	return address;
}

function renderAddressesSection(lines: Array<{ address: string; hint: string }>, budgetTokens: number): string {
	if (lines.length === 0) return "";
	const out: string[] = ["Available addresses:"];
	let used = estimateTokens(out.join("\n"));
	for (const l of lines) {
		const line = `- \`${l.address}\` → ${l.hint}`;
		const lineTokens = estimateTokens(line);
		if (used + lineTokens > budgetTokens) break;
		out.push(line);
		used += lineTokens;
	}
	return out.join("\n");
}

function renderRetrievalGuidance(): string {
	return [
		"### Retrieval guidance",
		"Use `search` to locate candidates, `expand` to see direct children, then `read` to load content/links/source. Avoid blind `read` of deep paths you haven't expanded.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// 内部:子树快照 fetch
// ---------------------------------------------------------------------------

interface SubtreeSnapshot {
	root: {
		path: string;
		summary: string;
		content: string;
		revision: number;
		updated_at: string;
		memory_type?: string;
		durability?: "permanent" | "long_term" | "short_term";
		confidence?: number;
		priority?: number;
	} | null;
	children: SubtreeNodeSnapshot[];
	total: number;
	maxRevision: number | null;
}

async function fetchSubtreeSnapshot(
	wikiService: WikiService,
	access: CompiledWikiAccess,
	rootPath: string,
): Promise<SubtreeSnapshot> {
	// WikiRequestContext 必须由调用方构造 —— 这里复用 access 编译最小 ctx。
	// WikiService.expand/read 的授权检查会按 access.grants 决定可见性。
	const ctx = {
		access,
		agentId: access.agentId,
		activeProjectId: access.activeProjectId,
		sessionId: null,
		requestId: null,
	};
	try {
		// 读 root。
		const rootRead = await wikiService.read({
			address: rootPath,
			view: "all",
		}, ctx);
		const root = rootRead.node;
		// 读 children(分页,第一页 50 个 —— 普通场景够用;deep profile 可扩)。
		const expandResult = await wikiService.expand({
			address: rootPath,
			limit: 100,
			cursor: null,
			includeLinks: false,
		}, ctx);
		const children: SubtreeNodeSnapshot[] = await Promise.all(
			expandResult.children.items.map(async (c) => {
				// 单次 read 以拿 updated_at + attributes(memory_type / durability / ...)。
				// 对大子树有 N+1 风险 —— 但 wiki-context 是缓存段,每 session 一次,
				// 不是 hot path;后续可优化为 batched read。
				try {
					const detail = await wikiService.read({
						address: c.path, view: "summary",
					}, ctx);
					return {
						path: c.path,
						name: c.name,
						summary: c.summary,
						updated_at: detail.node.updatedAt,
						memory_type: detail.node.attributes.memory_type,
						durability: detail.node.attributes.durability,
						confidence: detail.node.attributes.confidence,
						priority: typeof detail.node.attributes.priority === "number"
							? detail.node.attributes.priority
							: undefined,
						childrenCount: 0, // 单 read 不查孙;仅按一级 children 渲染
					};
				} catch {
					return {
						path: c.path, name: c.name, summary: c.summary,
						updated_at: c.revision.toString(), // fallback
						childrenCount: 0,
					};
				}
			}),
		);
		const revs = [root.revision, ...children.map((c) => safeParseInt(c.updated_at))]
			.filter((r): r is number => r !== null && Number.isFinite(r));
		return {
			root: {
				path: root.path,
				summary: root.summary,
				content: rootRead.content ?? "",
				revision: root.revision,
				updated_at: root.updatedAt,
				memory_type: root.attributes.memory_type,
				durability: root.attributes.durability,
				confidence: root.attributes.confidence,
				priority: typeof root.attributes.priority === "number"
					? root.attributes.priority
					: undefined,
			},
			children,
			total: children.length,
			maxRevision: revs.length > 0 ? Math.max(...revs) : null,
		};
	} catch {
		// root 不存在 / 无权限 → 空 snapshot(不抛)。
		return { root: null, children: [], total: 0, maxRevision: null };
	}
}

function safeParseInt(s: string | undefined): number | null {
	if (!s) return null;
	// ISO timestamp → 取 ms;纯数字 → parseInt。
	const n = Number(s);
	if (Number.isFinite(n)) return n;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// 内部:Memory section 渲染(standard profile)
// ---------------------------------------------------------------------------

interface SectionRenderResult {
	text: string;
	included: number;
	tokensUsed: number;
	truncated: boolean;
}

function renderMemorySection(
	snapshot: SubtreeSnapshot,
	_profile: WikiContextEntry["profile"],
	budgetTokens: number,
	_workContext: CompileWikiContextOpts["workContext"],
): SectionRenderResult {
	if (!snapshot.root) {
		return { text: "", included: 0, tokensUsed: 0, truncated: false };
	}

	// 类内排序:priority DESC > durability rank ASC > confidence DESC > updated_at DESC > path ASC
	const sorted = [...snapshot.children].sort(compareMemoryNodes);
	const headerLines = [
		"### Agent Memory",
		`Root: \`${snapshot.root.path}\``,
	];
	if (snapshot.root.summary) {
		headerLines.push(`Summary: ${truncate(snapshot.root.summary, 600)}`);
	}
	const headerText = headerLines.join("\n");
	let used = estimateTokens(headerText);
	const out: string[] = [headerText];
	let included = 0;
	let truncated = false;

	for (const node of sorted) {
		const line = formatMemoryNodeLine(node);
		const tokens = estimateTokens(line);
		if (used + tokens > budgetTokens) {
			truncated = true;
			break;
		}
		out.push(line);
		used += tokens;
		included++;
	}

	if (snapshot.total > included) {
		out.push(`_(${snapshot.total - included} more memory nodes omitted — use Wiki search/expand to browse)_`);
	}

	return { text: out.join("\n"), included, tokensUsed: used, truncated };
}

function formatMemoryNodeLine(node: SubtreeNodeSnapshot): string {
	const tags: string[] = [];
	if (node.durability) tags.push(node.durability);
	if (node.memory_type) tags.push(node.memory_type);
	const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
	const summary = node.summary ? ` — ${truncate(node.summary, 200)}` : "";
	return `- \`${node.path}\`${tagStr}${summary}`;
}

function compareMemoryNodes(a: SubtreeNodeSnapshot, b: SubtreeNodeSnapshot): number {
	// priority DESC(higher first)
	const pa = typeof a.priority === "number" ? a.priority : 0;
	const pb = typeof b.priority === "number" ? b.priority : 0;
	if (pa !== pb) return pb - pa;
	// durability: permanent(0) > long_term(1) > short_term(2) > unknown(3)
	const da = DURABILITY_RANK[a.durability ?? ""] ?? 3;
	const db = DURABILITY_RANK[b.durability ?? ""] ?? 3;
	if (da !== db) return da - db;
	// confidence DESC
	const ca = typeof a.confidence === "number" ? a.confidence : 0;
	const cb = typeof b.confidence === "number" ? b.confidence : 0;
	if (ca !== cb) return cb - ca;
	// updated_at DESC
	const ua = safeParseInt(a.updated_at) ?? 0;
	const ub = safeParseInt(b.updated_at) ?? 0;
	if (ua !== ub) return ub - ua;
	// canonical path ASC
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 内部:Project section 渲染
// ---------------------------------------------------------------------------

function renderProjectSection(
	snapshot: SubtreeSnapshot,
	_profile: WikiContextEntry["profile"],
	budgetTokens: number,
	_workContext: CompileWikiContextOpts["workContext"],
): SectionRenderResult {
	if (!snapshot.root) {
		return renderEmptyProjectSection();
	}

	const headerLines = [
		"### Active Project",
		`Root: \`${snapshot.root.path}\``,
	];
	if (snapshot.root.summary) {
		headerLines.push(`Summary: ${truncate(snapshot.root.summary, 800)}`);
	}
	const headerText = headerLines.join("\n");
	let used = estimateTokens(headerText);
	const out: string[] = [headerText];
	let included = 0;
	let truncated = false;

	const sorted = [...snapshot.children].sort(compareProjectNodes);
	for (const node of sorted) {
		const line = formatProjectNodeLine(node);
		const tokens = estimateTokens(line);
		if (used + tokens > budgetTokens) {
			truncated = true;
			break;
		}
		out.push(line);
		used += tokens;
		included++;
	}

	if (snapshot.total > included) {
		out.push(`_(${snapshot.total - included} more project nodes omitted — use Wiki search/expand to browse)_`);
	}

	return { text: out.join("\n"), included, tokensUsed: used, truncated };
}

function renderEmptyProjectSection(): SectionRenderResult {
	return {
		text: "### Active Project\n_No active project in session — project:// addresses are inactive._",
		included: 0,
		tokensUsed: 0,
		truncated: false,
	};
}

function formatProjectNodeLine(node: SubtreeNodeSnapshot): string {
	const summary = node.summary ? ` — ${truncate(node.summary, 200)}` : "";
	const childMarker = node.childrenCount > 0 ? ` ▾${node.childrenCount}` : " leaf";
	return `- \`${node.path}\`${childMarker}${summary}`;
}

function compareProjectNodes(a: SubtreeNodeSnapshot, b: SubtreeNodeSnapshot): number {
	// Project 类内排序:priority DESC > confidence DESC > updated_at DESC > path ASC
	// (无 durability —— durability 是 Memory 概念)
	const pa = typeof a.priority === "number" ? a.priority : 0;
	const pb = typeof b.priority === "number" ? b.priority : 0;
	if (pa !== pb) return pb - pa;
	const ca = typeof a.confidence === "number" ? a.confidence : 0;
	const cb = typeof b.confidence === "number" ? b.confidence : 0;
	if (ca !== cb) return cb - ca;
	const ua = safeParseInt(a.updated_at) ?? 0;
	const ub = safeParseInt(b.updated_at) ?? 0;
	if (ua !== ub) return ub - ua;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 内部:小工具
// ---------------------------------------------------------------------------

/** 估算 token:粗略 chars/4。acceptance 不要求精确,只要求稳定可比。 */
function estimateTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / 4);
}

/** 截断字符串到大约 maxChars,加省略号。 */
function truncate(s: string, maxChars: number): string {
	if (!s) return "";
	if (s.length <= maxChars) return s;
	return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

/** 重新导出 normalizeWikiPath 便于 AgentService 在 publish 时校验路径。 */
export { normalizeWikiPath };
