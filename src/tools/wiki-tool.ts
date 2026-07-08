// Wiki action 工具 (v0.8 — 结构操作 / 文档操作 拆分;读写同界 / pure anchor model)
//
// # 文件说明书
//
// ## 核心功能
// "Wiki" 把项目知识树的操作拆成两组:
//   结构操作(节点树)— expand / search / create / update / delete
//   文档操作(节点正文)— docRead / docWrite / docEdit
//
// 身份统一用 nodeId(表主键)。节点名用 title;type 不收(从 parent 在树里的
// 位置继承),path 不收(工具层内部合成,agent 永不可见)。同 parent 下 title
// 唯一(强制)→ title 层级 path 寻址无歧义。
//
// doc 三件套对标 Read/Write/Edit 工具语义,唯一区别是寻址从「文件路径」换成
// 「wiki nodeId 或 title 层级 path」。detail 是磁盘纯文本文件,docEdit 用
// read-modify-write 做精确字符串替换(无 markdown 解析)。
//
// ## 权限模型(读写同界 / pure anchor model)
// 读和写**共用同一道边界** = agent 的 resolved anchor 节点集(ctx.
// wikiAnchorNodeIds:auto memory + auto project/global + free wikiAnchors)。
//   - 能读 = 能写:anchor 子树内的节点既可 expand 也可 create/update/delete。
//   - free wikiAnchors 授予的子树同样可写(不再像旧版只读不写)。
//   - zero / 全局 session(无 projectId)的 anchor 集含全局根 → 整棵树可读可写。
//   - 项目 agent 的 anchor 集 = 自己项目子树 + memory + free,看不到也写不到
//     别项目 / 全局知识(隔离不变)。
// scope 在 store 层强制(assertNodeInAnchorScope);工具层只负责把 anchor 集
// 透传给 *InScope 写原语。空 anchor 集 → 拒绝(无 wiki 上下文)。
//
// ## 设计依据
// - schema 必须顶层 z.object(非 discriminatedUnion):LLM 函数调用协议要求
//   顶层 type:object。见 project-v08-tool-hardening §2。
//
// ## 输入
// - ctx.wikiStore (ProjectWikiStore 兼容层 → .getWikiStore() 取真 WikiStore)
// - ctx.wikiAnchorNodeIds (读写同界的 scope 锚点集)
//
// ## 输出
// - export const wikiTool / wikiActionSchema
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { WikiStore } from "../server/wiki-node-store.js";
import type { WikiNode } from "../shared/types.js";
import { formatBodySize, formatNodeId, shortIdOf, sanitizeText } from "../runtime/wiki-anchor-injection.js";

// ---------------------------------------------------------------------------
// Helpers — wiki store resolution + anchor scope + node addressing
// ---------------------------------------------------------------------------

/**
 * Group the visible nodes by parentId. Shared by expand (descendant walk) and
 * search (subtree scoping) so neither re-builds the map inline.
 */
function groupByParent(nodes: WikiNode[]): Map<string, WikiNode[]> {
	const m = new Map<string, WikiNode[]>();
	for (const n of nodes) {
		const key = n.parentId ?? "";
		const arr = m.get(key);
		if (arr) arr.push(n);
		else m.set(key, [n]);
	}
	return m;
}

/**
 * Collect a root + all its descendant node ids (BFS over a byParent map).
 * Used by search to narrow matches to a subtree.
 */
function collectSubtree(rootId: string, byParent: Map<string, WikiNode[]>): Set<string> {
	const set = new Set<string>([rootId]);
	const queue = [rootId];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const child of byParent.get(cur) ?? []) {
			if (!set.has(child.id)) {
				set.add(child.id);
				queue.push(child.id);
			}
		}
	}
	return set;
}

function resolveWikiStore(ctx: any): WikiStore | undefined {
	const raw = ctx?.wikiStore;
	if (!raw) return undefined;
	if (typeof raw.getWikiStore === "function") return raw.getWikiStore() as WikiStore;
	if (typeof raw.upsertProjectNode === "function") return raw as WikiStore;
	return undefined;
}

