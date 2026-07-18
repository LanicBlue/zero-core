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
// - root summary + 稳定规则(从 root content 截取)
// - durability=permanent/long_term 的高价值记忆
// - preference/procedure/experience 代表节点
// - 最近更新 / 当前 work 相关(workContext boost)
// - 一级导航(必要二级候选;deep profile bounded 2nd-level)
//
// ### Active Project
// - 目标 / 技术栈 / 入口 / 模块 / 风险 / 约束(缺省显式 (none recorded))
// - Repo binding:branch / indexed_revision / sync_status / last_error / last_indexed_at
// - 关键目录 summaries / 当前 work 候选
// - deep profile:key-module 2nd-level candidates + recent changes
//
// ### Retrieval guidance
// 先 search 定位,再 expand 了解结构,最后 read 正文或 source。
// ```
//
// ## 关键不变量(plan-05 §6 / acceptance-05 §C)
//   - **preview 与 runtime 同函数**(字节级一致;禁止复制一套近似渲染)。
//     compiler 需要的额外输入(repo binding)从注入的 wikiService 自取,caller
//     无法分叉。workContext 是唯一故意 caller-difference(runtime 注入真实
//     recent files/requirement;preview 注入 undefined 或 UI 提供)。
//   - **profile 决定 selection depth**(不只 token budget):
//       compact / standard / deep 各有不同的 filter + 2nd-level expand 行为。
//   - **不依赖固定子树名**(如 preferences/lessons)—— 按 attributes.memory_type
//     / durability / confidence 选,而不是路径段名。
//   - **截断管道固定**(filter → boost → sort → truncate):
//       1. filter:archived / 低置信假设(compact+standard) / profile durability / project compact-no-children
//       2. boost:workContext 命中 → workHit 置顶
//       3. sort:(workHit DESC, priority DESC, durability rank, confidence DESC,
//              [memory-only] due demoted, updated_at DESC, path ASC)
//       4. truncate:超预算停止,补 truncated marker
//   - **revision 语义干净**:snapshot.maxRevision = max(visible nodes' revision
//     integers) —— 绝不把 updated_at 时间戳当 revision 解析(defect #8 修复)。
//     staleness 时间戳单独走 snapshot.maxUpdatedAt。
//   - **stats 真实**:memoryNodesTotal / projectNodesTotal = 直接 children TRUE
//     计数(via WikiService.listContextCandidates,authz-gated);*Dropped = total
//     − included;truncated true iff included < total。selectionTruncated
//     true iff 父节点下 active 直接 children > LIST_CONTEXT_CANDIDATES_SCAN_CAP
//     (round-2 review P1 §4,query 前的 candidate 集截断,与 token 预算截断独立)。
//   - **超预算输出 truncated marker + 统计**(便于 UI preview 与 audit)。
//   - **compiler 不在 AgentLoop**(plan-05 §6 + feedback-agent-loop-hooks-only)。
//     AgentService 在 session build / hot-reload 时调用本 compiler,把结果包装
//     成 `{name:'wiki-context', compute, cacheBreak:false}` 通用 section 注入。
//
// ## 不做(明确)
//   - 不写 Wiki(authz 在 WikiService / Wiki tool);只读快照。
//   - 不依赖短 ID / nodeId / 旧 anchor(全部 canonical path + 逻辑地址)。
//   - 不为 0 节点 / 无 active project 时硬编码全树;空状态输出 empty marker。
//   - 不发明 task_state(不存在);只处理 review_after(真实 attribute)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md §6
//   - docs/plan/wiki-system-redesign/design.md §9.2

import type { WikiService } from "./wiki-service.js";
import type {
	CompiledWikiAccess,
	WikiNodeAttributes,
	WikiRequestContext,
} from "../../shared/wiki-types.js";
import type { WikiContextEntry } from "../../shared/types.js";
import type { WikiRepositoryRow } from "./wiki-repository-store.js";
import {
	WIKI_ROOT_PATH,
	normalizeWikiPath,
} from "./wiki-path.js";
import {
	manifestStatusFromAttrs,
	type ProjectManifestStatus,
} from "./wiki-manifest.js";

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
 * 用于类内排序 tuple 的 durability 元素(permanent 最先)。
 */
const DURABILITY_RANK: Record<string, number> = {
	permanent: 0,
	long_term: 1,
	short_term: 2,
};

/**
 * 低置信假设的 confidence 阈值(plan-05 §6 filter rule 2)。
 * compact/standard profile 排除低于此值的 hypothesis-type 节点;deep profile
 * 保留并加 "(low confidence)" marker。
 */
const LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * 指示"假设/不确定"的 memory_type 闭集(小写)。confidence 低于阈值且
 * memory_type 命中此集合 → 视为低置信假设(compact/standard 排除)。
 * memory_type 未设置时,confidence 单独决定(defect #5 修复)。
 */
const HYPOTHESIS_MEMORY_TYPES = new Set([
	"hypothesis",
	"assumption",
	"guess",
	"tentative",
	"uncertain",
	"draft",
	"speculation",
	"conjecture",
	"hypothetical",
]);

/** Root content "Stable rules" 段最大字符数(defect #4 修复)。 */
const ROOT_CONTENT_BUDGET_CHARS = 800;

/** Root summary 最大字符数。 */
const ROOT_SUMMARY_BUDGET_CHARS = 600;

/** Deep profile:top-N children 做 2nd-level expand(plan-05 §6 deep 行)。 */
const DEEP_EXPAND_TOP_CHILDREN = 5;

/** Deep profile:每个 top child expand 的 grandchild 第一页上限。 */
const DEEP_EXPAND_GRANDCHILDREN_LIMIT = 10;

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 编译输入。AgentService 在 session build / hot-reload 时构造;preview 走
 * wiki-admin-router 同样构造。二者必须传一致形状(除 workContext 故意分叉)。
 */
export interface CompileWikiContextOpts {
	/** sub-02 WikiService —— 读 memory root / project root / children / repo binding / count。 */
	readonly wikiService: WikiService;
	/** Host 注入的编译后访问上下文(权威 grants 来源)。 */
	readonly access: CompiledWikiAccess;
	/** AgentRecord.wikiContext 条目(显式配置;未配则用默认 standard)。 */
	readonly entries: WikiContextEntry[];
	/**
	 * 可选当前 work context(AgentService 注入):活跃 requirement id /
	 * recent file paths / task description。命中路径/名/摘要的节点获 workHit
	 * 排序置顶。可省略(preview / 非 work session)。
	 */
	readonly workContext?: {
		requirementId?: string;
		recentFiles?: string[];
		taskDescription?: string;
	};
	/**
	 * 可选"现在"用于 review_after due 判定(ISO ≤ now → due)。默认 new Date()。
	 * 测试注入固定 Date 以保证确定性。生产路径默认即可,review_after 比较对
	 * 毫秒级漂移不敏感(只要 ≤ now 即 due)。
	 */
	readonly now?: Date;
}

/** Profile 公共别名(compact/standard/deep)。 */
type Profile = WikiContextEntry["profile"];

/** WorkContext 私有别名(从 opts 派生,不暴露新公共类型)。 */
type WorkContext = NonNullable<CompileWikiContextOpts["workContext"]>;

/**
 * Memory / Project 子树节点快照(已读取;authz 已由 wikiService.expand/read 门外过滤)。
 */
interface SubtreeNodeSnapshot {
	path: string;
	name: string;
	summary: string;
	/** 节点 revision(整数,来自 expand)。用于 snapshot.maxRevision。 */
	revision: number;
	/** ISO updated_at(来自 read summary;expand 不带 updated_at)。 */
	updated_at: string;
	memory_type?: string;
	durability?: "permanent" | "long_term" | "short_term";
	confidence?: number;
	priority?: number;
	/** ISO 复核时间;null = 未设。≤ now 视为 due。 */
	review_after: string | null;
	/** 直接 children 真实计数(via WikiService.countActiveChildren)。 */
	childrenCount: number;
}

/**
 * Root 快照(多带 content + 完整 attributes,用于 stable rules 渲染 + Project
 * structured fields)。
 */
interface SubtreeRootSnapshot {
	path: string;
	summary: string;
	content: string;
	revision: number;
	updated_at: string;
	memory_type?: string;
	durability?: "permanent" | "long_term" | "short_term";
	confidence?: number;
	priority?: number;
	attributes: WikiNodeAttributes;
}

interface SubtreeSnapshot {
	root: SubtreeRootSnapshot | null;
	children: SubtreeNodeSnapshot[];
	/** 直接 children 真实总数(via listContextCandidates;非首页长度)。 */
	total: number;
	/**
	 * candidate 选择是否被 SCAN CAP 截断(round-2 review P1 §4.3.7)。
	 * true = 父节点下 active 直接 children > LIST_CONTEXT_CANDIDATES_SCAN_CAP
	 * (5000),candidate 集被裁剪到首 N 个,filter→boost→sort 仍跑但有偏。
	 * 现实子树(几百 children)永不触顶;只有 pathological parent 才为真。
	 * true 时渲染段渲染显式 truncated-marker,提示 agent / UI。
	 */
	selectionTruncated: boolean;
	/** max(visible nodes' revision) —— 整数,绝不混 updated_at。 */
	maxRevision: number | null;
	/** max(visible nodes' updated_at ISO) —— 独立 staleness 信号。 */
	maxUpdatedAt: string | null;
}

/**
 * 已 filter+boost 完毕的节点(渲染管线消费)。grandchildren 由 deep profile
 * 的 attachDeepGrandchildren 填充。
 */
interface PreparedNode extends SubtreeNodeSnapshot {
	/** workContext 命中 → 排序置顶(HIGHEST sort key,高于 priority)。 */
	workHit: boolean;
	/** review_after ISO ≤ now → 排序降级 + "(due for review)" marker。 */
	due: boolean;
	/** 低置信假设 → deep profile 渲染 "(low confidence)" marker。 */
	lowConfidence: boolean;
	/** Deep profile 2nd-level grandchildren(已 sort;空 = 未 attach / 无 child)。 */
	grandchildren: PreparedNode[];
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
		/**
		 * candidate 选择是否被 SCAN CAP 截断(round-2 review P1 §4)。
		 * true = memory 或 project 父节点下 active 直接 children >
		 * LIST_CONTEXT_CANDIDATES_SCAN_CAP(5000),candidate 集被裁剪到首 N 个。
		 * 现实子树永不触顶;pathological parent 才为真。true 时 render 段渲染
		 * 显式 truncated-marker。
		 */
		selectionTruncated: boolean;
	};
	/** 输入快照 revision(plan-05 §7 hot-reload 检测变化用)。 */
	snapshot: {
		memoryRevision: number | null;
		projectRevision: number | null;
		policyRevision: number;
		/**
		 * max updated_at ISO(across visible memory+project nodes)。独立的
		 * staleness 信号 —— 与 revision 解耦(defect #8 修复)。
		 */
		maxUpdatedAt: string | null;
	};
}

