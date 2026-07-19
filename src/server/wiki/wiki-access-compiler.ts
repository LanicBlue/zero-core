// Wiki grants → CompiledWikiAccess 编译器(wiki-system-redesign plan-05 §4)
//
// # 文件说明书
//
// ## 核心功能
// 把 AgentRecord.wikiGrants + AgentRecord.wikiContext + 稳定 agentId /
// activeProjectId 编译为 `CompiledWikiAccess`(放入 SessionConfig +
// CallerCtx.wikiAccess)。
//
// ## 编译规则(design.md §7.2 + plan-05 §4)
//   - `memory://`        → `wiki-root/memory/<stable-agent-id>`
//   - `memory://<rest>`  → `wiki-root/memory/<stable-agent-id>/<rest>`
//   - `project://`       → `wiki-root/projects/<stable-project-id>`
//                          (无 active project → 整条 grant 标 inactive;**不**
//                          解析到 projects 根,防 scope 跨项目泄露)
//   - `project://<rest>` → `wiki-root/projects/<stable-project-id>/<rest>`
//   - `wiki-root/...`    → 原样(canonical path)
//   - `runtime://...`    → 原样(静态 alias 由 service 时再解析)
//   - 其它               → 抛 INVALID_ADDRESS(编译时硬失败,不静默丢)
//
// ## 关键不变量(plan-05 §4 / acceptance-05 §B)
//   - LLM input 无法改变 agentId / activeProjectId / grants(身份 host-injected)。
//   - 无 active project 时 project:// grant 被跳过(不扩大到 projects 根)。
//   - scope 路径段匹配,不是字符串前缀匹配(design.md §7.3)。
//   - 多条 grant 的 actions 取并集(design.md §7.3)。
//   - **不读 AgentStore / wiki.db / ctx.agentId / ctx.projectId** —— 唯一输入
//     是 `compileWikiAccess(opts)` 的显式参数。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-05-agent-runtime-prompt.md §4
//   - docs/archive/wiki-system-redesign/design.md §7.2

import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
} from "../../shared/wiki-types.js";
import {
	WIKI_ROOT_PATH,
	normalizeWikiPath,
	validateWikiName,
} from "./wiki-path.js";
import type { WikiContextEntry, WikiGrant } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** `memory://` 动态地址 scheme。 */
const MEMORY_SCHEME = "memory://";
/** `project://` 动态地址 scheme。 */
const PROJECT_SCHEME = "project://";
/** `runtime://` 静态 alias scheme(编译时原样透传)。 */
const RUNTIME_SCHEME = "runtime://";

/** 默认 policyRevision(AgentRecord 未填时用)。 */
const DEFAULT_POLICY_REVISION = 1;

/** v1 闭合 action 闭集(用于 grant actions 合法性校验)。 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set<WikiAction>([
	"expand", "read", "search", "create", "update", "delete", "link", "unlink", "move",
]);

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 编译输入。
 *
 * **不读外部 store** —— 所有身份信息必须显式传入。AgentService 是唯一调用方;
 * 它从 AgentRecord + session context 提取这些参数。
 */
export interface CompileWikiAccessOpts {
	/** Agent 稳定 ID(必填;用于解析 memory://)。 */
	agentId: string;
	/** 当前 active project 稳定 ID(可选;用于解析 project://)。 */
	activeProjectId?: string;
	/** AgentRecord.wikiGrants(显式 grants;未配置 → 空 access,仅含 fallback)。 */
	wikiGrants?: WikiGrant[];
	/**
	 * AgentRecord.wikiPolicyRevision(用于 cache invalidation;未填 → 1)。
	 * AgentService 在 publish 时 +1,使 AgentLoop 的 prompt cache 失效。
	 */
	wikiPolicyRevision?: number;
	/**
	 * 可选 fallback:AgentRecord 未显式配 wikiGrants 时使用。plan-05 §2 template
	 * 默认策略注入在此 —— AgentService 调用方根据 Agent 类型(普通/Project/
	 * Archivist/Zero)传不同 fallback。
	 */
	fallbackGrants?: WikiGrant[];
}

/**
 * 编译输出(成功 / 部分失败 合并返回)。
 *
 * - `access` 始终返回(即使 grants 全部 inactive 也返空 CompiledWikiAccess,
 *   让 caller 显式看到 "无权限"状态;工具调用会立即 ACCESS_DENIED)。
 * - `warnings` 收集非致命问题(inactive grant / 重复 scope / 未识别 action)。
 *   AgentService 可记日志或返回给 UI preview。
 */
export interface CompileWikiAccessResult {
	access: CompiledWikiAccess;
	warnings: string[];
}

/**
 * 编译 Wiki grants 为 CompiledWikiAccess。
 *
 * 幂等:同输入 → 同输出(无随机 / 无时间依赖)。预览 (UI preview) 与 runtime
 * 使用同一函数,字节级一致(acceptance-05 §C「preview 与 runtime 使用同一
 * compiler」)。
 */