/**
 * v0.8 (读写同界): the session's resolved wiki anchor node ids — the SINGLE
 * boundary for both read and write. Falls back to [] when the context didn't
 * supply anchors (the tool then refuses with a clear error rather than
 * accidentally reading/writing the whole tree).
 */
function resolveAnchorsCtx(ctx: any): string[] {
	const ids = ctx?.wikiAnchorNodeIds;
	return Array.isArray(ids) ? ids : [];
}

/**
 * Resolve a nodeId argument the agent supplied back to a real in-scope node.
 * Accepts, in priority order:
 *   1. a full nodeId (exact wiki.get) — back-compat / internal callers;
 *   2. a short id — "#xxxxxxxx" or bare "xxxxxxxx" (8 hex) — by scanning the
 *      visible-from-anchors set and matching shortIdOf(n.id). Uniform across
 *      UUID leaves and synthetic roots (the agent never sees "wiki-root:...");
 *      collisions are rejected with a "use path" hint (sha1-8 is 32-bit, so
 *      collisions need ~65k nodes in one scope — de facto impossible).
 * Returns the resolved node, or undefined with a reason string so the caller
 * can surface a precise error (not found vs ambiguous).
 */
function resolveNodeIdArg(
	raw: string | undefined,
	anchors: string[],
	wiki: WikiStore,
): { node: WikiNode; ok: true } | { ok: false; reason: string } {
	if (!raw) return { ok: false, reason: "nodeId is required" };
	// 1. exact full id
	const exact = wiki.getVisibleFromAnchors(anchors, raw);
	if (exact) return { node: exact, ok: true };
	// 2. short id ("#xxxxxxxx" or bare 8 hex)
	const bare = raw.startsWith("#") ? raw.slice(1) : raw;
	if (/^[0-9a-f]{8}$/i.test(bare)) {
		const hits = wiki
			.listVisibleFromAnchors(anchors)
			.filter((n) => shortIdOf(n.id).toLowerCase() === bare.toLowerCase());
		if (hits.length === 1) return { node: hits[0], ok: true };
		if (hits.length > 1) {
			return {
				ok: false,
				reason: `short id "#${bare.toLowerCase()}" is ambiguous (${hits.length} nodes) — use the title path instead`,
			};
		}
	}
	return {
		ok: false,
		reason: `node not in scope: ${raw} (use expand/search to get a valid id, or pass a title path)`,
	};
}

/**
 * Synthesize a node's internal `path` from its parent + title. The path carries
 * a type prefix (intent:/header:) inherited from the parent so deriveTypeFromPosition
 * classifies the node correctly; structure nodes (no prefixed ancestor) get a bare
 * title. Title is unique per parent (enforced) → path is unique per parent; the
 * on-disk body filename gets an id suffix in deriveContentFilePath, so no collision.
 * Agent never sees this path.
 */
function synthesizePath(parentPath: string | undefined, title: string): string {
	const m = parentPath?.match(/^(intent|header):/);
	const prefix = m ? `${m[1]}:` : "";
	return `${prefix}${title}`;
}

/**
 * A header/intent node's `path` encodes the workspace file it mirrors
 * (`header:src/runtime/agent-loop.ts`, `intent:docs/req-foo.md`). Strip the
 * type prefix and return the workspace-relative path, or undefined if the path
 * isn't a file-pointer (structure/memory/project nodes). Used by expand's
 * "Source file" line so the agent can Read the underlying file directly.
 */
function sourceFileFromPath(path: string | undefined): string | undefined {
	const m = path?.match(/^(?:header|intent):(.+)$/);
	return m ? m[1] : undefined;
}

/**
 * Resolve a doc-op target to a node, accepting EITHER a nodeId (direct) OR a
 * hierarchical title path like "Parent/Child/Leaf" (walked from the anchor
 * scope, matching each segment against a child's title). Titles are unique per
 * parent (enforced on create/update) so each segment matches at most one child.
 */