/**
 * 编译 Wiki Context system section。
 *
 * 幂等 + 确定性:同输入快照(+ 同 `now`)→ 同输出字节级一致(acceptance-05 §C)。
 */
export async function compileWikiContext(opts: CompileWikiContextOpts): Promise<CompiledWikiContextSection> {
	const { wikiService, access, workContext } = opts;
	const now = opts.now ?? new Date();
	const entries = opts.entries.length > 0 ? opts.entries : [];

	// 决定每类 profile:取首条匹配的 entry 的 profile;无 entry → standard。
	const memoryEntry = entries.find((e) => e.address.startsWith("memory://"));
	const projectEntry = entries.find((e) => e.address.startsWith("project://")) ?? entries.find((e) => e.address === "project://");
	const memoryProfile: Profile = memoryEntry?.profile ?? "standard";
	const projectProfile: Profile = projectEntry?.profile ?? "standard";
	const memoryBudget = memoryEntry?.budgetTokens ?? PROFILE_BUDGETS[memoryProfile].memory;
	const projectBudget = projectEntry?.budgetTokens ?? PROFILE_BUDGETS[projectProfile].project;
	const addressesBudget = PROFILE_BUDGETS[memoryProfile].addresses;

	// 收集 available addresses(用于头部)。
	const addressLines = collectAddressLines(entries, access, workContext);

	// 解析 memory root / project root canonical path。
	const memoryRootPath = `${WIKI_ROOT_PATH}/memory/${access.agentId}`;
	const projectRootPath = access.activeProjectId
		? `${WIKI_ROOT_PATH}/projects/${access.activeProjectId}`
		: null;

	// 读 memory / project 子树快照(若 agent 无 grant 看到该子树,fetch 返空)。
	const memorySnapshot = await fetchSubtreeSnapshot(wikiService, access, memoryRootPath);
	const projectSnapshot = projectRootPath
		? await fetchSubtreeSnapshot(wikiService, access, projectRootPath)
		: {
			root: null,
			children: [],
			total: 0,
			selectionTruncated: false,
			maxRevision: null,
			maxUpdatedAt: null,
		};

	// 读 Project repo binding(branch / indexed_revision / sync_status / ...)。
	// 在 compiler 内部从 wikiService 取 —— 保证 preview == runtime 字节级一致,
	// caller 无法分叉(defect #9 修复)。
	const projectBinding = projectRootPath && access.activeProjectId
		? safeGetRepositoryBinding(wikiService, access.activeProjectId)
		: undefined;

	// P1-5: 读 active project 子树下 source_stale 节点数(semantic-sync)。同样
	// 从 wikiService 内部取 —— preview == runtime(与 binding 同模型,caller 不
	// 分叉)。count > 0 时在 Project 段渲染显式提示,告知 agent 摘要可能滞后。
	const projectStaleCount = projectRootPath && access.activeProjectId
		? safeCountSourceStale(wikiService, access.activeProjectId)
		: 0;

	// 准备 children(filter → boost → sort)。Memory / Project 走不同 filter。
	const memoryPrepared = memorySnapshot.root
		? prepareMemoryChildren(memorySnapshot.children, memoryProfile, workContext, now)
		: [];
	const projectPrepared = projectSnapshot.root
		? prepareProjectChildren(projectSnapshot.children, workContext, now)
		: [];

	// Deep profile:bounded 2nd-level expand of top-priority children。
	// 在渲染前异步 attach grandchildren 到 PreparedNode 上(plan-05 §6 deep 行)。
	if (memoryProfile === "deep" && memorySnapshot.root) {
		await attachDeepGrandchildren(wikiService, access, memoryPrepared);
	}
	if (projectProfile === "deep" && projectSnapshot.root) {
		await attachDeepGrandchildren(wikiService, access, projectPrepared);
	}

	// 渲染 + 截断。
	const memoryRender = renderMemorySection(memorySnapshot, memoryPrepared, memoryBudget);
	const projectRender = projectRootPath
		? renderProjectSection(projectSnapshot, projectPrepared, projectProfile, projectBudget, projectBinding, projectStaleCount)
		: renderEmptyProjectSection();
	const addressesRender = renderAddressesSection(addressLines, addressesBudget);
	const retrievalGuidance = renderRetrievalGuidance();

	// 组装最终文本。
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
	const maxUpdatedAt = pickLaterIso(memorySnapshot.maxUpdatedAt, projectSnapshot.maxUpdatedAt);
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
			selectionTruncated: memorySnapshot.selectionTruncated || projectSnapshot.selectionTruncated,
		},
		snapshot: {
			memoryRevision: memorySnapshot.maxRevision,
			projectRevision: projectSnapshot.maxRevision,
			policyRevision: access.policyRevision,
			maxUpdatedAt,
		},
	};
}

// ---------------------------------------------------------------------------
// 内部:地址段(unchanged 行为)
// ---------------------------------------------------------------------------

