// WikiAuthorizationService — allowlist 授权 + 搜索 scope 准备（wiki-system-redesign plan-02 §3）
//
// # 文件说明书
//
// ## 核心功能
// 在 service 层执行授权判定:
//   - `authorize(action, canonicalPath, access)` —— 检查 CompiledWikiAccess
//     是否覆盖 canonicalPath 且允许 action。
//   - `prepareSearchScopes(access, requestedScope?)` —— 计算可用搜索 scope,
//     取与 requestedScope 的交集（不扩大 access 范围）。
//   - `filterVisibleLinks(...)` —— 过滤对端不可见的链接（不泄露 path / count）。
//
// ## 关键不变量（plan-02 §3 / acceptance-02 §C）
//   - 授权**先于**节点存在性或正文查询:
//       无 scope 覆盖   → NOT_FOUND（与节点不存在返回同一外观,不泄露）
//       scope 但无 action → ACCESS_DENIED
//       action 但节点不存在 → NOT_FOUND
//   - scope 覆盖按**路径段**匹配（不允许字符串前缀误匹配 wiki-root/a vs wiki-root/ab）。
//   - deep grant **不**自动允许读祖先。
//   - 编译后的 access 不能被 service 输入中的 agentId/projectId 覆盖。
//
// ## 不做
//   - 不读节点正文 / 不查 wiki_nodes（authorize 是纯函数,只看 access + path）。
//   - 不写 grants 到 DB（design.md §7.1「grants 保存在 AgentRecord」）。
//   - 不实现 deny / visibility / 节点 ACL / 继承（plan-02 第一版 allowlist only）。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-02-core-service-address-auth.md §3
//   - docs/archive/wiki-system-redesign/design.md §7.3

import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
} from "../../shared/wiki-types.js";
import { isSameOrDescendant, normalizeWikiPath } from "./wiki-path.js";
import { wikiError } from "./wiki-errors.js";

/**
 * 授权结果。
 */
export interface WikiAuthorizationDecision {
	/** 是否允许。 */
	allowed: boolean;
	/** 命中的 grant（allowed=true 时填;便于 audit / 调试）。 */
	matchedGrant: CompiledWikiGrant | null;
}

/**
 * 授权服务。**纯函数实现**,不读 DB;保证 authorize() 在 service 中先于 node 读取执行
 * （acceptance-02 §C「authorization 在 repository 读取节点/正文之前执行」）。
 */
export class WikiAuthorizationService {
	// -------------------------------------------------------------------------
	// authorize —— 数据面每条 action 的前置判定
	// -------------------------------------------------------------------------

	/**
	 * 判定 access 是否允许在 canonicalPath 上执行 action。
	 *
	 * 错误映射（plan-02 §3,与节点存在性解耦）:
	 *   - 无 scope 覆盖 → 抛 NOT_FOUND（同节点不存在的外观,不泄露）
	 *   - scope 覆盖但无 action → 抛 ACCESS_DENIED
	 *   - 允许 → 返回 matchedGrant
	 *
	 * 注意:**不在本方法内查 wiki_nodes**。调用方应在调用本方法 **之前** 或 **失败路径**
	 * 之外再读节点（acceptance-02 §C）。
	 */
	authorize(
		action: WikiAction,
		canonicalPath: string,
		access: CompiledWikiAccess,
	): CompiledWikiGrant {
		const normalized = normalizeWikiPath(canonicalPath);
		let scopeCovered = false;
		for (const grant of access.grants) {
			if (!isSameOrDescendant(grant.canonicalScope, normalized)) continue;
			scopeCovered = true;
			if (grant.actions.includes(action)) {
				return grant;
			}
		}
		if (!scopeCovered) {
			// 与节点不存在返回同一外观 —— message 不区分「scope 未覆盖」与「节点不存在」。
			throw wikiError(
				"NOT_FOUND",
				`no accessible resource at ${normalized}`,
			);
		}
		throw wikiError(
			"ACCESS_DENIED",
			`action '${action}' not allowed at ${normalized}`,
		);
	}

	/**
	 * 非抛出版本:返回 decision。便于调用方在不抛 NOT_FOUND 的场景（如 search scope
	 * 计算）中检查可见性。
	 */
	decide(
		action: WikiAction,
		canonicalPath: string,
		access: CompiledWikiAccess,
	): WikiAuthorizationDecision {
		const normalized = normalizeWikiPath(canonicalPath);
		for (const grant of access.grants) {
			if (!isSameOrDescendant(grant.canonicalScope, normalized)) continue;
			if (grant.actions.includes(action)) {
				return { allowed: true, matchedGrant: grant };
			}
			return { allowed: false, matchedGrant: grant };
		}
		return { allowed: false, matchedGrant: null };
	}

	// -------------------------------------------------------------------------
	// prepareSearchScopes —— 计算搜索可见 scope（plan-02 §3 internal helper）
	// -------------------------------------------------------------------------