function resolveNode(
	target: { nodeId?: string; path?: string },
	anchors: string[],
	wiki: WikiStore,
): WikiNode | undefined {
	if (target.nodeId) {
		// Accept a full nodeId OR a short id ("#xxxxxxxx" / bare 8 hex).
		const r = resolveNodeIdArg(target.nodeId, anchors, wiki);
		return r.ok ? r.node : undefined;
	}
	if (target.path) {
		const segments = target.path.split("/").map((s) => s.trim()).filter(Boolean);
		let cursor: string | undefined = undefined;
		for (const seg of segments) {
			const children = wiki.listVisibleFromAnchors(anchors).filter((n) =>
				// First segment: direct child of any anchor (the scope roots).
				// Subsequent segments: child of the previously matched node.
				cursor === undefined ? anchors.includes(n.parentId ?? "") : n.parentId === cursor,
			);
			const next = children.find((n) => n.title === seg);
			if (!next) return undefined;
			cursor = next.id;
		}
		return cursor ? wiki.getVisibleFromAnchors(anchors, cursor) : undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Flat action schema
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object, not z.discriminatedUnion. LLM tool-calling
// protocols require a top-level `type: object` parameters schema; a top-level
// oneOf/discriminated union is dropped/mis-parsed by most providers (OpenAI/GLM/
// Anthropic), so the model calls the tool with `{}` and zod rejects it. The
// action enum validates the discriminator; per-action required fields are
// checked at runtime in execute.

export const wikiActionSchema = z.object({
	action: z.enum(["expand", "search", "create", "update", "delete", "docRead", "docWrite", "docEdit"]),
	// expand / search / docRead / docWrite / docEdit / update / delete — direct addressing
	nodeId: z.string().optional(),
	// docRead / docWrite / docEdit — hierarchical title path addressing (alt to nodeId)
	path: z.string().optional().describe("Hierarchical title path (e.g. 'Parent/Child') for doc ops — alt to nodeId"),
	// expand — how many descendant levels to include (1 = direct children only,
	// the default; capped at 5). expand NEVER returns node bodies — use docRead.
	depth: z.number().optional().describe("expand: descendant levels to include (1=direct children, default 1, max 5)"),
	// expand — only include nodes of this type in the subtree listing.
	type: z.enum(["structure", "header", "intent"]).optional().describe("expand/search: only match nodes of this type"),
	// expand — only include leaf nodes (nodes with no children). Still walks
	// through non-leaf ancestors to reach deeper leaves, within `depth`.
	leavesOnly: z.boolean().optional().describe("expand: only include leaf nodes (no children)"),
	// search
	query: z.string().optional().describe("Substring query (action:'search')"),
	// search — limit matches to the subtree under this nodeId (narrow within a
	// large session). Accepts a short id like expand's nodeId.
	subtree: z.string().optional().describe("search: limit matches to the subtree under this nodeId"),
	limit: z.number().optional(),
	// docRead — batch: read several nodes' bodies in one call (each entry is a
	// nodeId / short id). Returns each body under a header. Avoids N serial
	// round-trips when exploring a module's docs.
	nodeIds: z.array(z.string()).optional().describe("docRead: batch-read multiple nodes' bodies by id"),
	// create / update
	parentId: z.string().optional().describe("Parent nodeId (action:'create')"),
	title: z.string().optional(),
	summary: z.string().optional(),
	flags: z.array(z.string()).optional(),
	// create (initial body) / docWrite
	content: z.string().optional(),
	// docWrite — must be set to true to overwrite a node that already has a
	// non-empty body (clobber guard). Empty/new bodies write without it.
	overwrite: z.boolean().optional().describe("docWrite: allow overwriting an existing non-empty body (default false)"),
	// docEdit (mirrors Edit: oldString → newString)
	oldString: z.string().optional(),
	newString: z.string().optional(),
	replaceAll: z.boolean().optional().describe("Replace all occurrences (action:'docEdit', default false)"),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const wikiTool = buildTool({
	name: "Wiki",
	description:
		"Operate on the project Wiki. Two groups: STRUCTURE ops (expand/search/create/update/delete nodes; expand/search support type filter + subtree/leaves narrowing) and DOC ops (docRead/docWrite/docEdit a node's body — mirror Read/Write/Edit; docRead supports batch via nodeIds). Address nodes by their 8-char short id (#xxxxxxxx, shown in expand/search/injected outlines), a full nodeId, or a title path. header/intent node paths encode their source file (shown as 'Source file' in expand).",
	prompt:
		"Operate on the project Wiki. Two groups of actions:\n\n" +
		"STRUCTURE (node tree):\n" +
		"- { action:'expand', nodeId, depth?, type?, leavesOnly? } — read a node's STRUCTURE: its metadata (summary/flags/source file) plus its descendants as an indented tree, `depth` levels deep (1 = direct children only, default; max 5). `type` filters the listing to one node type; `leavesOnly` shows only leaf nodes (still walks through non-leaf ancestors to reach deeper leaves). Primary way to navigate and discover nodeIds. Does NOT return any node's body.\n" +
		"- { action:'search', query, limit?, type?, subtree? } — substring search across visible nodes (title/summary). `type` filters matches; `subtree` (a nodeId) narrows the search to that node's subtree — useful inside a large session to avoid noise (e.g. searching 'tool' inside one project only).\n" +
		"- { action:'create', parentId, title, summary?, content? } — create a node under a parent. NO type, NO path: type is inherited from the parent's position; the node name IS the title. Titles must be unique under the same parent (rejected otherwise). content?, if given, is the initial body.\n" +
		"- { action:'update', nodeId, title?, summary?, flags? } — edit a node's metadata. Does NOT touch the body. Changing title must keep it unique among siblings.\n" +
		"- { action:'delete', nodeId } — delete a node (cascades children + body).\n\n" +
		"DOC (a node's body document — mirror Read/Write/Edit, addressed by nodeId OR title path):\n" +
		"- { action:'docRead', nodeId? | path? | nodeIds? } — read a node's body. THE ONLY way to read a node's full body — expand does not include it. `nodeIds` (array) batch-reads several bodies in one call (each entry a nodeId/short id) — use it instead of N serial docReads when exploring a module's docs. path is a hierarchical title path like 'Parent/Child'.\n" +
		"- { action:'docWrite', nodeId? | path?, content, overwrite? } — overwrite the whole body (like Write). If the node already has a non-empty body you MUST pass overwrite:true (otherwise it is rejected with the existing body size — use docEdit for a targeted change instead).\n" +
		"- { action:'docEdit', nodeId? | path?, oldString, newString, replaceAll? } — exact string replace (like Edit). oldString must exist and be unique (or set replaceAll:true to replace every occurrence). No-op/rejected if oldString not found.\n\n" +
		"Rules:\n" +
		"- expand is for STRUCTURE only (metadata + child tree, each child shown with its subtree-abstract summary). To read a node's BODY, use docRead — never expect expand to return body content.\n" +
		"- Identity: every node carries an 8-char short id like #a3f2b1c0 (shown next to the node in expand/search/injected outlines). Pass that short id as nodeId/parentId — it resolves to the node. A full nodeId also works. If two nodes collide on a short id (vanishingly rare), the tool tells you to use the title path instead.\n" +
		"- Title path (doc ops) is HIERARCHICAL and RELATIVE to your scope root, walking child→grandchild by TITLE: 'Knowledge/software-dev 工作流'. The root's own title is NOT part of the path, and a bare leaf name ('software-dev 工作流') only works if that node is a DIRECT child of your scope root. Every segment must match an ancestor along the way — if you don't know the full ancestry, use expand to walk down or search to find the id instead of guessing the path.\n" +
		"- Scope = your wiki anchors (your project subtree + your memory + any free anchors you were granted; the GLOBAL ROOT for global/zero sessions). Read and write share the SAME boundary: you can create/update/delete/docWrite/docEdit exactly the nodes you can expand. Nodes outside your anchors are invisible and unwritable.\n" +
		"- To edit a node's body, use docEdit/docWrite — never update (update is metadata-only).\n" +
		"- Source files: a node whose path starts with `header:` or `intent:` mirrors a workspace file / requirement doc — strip the prefix to get the workspace-relative path (e.g. `header:src/runtime/agent-loop.ts` → `src/runtime/agent-loop.ts`). expand shows this as 'Source file'; you can then Read the file directly instead of reconstructing the path from titles.\n\n" +
		"Node semantics (how to WRITE summary / body — applies to EVERY agent that creates or updates wiki nodes):\n" +
		"- A node's `summary` is the ABSTRACT of the subtree rooted at that node (one line — the essence of what this subtree is about).\n" +
		"- A non-leaf node's `body` (doc) is the OVERVIEW of its subtree (what the children collectively do, how they fit together). Writing a parent's body = writing the subtree overview.\n" +
		"- A leaf node's `body` (doc) is the actual content. For a leaf that mirrors a project file, the body is the file's COMMENTARY/EXPLANATION (what the file is for, its role, gotchas) — NOT a copy of the file itself (the file lives in the workspace; read it with Read).\n" +
		"- So a parent's summary abstracts its body, and its body overviews its children — the two are meant to agree. Keep summaries short (one line) and bodies as overviews (a paragraph or two), not full dumps.",
	meta: {
		category: "runtime",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: wikiActionSchema,
	execute: async (input, ctx) => {
		const wiki = resolveWikiStore(ctx);
		const anchors = resolveAnchorsCtx(ctx);
		if (!wiki) return "Error: wiki context not available";
		if (anchors.length === 0) return "Error: no wiki anchors in this session (scope is empty)";

		switch (input.action) {
			// ── STRUCTURE ────────────────────────────────────────────────
			case "expand": {
				if (!input.nodeId) return "Error: nodeId required for expand";
				const resolved = resolveNodeIdArg(input.nodeId, anchors, wiki);
				if (!resolved.ok) return `Error: ${resolved.reason}`;
				const node = resolved.node;
				// expand is STRUCTURE-only: metadata + a descendant subtree, `depth`
				// levels deep. It deliberately does NOT return any node's body —
				// that's docRead's job. (Previously this dumped the node's full
				// body via readNodeDetail, which duplicated docRead and flooded
				// the result whenever a node had a large document.)
				const depth = Math.max(1, Math.min(input.depth ?? 1, 5));
				const typeFilter = input.type;
				const leavesOnly = input.leavesOnly === true;
				const allVisible = wiki.listVisibleFromAnchors(anchors);
				const byParent = groupByParent(allVisible);
				const treeLines: string[] = [];
				let descendantCount = 0;
				// Nodes hidden by the depth cap: any node at the deepest shown
				// level that itself has children. Surfacing the count tells the
				// agent there's more to expand (raise depth, or expand that node),
				// so a truncated subtree isn't mistaken for a leaf.
				let hiddenNodes = 0;
				const walk = (parentId: string, level: number) => {
					if (level > depth) return;
					const kids = byParent.get(parentId) ?? [];
					for (const k of kids) {
						// Filters only affect whether a node is EMITTED; we still
						// walk into filtered-out ancestors so leavesOnly / type
						// matches at deeper levels are reachable (within depth).
						const isLeaf = (byParent.get(k.id) ?? []).length === 0;
						const typeOk = !typeFilter || k.type === typeFilter;
						const show = typeOk && (!leavesOnly || isLeaf);
						if (show) {
							descendantCount++;
							// Markdown nested list: `- item` with 2-space indent per
							// level renders as a real hierarchical list in the UI
							// (bare leading-space indentation gets collapsed by
							// Markdown and the tree looked flat). Clear to the agent
							// reading raw text too.
							// Child line carries the subtree-abstract summary so expand
							// is more than a flat directory listing (summary = the
							// node's subtree abstract per the Wiki node semantics).
							const childSummary = k.summary ? ` — ${sanitizeText(k.summary)}` : "";
							treeLines.push(`${"  ".repeat(level - 1)}- ${formatNodeId(k.id)} [${k.type}] ${k.title}${childSummary} ${formatBodySize(wiki.getNodeDetailSize(k.id))}`);
						}
						if (level === depth) {
							// At the cap: count this node's children as hidden
							// (they won't be walked) so we can warn they exist.
							hiddenNodes += (byParent.get(k.id) ?? []).length;
						} else {
							walk(k.id, level + 1);
						}
					}
				};
				walk(node.id, 1);
				const filterNote = typeFilter || leavesOnly
					? ` (${typeFilter ? `type=${typeFilter}` : ""}${typeFilter && leavesOnly ? ", " : ""}${leavesOnly ? "leaves only" : ""})`
					: "";
				const hiddenNote = hiddenNodes > 0
					? `\n(${hiddenNodes} more node${hiddenNodes !== 1 ? "s" : ""} hidden below depth ${depth} — raise depth, or expand a specific nodeId to see deeper)`
					: "";
				const subtreeLine = treeLines.length
					? `\nSubtree (depth ${depth}, ${descendantCount} descendant${descendantCount !== 1 ? "s" : ""})${filterNote}:\n` + treeLines.join("\n") + hiddenNote
					: `\nSubtree${filterNote}: (no matching children)`;
				const flags = node.flags?.length ? `\nFlags: ${node.flags.join(", ")}` : "";
				const prov = node.provenance ? `\nProvenance: ${node.provenance}` : "";
				const summary = node.summary ? `\nSummary: ${sanitizeText(node.summary)}` : "";
				const bodySize = `\nBody: ${formatBodySize(wiki.getNodeDetailSize(node.id))}`;
				// A header/intent node's path encodes its source file (e.g.
				// `header:src/runtime/agent-loop.ts`); expose the workspace-relative
				// path so the agent can jump straight to Read without reconstructing
				// it from the title hierarchy.
				const sourceFile = sourceFileFromPath(node.path);
				const sourceLine = sourceFile ? `\nSource file: ${sourceFile}` : "";
				return `nodeId: ${formatNodeId(node.id)}\nTitle: ${node.title}\nType: ${node.type}${prov}${summary}${flags}${bodySize}${sourceLine}${subtreeLine}`;
			}

			case "search": {
				if (!input.query) return "Error: query required for search";
				const q = input.query.toLowerCase();
				const limit = input.limit ?? 50;
				const nodes = wiki.listVisibleFromAnchors(anchors);
				// Optional subtree narrowing: resolve the subtree nodeId, then keep
				// only nodes inside that subtree (root + descendants).
				let subtree: Set<string> | undefined;
				if (input.subtree) {
					const r = resolveNodeIdArg(input.subtree, anchors, wiki);
					if (!r.ok) return `Error: ${r.reason}`;
					subtree = collectSubtree(r.node.id, groupByParent(nodes));
				}
				const typeFilter = input.type;
				const hits = nodes
					// 排除合成子树根容器(wiki-root:*):结构容器无正文,出现在 search 结果里只会让
					// agent 误当内容节点去 docRead 而失败。遍历结构用 expand(根 nodeId 在注入的 outline 里)。
					.filter((n) => !n.id.startsWith("wiki-root:"))
					.filter((n) => !subtree || subtree.has(n.id))
					.filter((n) => !typeFilter || n.type === typeFilter)
					.filter(
						(n) =>
						(n.title?.toLowerCase().includes(q) ?? false) ||
						(n.summary?.toLowerCase().includes(q) ?? false) ||
						(n.path?.toLowerCase().includes(q) ?? false),
				);
				if (hits.length === 0) {
					const scope = subtree ? " in subtree" : "";
					const typeN = typeFilter ? ` (type=${typeFilter})` : "";
					return `(no wiki nodes match "${input.query}"${scope}${typeN})`;
				}
				const sliced = hits.slice(0, limit);
				const truncated = hits.length > sliced.length ? `\n…(${hits.length - sliced.length} more, raise limit to see)` : "";
				return sliced
					.map((n) => `${formatNodeId(n.id)} | ${n.type} | ${n.title} ${formatBodySize(wiki.getNodeDetailSize(n.id))}\n   ${sanitizeText(n.summary)}`)
					.join("\n") + truncated;
			}

			case "create": {
				if (!input.parentId) return "Error: parentId required for create";
				if (!input.title) return "Error: title required for create";
				// Parent must be visible in scope (accepts short id / full id).
				const resolvedParent = resolveNodeIdArg(input.parentId, anchors, wiki);
				if (!resolvedParent.ok) return `Error: parent ${resolvedParent.reason}`;
				const parent = resolvedParent.node;
				// Enforce title uniqueness among siblings (keeps title-path addressing unambiguous).
				const siblings = wiki
					.listVisibleFromAnchors(anchors)
					.filter((n) => n.parentId === parent.id);
				if (siblings.some((n) => n.title === input.title)) {
					return `Error: a sibling already has the title "${input.title}" — titles must be unique under the same parent`;
				}
				const path = synthesizePath(parent.path, input.title);
				// type column was dropped; position (path prefix) now carries type.
				// Inherit the type from the parent's path prefix so the row is
				// consistent with its position.
				const inheritedType: "header" | "intent" | "structure" = parent.path?.startsWith("intent:")
					? "intent"
					: parent.path?.startsWith("header:")
						? "header"
						: "structure";
				try {
					const created = wiki.upsertNodeInScope(anchors, {
						parentId: parent.id,
						type: inheritedType,
						path,
						title: input.title,
						summary: input.summary,
						detail: input.content,
						lastUpdatedBy: "agent",
					});
					return `Wiki node created: ${formatNodeId(created.id)} | ${created.title}`;
				} catch (err) {
					return `Create rejected: ${(err as Error).message}`;
				}
			}

			case "update": {
				if (!input.nodeId) return "Error: nodeId required for update";
				const resolved = resolveNodeIdArg(input.nodeId, anchors, wiki);
				if (!resolved.ok) return `Error: ${resolved.reason}`;
				const node = resolved.node;
				const patch: Record<string, unknown> = {};
				if (input.title !== undefined) patch.title = input.title;
				if (input.summary !== undefined) patch.summary = input.summary;
				if (input.flags !== undefined) patch.flags = input.flags;
				if (Object.keys(patch).length === 0) {
					return "Error: nothing to update — provide title/summary/flags";
				}
				// If renaming, enforce sibling title uniqueness.
				if (patch.title !== undefined && patch.title !== node.title) {
					const siblings = wiki
						.listVisibleFromAnchors(anchors)
						.filter((n) => n.parentId === node.parentId && n.id !== node.id);
					if (siblings.some((n) => n.title === patch.title)) {
						return `Error: a sibling already has the title "${patch.title}" — titles must be unique under the same parent`;
					}
				}
				try {
					const updated = wiki.updateNodeInScope(anchors, node.id, {
						...patch,
						lastUpdatedBy: "agent",
					});
					return `Wiki node updated: ${formatNodeId(updated.id)} | ${updated.title}`;
				} catch (err) {
					return `Update rejected: ${(err as Error).message}`;
				}
			}

			case "delete": {
				if (!input.nodeId) return "Error: nodeId required for delete";
				const resolved = resolveNodeIdArg(input.nodeId, anchors, wiki);
				if (!resolved.ok) return `Error: ${resolved.reason}`;
				const node = resolved.node;
				try {
					wiki.deleteNodeInScope(anchors, node.id);
					return `Wiki node deleted: ${formatNodeId(node.id)}`;
				} catch (err) {
					return `Delete rejected: ${(err as Error).message}`;
				}
			}

			// ── DOC (body document) ──────────────────────────────────────
			case "docRead": {
				// Batch: read several nodes' bodies in one call (each entry a
				// nodeId / short id). Avoids N serial round-trips when exploring
				// a module with many leaf docs. Each body is returned under a
				// header; a failed resolve for one entry doesn't abort the rest.
				if (input.nodeIds && input.nodeIds.length > 0) {
					const parts: string[] = [];
					for (const raw of input.nodeIds) {
						const r = resolveNodeIdArg(raw, anchors, wiki);
						if (!r.ok) {
							parts.push(`=== ${raw} ===\nError: ${r.reason}`);
							continue;
						}
						const body = wiki.readNodeDetail(r.node.id);
						parts.push(
							`=== ${formatNodeId(r.node.id)} | ${r.node.title} ===\n` +
							(body ?? "(no body document yet — use docWrite to create one)"),
						);
					}
					return parts.join("\n\n");
				}
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docRead";
				const node = resolveNode(input, anchors, wiki);
				if (!node) return `Error: node not found (${input.nodeId ?? input.path})`;
				const body = wiki.readNodeDetail(node.id);
				if (body === undefined) return `(node "${node.title}" has no body document yet — use docWrite to create one)`;
				return body;
			}

			case "docWrite": {
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docWrite";
				if (input.content === undefined) return "Error: content required for docWrite";
				const node = resolveNode(input, anchors, wiki);
				if (!node) return `Error: node not found (${input.nodeId ?? input.path})`;
				// Clobber guard: refuse to overwrite a non-empty body unless the
				// caller explicitly passes overwrite:true. Surfaces the existing
				// body's size so the agent can decide to clobber or docEdit.
				const existing = wiki.readNodeDetail(node.id) ?? "";
				if (existing.length > 0 && !input.overwrite) {
					return `Error: node "${node.title}" already has a ${existing.length}-char body (${formatBodySize(wiki.getNodeDetailSize(node.id))}). Set overwrite:true to replace it, or use docEdit for a targeted change.`;
				}
				try {
					wiki.writeNodeDetailInScope(anchors, node.id, input.content);
					return `Document written: ${formatNodeId(node.id)} | ${node.title}`;
				} catch (err) {
					return `docWrite rejected: ${(err as Error).message}`;
				}
			}

			case "docEdit": {
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docEdit";
				if (input.oldString === undefined || input.newString === undefined) {
					return "Error: oldString and newString required for docEdit";
				}
				const node = resolveNode(input, anchors, wiki);
				if (!node) return `Error: node not found (${input.nodeId ?? input.path})`;
				const body = wiki.readNodeDetail(node.id) ?? "";
				const { oldString, newString } = input;
				if (oldString === "") return "Error: oldString must be non-empty";
				if (!body.includes(oldString)) {
					return `Error: oldString not found in document — no edit applied`;
				}
				const count = body.split(oldString).length - 1;
				if (count > 1 && !input.replaceAll) {
					return `Error: oldString is not unique (${count} occurrences) — set replaceAll:true to replace all, or provide more context to make it unique`;
				}
				let next: string;
				if (input.replaceAll) {
					next = body.split(oldString).join(newString);
				} else {
					next = body.replace(oldString, newString);
				}
				try {
					wiki.writeNodeDetailInScope(anchors, node.id, next);
					return `Document edited: ${formatNodeId(node.id)} | ${node.title} (${input.replaceAll ? count : 1} replacement${input.replaceAll && count !== 1 ? "s" : ""})`;
				} catch (err) {
					return `docEdit rejected: ${(err as Error).message}`;
				}
			}
		}
		// Exhaustiveness fallback (unreachable if schema validates).
		return `Error: unknown wiki action`;
	},
});