function collectAddressLines(
	entries: WikiContextEntry[],
	access: CompiledWikiAccess,
	_workContext: WorkContext | undefined,
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

async function fetchSubtreeSnapshot(
	wikiService: WikiService,
	access: CompiledWikiAccess,
	rootPath: string,
): Promise<SubtreeSnapshot> {
	const ctx = makeRequestContext(access);
	try {
		// 读 root(content + attributes)。root read 不变 —— attributes_json 仍
		// 由 read 解析;root 不进 candidate 集。
		const rootRead = await wikiService.read({
			address: rootPath,
			view: "all",
		}, ctx);
		const root = rootRead.node;

		// 取 candidate 集(round-2 review P1 §4):替代旧 expand({limit:100}) +
		// per-node read + per-node countActiveChildren 三段式。
		//   - candidate 集 = 全量 active 直接 children(由 SCAN CAP 5000 封顶),
		//     消除首 100 bias —— 第 101+ 的高价值节点(如 priority=999 path-last
		//     `zzz-critical`)正常进 candidate 集,下游 filter→boost→sort 在无偏
		//     集合上跑。
		//   - 单条 bounded SELECT(全字段)+ 单条 grouped COUNT —— 消除 2× N+1,
		//     子树总查询数常数化(1 root read + 1 candidates SELECT + 1 grouped
		//     childrenCount COUNT,与 N 无关)。
		//   - 授权纪律与 expand/countActiveChildren 完全一致:resolveAddress +
		//     assertAgentAccess("expand") 在 service 内完成,失败抛 → 本 try/catch
		//     转空 snapshot,绝不泄露 total 或节点存在性。
		//   - selectionTruncated:true 表示父节点下 active 直接 children > SCAN
		//     CAP(pathological parent),candidate 集被裁剪到首 N 个。现实子树
		//     永不触顶。true 时 stats + render 显式提示。
		const candidatesResult = wikiService.listContextCandidates({ address: rootPath }, ctx);

		// 直接从 candidate 构造 SubtreeNodeSnapshot,字段名/类型完全一致 ——
		// prepareMemoryChildren / prepareProjectChildren 不需要改。
		const children: SubtreeNodeSnapshot[] = candidatesResult.candidates.map((c): SubtreeNodeSnapshot => ({
			path: c.path,
			name: c.name,
			summary: c.summary,
			revision: c.revision,
			updated_at: c.updated_at,
			memory_type: c.memory_type,
			durability: c.durability,
			confidence: c.confidence,
			priority: c.priority,
			review_after: c.review_after,
			childrenCount: c.childrenCount,
		}));

		// maxRevision:整数 ONLY(defect #8 修复)。绝不解析 updated_at 当 revision。
		const revisionInts = [root.revision, ...children.map((c) => c.revision)]
			.filter((r): r is number => Number.isFinite(r));
		const maxRevision = revisionInts.length > 0 ? Math.max(...revisionInts) : null;

		// maxUpdatedAt:独立的 staleness 信号(NEVER 混进 revision)。
		const updatedAts = [root.updatedAt, ...children.map((c) => c.updated_at)]
			.filter((s): s is string => typeof s === "string" && s.length > 0);
		const maxUpdatedAt = updatedAts.length > 0 ? updatedAts.reduce((a, b) => (a >= b ? a : b)) : null;

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
				attributes: root.attributes,
			},
			children,
			total: candidatesResult.total,
			selectionTruncated: candidatesResult.selectionTruncated,
			maxRevision,
			maxUpdatedAt,
		};
	} catch {
		// root 不存在 / 无权限 → 空 snapshot(不抛;不泄露)。
		return {
			root: null,
			children: [],
			total: 0,
			selectionTruncated: false,
			maxRevision: null,
			maxUpdatedAt: null,
		};
	}
}

/**
 * Deep profile 2nd-level expand(plan-05 §6 deep 行)。取已 sort 的 top-N
 * children(且 childrenCount > 0),逐个 expand grandchildren 第一页,塞回
 * PreparedNode.grandchildren 供渲染时缩进展示。
 *
 * 确定性:expand 排序键 path ASC + id ASC;Promise.all 保留输入顺序。
 */
async function attachDeepGrandchildren(
	wikiService: WikiService,
	access: CompiledWikiAccess,
	prepared: PreparedNode[],
): Promise<void> {
	const candidates = prepared
		.slice(0, DEEP_EXPAND_TOP_CHILDREN)
		.filter((n) => n.childrenCount > 0);
	if (candidates.length === 0) return;
	const ctx = makeRequestContext(access);
	await Promise.all(candidates.map(async (node) => {
		try {
			const expandResult = await wikiService.expand({
				address: node.path,
				limit: DEEP_EXPAND_GRANDCHILDREN_LIMIT,
				cursor: null,
				includeLinks: false,
			}, ctx);
			node.grandchildren = expandResult.children.items.map((c): PreparedNode => ({
				path: c.path,
				name: c.name,
				summary: c.summary,
				revision: c.revision,
				updated_at: "",
				review_after: null,
				childrenCount: 0,
				workHit: false,
				due: false,
				lowConfidence: false,
				grandchildren: [],
			}));
		} catch {
			node.grandchildren = [];
		}
	}));
}