	/**
	 * 计算当前 access 在 search action 下可见的 canonical scope 列表。若提供
	 * `requestedScope`,只返回既在 access grants 内、又在 requestedScope（或其子树）
	 * 内的 scope —— **不扩大** access 范围。
	 *
	 * @param access 编译后的访问上下文（权威）
	 * @param requestedScope 可选的请求范围（canonical path 或逻辑地址;逻辑地址需
	 *   由调用方先解析为 canonical 后传入 —— 本方法不解析动态地址）
	 * @returns canonical scope 路径数组（已去重;空数组表示无可见 scope）
	 */
	prepareSearchScopes(
		access: CompiledWikiAccess,
		requestedScope?: string | null,
	): string[] {
		const allowedScopes = access.grants
			.filter((g) => g.actions.includes("search"))
			.map((g) => normalizeWikiPath(g.canonicalScope));

		if (!requestedScope) {
			return dedupSorted(allowedScopes);
		}
		const requested = normalizeWikiPath(requestedScope);
		const result: string[] = [];
		for (const scope of allowedScopes) {
			// 取 access scope 与 requested 的交集:
			//   - 若 requested 是 scope 的祖先或自身 → scope 完全可见,保留 scope。
			//   - 若 scope 是 requested 的祖先 → 只返回 requested 子树(scope ∩ requested = requested)。
			//   - 否则无交集,跳过。
			if (isSameOrDescendant(scope, requested)) {
				result.push(scope);
			} else if (isSameOrDescendant(requested, scope)) {
				result.push(requested);
			}
		}
		return dedupSorted(result);
	}

	// -------------------------------------------------------------------------
	// filterVisibleLinks —— 防止对端泄露（plan-02 §3 / acceptance-02 §C）
	// -------------------------------------------------------------------------

	/**
	 * 过滤链接列表,只保留对端（source/target 中不是 `nodePath` 的那一端）路径
	 * 处于 access 任意可见 grant 下的链接。`read action` 决定对端可见性 ——
	 * 即:对端路径必须有 grant 覆盖且该 grant 允许 `read`（或 `expand`）。
	 *
	 * 关键不变量（plan-02 §3「links 只返回对端处于任意可见 grant 下的记录」）:
	 *   - 对端不可见时,该 link 不返回,**也不暗示数量**（不接受 "X hidden links"）。
	 *   - deep grant **不**自动允许读祖先;即只覆盖祖先的 grant 不允许看后代 link。
	 */
	filterVisibleLinks(
		nodeCanonicalPath: string,
		links: ReadonlyArray<{
			sourcePath: string;
			targetPath: string;
			relation: string;
			createdAt: string;
			createdBy: string | null;
		}>,
		access: CompiledWikiAccess,
	): {
		outgoing: {
			sourcePath: string;
			targetPath: string;
			relation: string;
			createdAt: string;
			createdBy: string | null;
		}[];
		incoming: {
			sourcePath: string;
			targetPath: string;
			relation: string;
			createdAt: string;
			createdBy: string | null;
		}[];
	} {
		const outgoing: Array<{
			sourcePath: string;
			targetPath: string;
			relation: string;
			createdAt: string;
			createdBy: string | null;
		}> = [];
		const incoming: Array<{
			sourcePath: string;
			targetPath: string;
			relation: string;
			createdAt: string;
			createdBy: string | null;
		}> = [];
		for (const link of links) {
			const sourceNorm = normalizeWikiPath(link.sourcePath);
			const targetNorm = normalizeWikiPath(link.targetPath);
			if (sourceNorm === nodeCanonicalPath) {
				// outgoing:对端 = target;target 必须可读。
				if (this.canRead(targetNorm, access)) {
					outgoing.push({ ...link, sourcePath: sourceNorm, targetPath: targetNorm });
				}
			} else if (targetNorm === nodeCanonicalPath) {
				// incoming:对端 = source;source 必须可读。
				if (this.canRead(sourceNorm, access)) {
					incoming.push({ ...link, sourcePath: sourceNorm, targetPath: targetNorm });
				}
			}
			// 既不是 source 也不是 target 的链接（异常状态）—— 静默丢弃,不泄露。
		}
		return { outgoing, incoming };
	}

	/**
	 * 判断 access 是否允许 read 该 canonicalPath。
	 */
	canRead(canonicalPath: string, access: CompiledWikiAccess): boolean {
		const normalized = normalizeWikiPath(canonicalPath);
		for (const grant of access.grants) {
			if (!isSameOrDescendant(grant.canonicalScope, normalized)) continue;
			if (grant.actions.includes("read") || grant.actions.includes("expand")) {
				return true;
			}
		}
		return false;
	}
}

/**
 * 数组去重并保持稳定排序（按字母序）。供 prepareSearchScopes 使用。
 */
function dedupSorted(arr: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of arr.sort()) {
		if (seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}