export function compileWikiAccess(opts: CompileWikiAccessOpts): CompileWikiAccessResult {
	const agentId = opts.agentId;
	const activeProjectId = opts.activeProjectId;
	const policyRevision = opts.wikiPolicyRevision ?? DEFAULT_POLICY_REVISION;
	const warnings: string[] = [];

	const sourceGrants = (opts.wikiGrants && opts.wikiGrants.length > 0)
		? opts.wikiGrants
		: (opts.fallbackGrants ?? []);

	// agentId 必须是合法 path segment(memory root = wiki-root/memory/<agentId>)。
	if (!agentId || typeof agentId !== "string") {
		// 完全无 agentId → 空 access,让 caller 显式看到 "无身份"。
		return {
			access: {
				agentId: agentId ?? "",
				activeProjectId,
				grants: [],
				policyRevision,
			},
			warnings: [...warnings, "compileWikiAccess: empty agentId — empty access returned"],
		};
	}
	try {
		validateWikiName(agentId);
	} catch (err) {
		return {
			access: {
				agentId, activeProjectId, grants: [], policyRevision,
			},
			warnings: [...warnings, `compileWikiAccess: invalid agentId '${agentId}': ${(err as Error).message}`],
		};
	}

	// 去重 key:同 canonicalScope 的 grants 合并 actions(并集)。
	const mergedByScope = new Map<string, Set<WikiAction>>();
	for (const grant of sourceGrants) {
		const compiled = compileOneGrant(grant, agentId, activeProjectId, warnings);
		if (!compiled) continue;
		const existing = mergedByScope.get(compiled.canonicalScope);
		if (existing) {
			for (const a of compiled.actions) existing.add(a);
		} else {
			mergedByScope.set(compiled.canonicalScope, new Set(compiled.actions));
		}
	}

	const grants: CompiledWikiGrant[] = [];
	for (const [canonicalScope, actionSet] of mergedByScope) {
		grants.push({
			canonicalScope,
			actions: [...actionSet],
		});
	}

	return {
		access: {
			agentId,
			activeProjectId,
			grants,
			policyRevision,
		},
		warnings,
	};
}

// ---------------------------------------------------------------------------
// 内部:单条 grant 编译
// ---------------------------------------------------------------------------

/**
 * 编译一条 WikiGrant。返回 CompiledWikiGrant 或 null(inactive / invalid 时)。
 *
 * inactive 与 invalid 的区别:
 *   - **inactive**:grant 引用了 project:// 但当前无 active project → 整条
 *     grant 跳过(不报错;warnings 记录)。Agent 在 active project 重新进入
 *     session 时会被重新编译并激活。
 *   - **invalid**:scope 字符串非法 / 含非法字符 / action 不在闭集 → warnings
 *     记录,grant 跳过。AgentService 应在 publish 前 UI preview 时告警。
 */
function compileOneGrant(
	grant: WikiGrant,
	agentId: string,
	activeProjectId: string | undefined,
	warnings: string[],
): CompiledWikiGrant | null {
	if (!grant || typeof grant !== "object") {
		warnings.push("compileWikiAccess: skipping non-object grant");
		return null;
	}
	const scope = grant.scope;
	if (typeof scope !== "string" || scope.length === 0) {
		warnings.push("compileWikiAccess: skipping grant with empty scope");
		return null;
	}

	const canonicalScope = resolveScopeToCanonical(scope, agentId, activeProjectId, warnings);
	if (!canonicalScope) return null; // inactive / invalid

	// 校验 actions 闭集。
	const actions: WikiAction[] = [];
	for (const a of grant.actions ?? []) {
		if (typeof a !== "string" || !ALLOWED_ACTIONS.has(a)) {
			warnings.push(`compileWikiAccess: skipping unknown action '${a}' in grant scope '${scope}'`);
			continue;
		}
		actions.push(a as WikiAction);
	}
	if (actions.length === 0) {
		warnings.push(`compileWikiAccess: grant '${scope}' has no valid actions — skipped`);
		return null;
	}

	return { canonicalScope, actions };
}

/**
 * 把 grant.scope 解析为 canonical path。
 *
 * 返回 null = inactive(例如 project:// 但无 active project);返回 undefined
 * 表示完全跳过(已被 warnings 记录)。两种情况都不进入 CompiledWikiAccess。
 */