function makeRequestContext(access: CompiledWikiAccess): WikiRequestContext {
	return {
		access,
		agentId: access.agentId,
		activeProjectId: access.activeProjectId,
		sessionId: null,
		requestId: null,
	};
}

function safeGetRepositoryBinding(wikiService: WikiService, projectId: string): WikiRepositoryRow | undefined {
	try {
		return wikiService.getRepositoryBinding(projectId);
	} catch {
		return undefined;
	}
}

/**
 * 安全读 active project 子树下 source_stale 节点数(P1-5 semantic-sync)。
 * 与 {@link safeGetRepositoryBinding} 同模型:compiler 内部从 wikiService 取,
 * 保证 preview == runtime(同一 wikiService 实例,字节级一致),caller 无法分叉。
 * 失败 → 0(不阻塞编译;0 即 semantic fresh,与无 stale 同外观)。
 */
function safeCountSourceStale(wikiService: WikiService, projectId: string): number {
	try {
		return wikiService.countSourceStale(projectId);
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// 内部:filter → boost → sort pipeline
// ---------------------------------------------------------------------------

/**
 * Memory children 准备:filter(profile durability + 低置信假设)→ boost(workHit
 * / due / lowConfidence)→ sort。返回新数组(不修改输入)。
 */
function prepareMemoryChildren(
	children: SubtreeNodeSnapshot[],
	profile: Profile,
	workContext: WorkContext | undefined,
	now: Date,
): PreparedNode[] {
	const matchers = compileWorkMatchers(workContext);
	// Step 1 — filter:
	//   - 低置信假设:compact/standard 排除;deep 保留(渲染时加 marker)。
	//   - profile durability:compact=permanent only;standard/deep=permanent +
	//     long_term + undefined-durability(充当一级导航)。
	const filtered = children.filter((c) => {
		if (isLowConfidenceHypothesis(c) && profile !== "deep") return false;
		if (profile === "compact") return c.durability === "permanent";
		// standard + deep:explicit high-value tiers PLUS undefined-durability
		// nodes, which serve as first-level navigation for memory trees built
		// without disciplined durability tagging (the common case). Ranking
		// still favors explicit tiers via DURABILITY_RANK (unknown sorts last,
		// rank 3), so permanent / long_term surface first within budget;
		// undefined-durability nodes fill in as navigation when budget remains.
		// short_term stays excluded — it is the explicit "ephemeral" tier and
		// must stay out of the prompt.
		return c.durability === "permanent" || c.durability === "long_term" || c.durability === undefined;
	});
	// Step 2 + 3 — boost + sort。
	const prepared = filtered.map((c): PreparedNode => ({
		...c,
		workHit: matchesWork(c, matchers),
		due: isDueForReview(c.review_after, now),
		lowConfidence: isLowConfidenceHypothesis(c),
		grandchildren: [],
	}));
	prepared.sort(compareMemoryPrepared);
	return prepared;
}

/**
 * Project children 准备:无 durability/低置信过滤(Project 节点无 memory 语义);
 * 仅 boost(workHit / due / lowConfidence)→ sort。compact profile 不渲染任何
 * 子节点(renderProjectSection 直接跳过 prepared)。
 */
function prepareProjectChildren(
	children: SubtreeNodeSnapshot[],
	workContext: WorkContext | undefined,
	now: Date,
): PreparedNode[] {
	const matchers = compileWorkMatchers(workContext);
	const prepared = children.map((c): PreparedNode => ({
		...c,
		workHit: matchesWork(c, matchers),
		due: isDueForReview(c.review_after, now),
		lowConfidence: isLowConfidenceHypothesis(c),
		grandchildren: [],
	}));
	prepared.sort(compareProjectPrepared);
	return prepared;
}

// ---------------------------------------------------------------------------
// 内部:workContext boost
// ---------------------------------------------------------------------------

interface WorkMatchers {
	/** recentFiles basename(去扩展名,小写,长度 ≥ 3)。 */
	fileBasenames: string[];
	/** requirementId + taskDescription 提取的关键 token(小写,长度 ≥ 3)。 */
	keywords: string[];
}

/**
 * 把 workContext 编译为稳定 matcher 集合。空 workContext → 空 matchers →
 * 任何节点都不会 workHit(等价于关闭 boost,保持原 sort)。
 */
function compileWorkMatchers(workContext: WorkContext | undefined): WorkMatchers {
	if (!workContext) return { fileBasenames: [], keywords: [] };
	const fileBasenames: string[] = [];
	if (workContext.recentFiles) {
		for (const f of workContext.recentFiles) {
			if (typeof f !== "string" || f.length === 0) continue;
			const base = f.split(/[\\/]/).pop() ?? f;
			const noExt = base.replace(/\.[^.]+$/, "");
			if (noExt.length >= 3) fileBasenames.push(noExt.toLowerCase());
		}
	}
	const keywords: string[] = [];
	const sourceText = [workContext.requirementId, workContext.taskDescription]
		.filter((s): s is string => typeof s === "string" && s.length > 0)
		.join(" ");
	if (sourceText.length > 0) {
		const tokens = sourceText
			.toLowerCase()
			.split(/[^a-z0-9_-]+/i)
			.filter((t) => t.length >= 3);
		keywords.push(...tokens);
	}
	return { fileBasenames, keywords };
}

/**
 * 节点是否命中 workContext:检查 path / name / summary 是否包含任一 basename
 * 或 keyword(子串、小写比较)。
 */
function matchesWork(node: SubtreeNodeSnapshot, matchers: WorkMatchers): boolean {
	if (matchers.fileBasenames.length === 0 && matchers.keywords.length === 0) return false;
	const haystack = `${node.path || ""} ${node.name || ""} ${node.summary || ""}`.toLowerCase();
	for (const b of matchers.fileBasenames) {
		if (b && haystack.includes(b)) return true;
	}
	for (const k of matchers.keywords) {
		if (k && haystack.includes(k)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// 内部:filter rules
// ---------------------------------------------------------------------------

/**
 * 低置信假设判定(defect #5 修复)。
 *   - confidence >= 阈值 → false
 *   - confidence < 阈值 AND memory_type absent/empty → true(use confidence alone)
 *   - confidence < 阈值 AND memory_type present → true 仅当 memory_type 命中
 *     HYPOTHESIS_MEMORY_TYPES(非假设型节点即便低置信也保留,如 preference/procedure)。
 */
function isLowConfidenceHypothesis(node: SubtreeNodeSnapshot): boolean {
	const conf = typeof node.confidence === "number" ? node.confidence : 1;
	if (conf >= LOW_CONFIDENCE_THRESHOLD) return false;
	const mt = node.memory_type;
	if (mt === undefined || mt === null || mt === "") return true;
	return HYPOTHESIS_MEMORY_TYPES.has(mt.toLowerCase());
}

/**
 * review_after due 判定(defect #6 修复)。ISO ≤ now → due。无效 ISO → 非 due。
 */
function isDueForReview(reviewAfter: string | null, now: Date): boolean {
	if (!reviewAfter) return false;
	const t = Date.parse(reviewAfter);
	if (!Number.isFinite(t)) return false;
	return t <= now.getTime();
}

// ---------------------------------------------------------------------------
// 内部:sort comparators
// ---------------------------------------------------------------------------

/**
 * Memory 类内稳定 tuple sort:
 *   workHit DESC > priority DESC > durability rank ASC(permanent 先) >
 *   confidence DESC > due ASC(false 先,due 降级) > updated_at DESC > path ASC。
 */
function compareMemoryPrepared(a: PreparedNode, b: PreparedNode): number {
	if (a.workHit !== b.workHit) return a.workHit ? -1 : 1;
	const pa = typeof a.priority === "number" ? a.priority : 0;
	const pb = typeof b.priority === "number" ? b.priority : 0;
	if (pa !== pb) return pb - pa;
	const da = DURABILITY_RANK[a.durability ?? ""] ?? 3;
	const db = DURABILITY_RANK[b.durability ?? ""] ?? 3;
	if (da !== db) return da - db;
	const ca = typeof a.confidence === "number" ? a.confidence : 0;
	const cb = typeof b.confidence === "number" ? b.confidence : 0;
	if (ca !== cb) return cb - ca;
	if (a.due !== b.due) return a.due ? 1 : -1;
	const ua = parseTimeMs(a.updated_at);
	const ub = parseTimeMs(b.updated_at);
	if (ua !== ub) return ub - ua;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Project 类内稳定 tuple sort(无 durability):
 *   workHit DESC > priority DESC > confidence DESC > due ASC > updated_at DESC > path ASC。
 */
function compareProjectPrepared(a: PreparedNode, b: PreparedNode): number {
	if (a.workHit !== b.workHit) return a.workHit ? -1 : 1;
	const pa = typeof a.priority === "number" ? a.priority : 0;
	const pb = typeof b.priority === "number" ? b.priority : 0;
	if (pa !== pb) return pb - pa;
	const ca = typeof a.confidence === "number" ? a.confidence : 0;
	const cb = typeof b.confidence === "number" ? b.confidence : 0;
	if (ca !== cb) return cb - ca;
	if (a.due !== b.due) return a.due ? 1 : -1;
	const ua = parseTimeMs(a.updated_at);
	const ub = parseTimeMs(b.updated_at);
	if (ua !== ub) return ub - ua;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 内部:Memory section 渲染
// ---------------------------------------------------------------------------

interface SectionRenderResult {
	text: string;
	included: number;
	tokensUsed: number;
	truncated: boolean;
}

function renderMemorySection(
	snapshot: SubtreeSnapshot,
	prepared: PreparedNode[],
	budgetTokens: number,
): SectionRenderResult {
	if (!snapshot.root) {
		return { text: "", included: 0, tokensUsed: 0, truncated: false };
	}

	const out: string[] = [
		"### Agent Memory",
		`Root: \`${snapshot.root.path}\``,
	];
	if (snapshot.root.summary) {
		out.push(`Summary: ${truncate(snapshot.root.summary, ROOT_SUMMARY_BUDGET_CHARS)}`);
	}
	// defect #4 修复:root content 的稳定规则实际进 prompt(之前只读 .summary)。
	const rootRules = renderRootContentRules(snapshot.root.content);
	if (rootRules) {
		out.push(rootRules);
	}

	let used = estimateTokens(out.join("\n"));
	let included = 0;
	let truncated = false;

	for (const node of prepared) {
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

	// round-2 review P1 §4:candidate 选择被 SCAN CAP 截断 → 显式提示 agent + UI。
	// 现实子树永不触顶(5000 cap),只有 pathological parent 才为真。提示让 agent
	// 知道 prompt 不全,需用 search 补全(与 omitted 不冲突 —— omitted 是 token
	// 预算截断,selection-truncated 是查询前的 candidate 集截断,二者独立)。
	if (snapshot.selectionTruncated) {
		out.push(
			`_(selection scanned first ${snapshot.children.length} of ${snapshot.total} direct children — truncated; refine with Wiki search)_`,
		);
	}

	return { text: out.join("\n"), included, tokensUsed: used, truncated };
}

/**
 * 把 root content 渲染为 "Stable rules:" 段(截断到 ROOT_CONTENT_BUDGET_CHARS)。
 * 空内容 → 空字符串(不渲染该段)。
 */
function renderRootContentRules(content: string): string {
	if (!content || !content.trim()) return "";
	return `Stable rules:\n${truncate(content, ROOT_CONTENT_BUDGET_CHARS)}`;
}

function formatMemoryNodeLine(node: PreparedNode): string {
	const tags: string[] = [];
	if (node.durability) tags.push(node.durability);
	if (node.memory_type) tags.push(node.memory_type);
	const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
	const markers: string[] = [];
	if (node.lowConfidence) markers.push("low confidence");
	if (node.due) markers.push("due for review");
	const markerStr = markers.length > 0 ? ` (${markers.join("; ")})` : "";
	const summary = node.summary ? ` — ${truncate(node.summary, 200)}` : "";
	const lines = [`- \`${node.path}\`${tagStr}${markerStr}${summary}`];
	if (node.grandchildren.length > 0) {
		for (const gc of node.grandchildren) {
			const gcSummary = gc.summary ? ` — ${truncate(gc.summary, 120)}` : "";
			lines.push(`  - \`${gc.path}\`${gcSummary}`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 内部:Project section 渲染
// ---------------------------------------------------------------------------

function renderProjectSection(
	snapshot: SubtreeSnapshot,
	prepared: PreparedNode[],
	profile: Profile,
	budgetTokens: number,
	binding: WikiRepositoryRow | undefined,
	staleNodeCount: number,
): SectionRenderResult {
	if (!snapshot.root) {
		return renderEmptyProjectSection();
	}

	const out: string[] = [
		"### Active Project",
		`Root: \`${snapshot.root.path}\``,
	];
	if (snapshot.root.summary) {
		out.push(`Summary: ${truncate(snapshot.root.summary, 800)}`);
	}

	// round-2 review-fix P1 §5.4:manifest 状态行 —— 显式告诉 agent 当前 project
	// 的 6 个结构化字段是 pending / partial / ready 哪一种,放在结构化字段**之前**
	// 让 agent 一眼看到「这字段是不是 enrich 过」,而不是从一堆 (none recorded)
	// 里推断。读 project root attributes.json(已通过 fetchSubtreeSnapshot 注入到
	// snapshot.root.attributes),preview == runtime 同一根源。
	out.push(renderManifestStatusLine(snapshot.root.attributes));

	// defect #9 修复:渲染 root 结构化字段(goals/stack/entrypoints/modules/risks/
	// constraints),缺省 → 显式 "(none recorded)"。
	for (const line of renderProjectStructuredFields(snapshot.root.attributes, profile)) {
		out.push(line);
	}

	// defect #9 修复:渲染 repo binding(branch / indexed_revision / sync_status /
	// last_error / last_indexed_at),缺省 → 显式 empty state。
	for (const line of renderRepoBinding(binding)) {
		out.push(line);
	}

	// P1-5: semantic-sync 显式提示。structure 可以已 synced,但 modify 节点的
	// summary/content 可能滞后(等 Archivist 重新充实)。count > 0 时给 agent 一行
	// 警示,让它对 stale 节点采取保守策略(优先 search/read 源文件而非依赖摘要,
	// 或主动 update 重新概括)。count === 0 时不渲染(避免噪音)。
	if (staleNodeCount > 0) {
		out.push(
			`Semantic sync: ${staleNodeCount} node(s) have stale summaries (structure is synced but content may be outdated — re-summarization pending).`,
		);
	}

	let used = estimateTokens(out.join("\n"));
	let included = 0;
	let truncated = false;

	// compact profile 不渲染 children(plan-05 §6 matrix:仅 root attrs + binding)。
	if (profile !== "compact") {
		for (const node of prepared) {
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
	}

	if (snapshot.total > included) {
		out.push(`_(${snapshot.total - included} more project nodes omitted — use Wiki search/expand to browse)_`);
	}

	// round-2 review P1 §4:candidate 选择被 SCAN CAP 截断 → 显式提示(同 memory 段)。
	if (snapshot.selectionTruncated) {
		out.push(
			`_(selection scanned first ${snapshot.children.length} of ${snapshot.total} direct children — truncated; refine with Wiki search)_`,
		);
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

/**
 * 渲染 Project root 的结构化字段。compact profile 只渲染 Goals + Entrypoints;
 * standard/deep 渲染全部 6 个字段。每个字段缺省 → 显式 "(none recorded)"
 * (defect #9 修复:不静默省略)。
 */
function renderProjectStructuredFields(attrs: WikiNodeAttributes, profile: Profile): string[] {
	const fieldsCompact: Array<[string, string]> = [
		["Goals", "goals"],
		["Entrypoints", "entrypoints"],
	];
	const fieldsStandard: Array<[string, string]> = [
		["Goals", "goals"],
		["Stack", "stack"],
		["Entrypoints", "entrypoints"],
		["Modules", "modules"],
		["Risks", "risks"],
		["Constraints", "constraints"],
	];
	const fields = profile === "compact" ? fieldsCompact : fieldsStandard;
	return fields.map(([label, key]) => `- ${label}: ${formatFieldValue(attrs[key])}`);
}

/**
 * 渲染 manifest 状态行(round-2 review-fix P1 §5.4)。读 project root attributes
 * 的 `manifest_status` + `manifest_updated_at`,输出单行让 agent 一眼看出当前
 * project 的 6 个结构化字段处于什么生命周期阶段。
 *
 * 规则(absent → pending,由 {@link manifestStatusFromAttrs} 处理):
 *   - `ready` —— `Manifest: ready (goals/stack/entrypoints enriched <date>)`,
 *     其中 <date> 来自 manifest_updated_at(date-only 简短显示)。
 *   - `partial` —— `Manifest: partial — some structured fields may be stale; re-run wiki-enrich.`
 *   - `pending` 或 absent —— `Manifest: pending — structural index only; goals/stack/entrypoints not yet enriched. Run wiki-enrich to populate.`
 *
 * preview == runtime:同一 root attributes → 同一行字节级一致。
 */
function renderManifestStatusLine(attrs: WikiNodeAttributes): string {
	const status: ProjectManifestStatus = manifestStatusFromAttrs(attrs);
	if (status === "ready") {
		const date = formatManifestDate(attrs.manifest_updated_at);
		return `Manifest: ready (goals/stack/entrypoints enriched${date ? ` ${date}` : ""}).`;
	}
	if (status === "partial") {
		return "Manifest: partial — some structured fields may be stale; re-run wiki-enrich.";
	}
	return "Manifest: pending — structural index only; goals/stack/entrypoints not yet enriched. Run wiki-enrich to populate.";
}

/**
 * 把 manifest_updated_at(ISO-8601)格式化成 date-only 字符串(YYYY-MM-DD)用于
 * 渲染。无效 / 缺失 → 空字符串(调用方判断后省略)。刻意只取日期:分钟级时间对
 * agent 无意义且占 token;date-only 已足够表达「最近 enrich 大致什么时候」。
 */
function formatManifestDate(iso: unknown): string {
	if (typeof iso !== "string" || iso.length === 0) return "";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "";
	try {
		// toISOString → "2026-07-18T..." → 取前 10 字符。
		return new Date(t).toISOString().slice(0, 10);
	} catch {
		return "";
	}
}

/**
 * 把任意 attributes 字段值格式化为单行字符串。null/undefined/空 → "(none recorded)"。
 */
function formatFieldValue(v: unknown): string {
	if (v === undefined || v === null) return "(none recorded)";
	if (typeof v === "string") return v.length === 0 ? "(none recorded)" : v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		if (v.length === 0) return "(none recorded)";
		return v
			.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
			.join(", ");
	}
	if (typeof v === "object") return JSON.stringify(v);
	return "(none recorded)";
}

/**
 * 渲染 repo binding status。无 binding → 显式 empty state。
 */
function renderRepoBinding(binding: WikiRepositoryRow | undefined): string[] {
	if (!binding) {
		return ["Repo binding: (none — project not bound to a Git repository)"];
	}
	const branch = binding.default_branch || "(unset)";
	const indexedRev = binding.indexed_revision ?? "(none)";
	const syncStatus = binding.sync_status || "(unknown)";
	const lastError = binding.last_error ?? "(none)";
	const lastIndexed = binding.last_indexed_at ?? "(never)";
	return [
		`Repo binding: branch=${branch}, indexed_revision=${indexedRev}, sync_status=${syncStatus}`,
		`  last_error=${lastError}, last_indexed_at=${lastIndexed}`,
	];
}

function formatProjectNodeLine(node: PreparedNode): string {
	const childMarker = node.childrenCount > 0 ? ` ▾${node.childrenCount}` : " leaf";
	const markers: string[] = [];
	if (node.lowConfidence) markers.push("low confidence");
	if (node.due) markers.push("due for review");
	const markerStr = markers.length > 0 ? ` (${markers.join("; ")})` : "";
	const summary = node.summary ? ` — ${truncate(node.summary, 200)}` : "";
	const lines = [`- \`${node.path}\`${childMarker}${markerStr}${summary}`];
	if (node.grandchildren.length > 0) {
		for (const gc of node.grandchildren) {
			const gcSummary = gc.summary ? ` — ${truncate(gc.summary, 120)}` : "";
			lines.push(`  - \`${gc.path}\`${gcSummary}`);
		}
	}
	return lines.join("\n");
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

/** ISO/数字字符串 → ms 数(用于 updated_at 比较)。无效/空 → 0。 */
function parseTimeMs(s: string | undefined): number {
	if (!s) return 0;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : 0;
}

/** 取两个 ISO 字符串(或 null)中较晚的一个;两个都 null → null。 */
function pickLaterIso(a: string | null, b: string | null): string | null {
	if (a === null) return b;
	if (b === null) return a;
	return a >= b ? a : b;
}

/** 重新导出 normalizeWikiPath 便于 AgentService 在 publish 时校验路径。 */
export { normalizeWikiPath };