function resolveScopeToCanonical(
	scope: string,
	agentId: string,
	activeProjectId: string | undefined,
	warnings: string[],
): string | null {
	// 1. memory:// → wiki-root/memory/<agentId>[/<rest>]
	if (scope === MEMORY_SCHEME) {
		return normalizeWikiPath(`${WIKI_ROOT_PATH}/memory/${agentId}`);
	}
	if (scope.startsWith(MEMORY_SCHEME)) {
		const rest = scope.slice(MEMORY_SCHEME.length).replace(/^\/+/, "").replace(/\/+$/, "");
		return rest
			? normalizeWikiPath(`${WIKI_ROOT_PATH}/memory/${agentId}/${rest}`)
			: normalizeWikiPath(`${WIKI_ROOT_PATH}/memory/${agentId}`);
	}

	// 2. project:// → wiki-root/projects/<projectId>[/<rest>]
	if (scope === PROJECT_SCHEME) {
		if (!activeProjectId) {
			warnings.push("compileWikiAccess: project:// grant inactive (no active project in session)");
			return null;
		}
		return normalizeWikiPath(`${WIKI_ROOT_PATH}/projects/${activeProjectId}`);
	}
	if (scope.startsWith(PROJECT_SCHEME)) {
		if (!activeProjectId) {
			warnings.push(`compileWikiAccess: project:// grant '${scope}' inactive (no active project in session)`);
			return null;
		}
		const rest = scope.slice(PROJECT_SCHEME.length).replace(/^\/+/, "").replace(/\/+$/, "");
		return rest
			? normalizeWikiPath(`${WIKI_ROOT_PATH}/projects/${activeProjectId}/${rest}`)
			: normalizeWikiPath(`${WIKI_ROOT_PATH}/projects/${activeProjectId}`);
	}

	// 3. runtime:// → 原样透传(WikiAddressService 在 service 时解析)。
	if (scope === RUNTIME_SCHEME || scope.startsWith(RUNTIME_SCHEME)) {
		return scope;
	}

	// 4. wiki-root/... → normalize 后透传(canonical path)。
	if (scope.startsWith(WIKI_ROOT_PATH + "/") || scope === WIKI_ROOT_PATH) {
		try {
			return normalizeWikiPath(scope);
		} catch (err) {
			warnings.push(`compileWikiAccess: invalid canonical path '${scope}': ${(err as Error).message}`);
			return null;
		}
	}

	// 5. 未识别 scheme。
	warnings.push(`compileWikiAccess: scope '${scope}' has unrecognized scheme (expected memory:// / project:// / runtime:// / wiki-root/...)`);
	return null;
}

// ---------------------------------------------------------------------------
// Default grants per template (plan-05 §2)
// ---------------------------------------------------------------------------

/**
 * plan-05 §2:普通 Agent 默认 grants。
 *
 * - own Memory 全数据面。
 * - Knowledge read/expand/search(只读)。
 *
 * AgentService 在 AgentRecord 未显式配 wikiGrants 时,根据 Agent 类型挑以下
 * fallback 之一传入 `compileWikiAccess({fallbackGrants})`。
 */
export const DEFAULT_GRANTS_AGENT: WikiGrant[] = [
	{
		scope: "memory://",
		actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
	},
	{
		scope: "wiki-root/knowledge",
		actions: ["expand", "read", "search"],
	},
];

/**
 * plan-05 §2:Project 研究/只读 Agent 默认 grants。
 *
 * - own Memory 全数据面。
 * - Knowledge read/expand/search。
 * - active project read/expand/search。
 */
export const DEFAULT_GRANTS_PROJECT_RESEARCHER: WikiGrant[] = [
	{
		scope: "memory://",
		actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
	},
	{
		scope: "wiki-root/knowledge",
		actions: ["expand", "read", "search"],
	},
	{
		scope: "project://",
		actions: ["expand", "read", "search"],
	},
];

/**
 * plan-05 §2:Archivist / 维护 Agent 默认 grants。
 *
 * - own Memory 全数据面。
 * - Knowledge read/expand/search。
 * - active project 增加 update/link/unlink(**不**授予 create/move/delete:
 *   source-bound 结构操作是 indexer 专属;Archivist 只充实语义层)。
 */
export const DEFAULT_GRANTS_ARCHIVIST: WikiGrant[] = [
	{
		scope: "memory://",
		actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
	},
	{
		scope: "wiki-root/knowledge",
		actions: ["expand", "read", "search"],
	},
	{
		scope: "project://",
		actions: ["expand", "read", "search", "update", "link", "unlink"],
	},
];

/**
 * plan-05 §2:Zero / 管理 Agent 默认 grants。
 *
 * **显式** `wiki-root` 全树 grant —— 绝不靠 `agentId === "zero"` 硬编码。
 * 移除该 grant 后 zero 立即失去全树权限(acceptance-05 §B「Zero 仅在 template
 * 显式 grant 时拥有全树权限」)。
 */
export const DEFAULT_GRANTS_ZERO_ADMIN: WikiGrant[] = [
	{
		scope: "wiki-root",
		actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
	},
];

/**
 * plan-05 §2:默认 context 条目。
 *
 * - `memory:// standard/system/1800`:own Memory standard profile。
 * - `project:// standard/system/2800`:active project standard profile(仅 active
 *   project session;AgentService 在无 active project 时不注入此条)。
 */
export const DEFAULT_WIKI_CONTEXT: WikiContextEntry[] = [
	{
		address: "memory://",
		profile: "standard",
		channel: "system",
		budgetTokens: 1800,
	},
	{
		address: "project://",
		profile: "standard",
		channel: "system",
		budgetTokens: 2800,
	},
];
