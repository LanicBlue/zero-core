// Wiki action 工具 (v0.8 — 结构操作 / 文档操作 拆分)
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
// ## 设计依据
// - schema 必须顶层 z.object(非 discriminatedUnion):LLM 函数调用协议要求
//   顶层 type:object。见 project-v08-tool-hardening §2。
// - scope 在 store 层强制(assertNodeInsideProjectScope);全局根只读。
// - 子代理/无 project 的 session 不能写(create/update/delete/docWrite/docEdit
//   要求 ctx.projectId)。
//
// ## 输入
// - ctx.wikiStore (ProjectWikiStore 兼容层 → .getWikiStore() 取真 WikiStore)
// - ctx.projectId / ctx.contextBundle.wikiRootNodeId (scope 根)
//
// ## 输出
// - export const wikiTool / wikiActionSchema
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { WikiStore } from "../../server/wiki-node-store.js";
import type { WikiNode } from "../../shared/types.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
} from "../../server/wiki-node-store.js";

// ---------------------------------------------------------------------------
// Helpers — wiki store resolution + scope root + node addressing
// ---------------------------------------------------------------------------

function resolveWikiStore(ctx: any): WikiStore | undefined {
	const raw = ctx?.wikiStore;
	if (!raw) return undefined;
	if (typeof raw.getWikiStore === "function") return raw.getWikiStore() as WikiStore;
	if (typeof raw.upsertProjectNode === "function") return raw as WikiStore;
	return undefined;
}

function resolveViewRoot(ctx: any): string | undefined {
	const fromBundle = ctx?.contextBundle?.wikiRootNodeId;
	if (typeof fromBundle === "string" && fromBundle) return fromBundle;
	if (ctx?.projectId) return projectSubtreeRootId(ctx.projectId);
	return WIKI_GLOBAL_ROOT_ID;
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
 * Resolve a doc-op target to a node, accepting EITHER a nodeId (direct) OR a
 * hierarchical title path like "Parent/Child/Leaf" (walked from the scope root,
 * matching each segment against a child's title). Titles are unique per parent
 * (enforced on create/update) so each segment matches at most one child.
 */
function resolveNode(
	target: { nodeId?: string; path?: string },
	viewRoot: string,
	wiki: WikiStore,
): WikiNode | undefined {
	if (target.nodeId) {
		return wiki.getVisible(viewRoot, target.nodeId);
	}
	if (target.path) {
		const segments = target.path.split("/").map((s) => s.trim()).filter(Boolean);
		let cursor: string | undefined = viewRoot;
		for (const seg of segments) {
			const children = wiki.listVisibleFromRoot(viewRoot).filter((n) => n.parentId === cursor);
			const next = children.find((n) => n.title === seg);
			if (!next) return undefined;
			cursor = next.id;
		}
		return cursor ? wiki.getVisible(viewRoot, cursor) : undefined;
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
	// expand / docRead / docWrite / docEdit / update / delete — direct addressing
	nodeId: z.string().optional(),
	// docRead / docWrite / docEdit — hierarchical title path addressing (alt to nodeId)
	path: z.string().optional().describe("Hierarchical title path (e.g. 'Parent/Child') for doc ops — alt to nodeId"),
	// search
	query: z.string().optional().describe("Substring query (action:'search')"),
	limit: z.number().optional(),
	// create / update
	parentId: z.string().optional().describe("Parent nodeId (action:'create')"),
	title: z.string().optional(),
	summary: z.string().optional(),
	flags: z.array(z.string()).optional(),
	// create (initial body) / docWrite
	content: z.string().optional(),
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
		"Operate on the project Wiki. Two groups: STRUCTURE ops (expand/search/create/update/delete nodes) and DOC ops (docRead/docWrite/docEdit a node's body — mirror Read/Write/Edit). Identity by nodeId (or title path for doc ops).",
	prompt:
		"Operate on the project Wiki. Two groups of actions:\n\n" +
		"STRUCTURE (node tree):\n" +
		"- { action:'expand', nodeId } — read a node (summary + body + its children ids/titles). Primary way to navigate and discover nodeIds.\n" +
		"- { action:'search', query, limit? } — substring search across visible nodes (title/summary).\n" +
		"- { action:'create', parentId, title, summary?, content? } — create a node under a parent. NO type, NO path: type is inherited from the parent's position; the node name IS the title. Titles must be unique under the same parent (rejected otherwise). content?, if given, is the initial body.\n" +
		"- { action:'update', nodeId, title?, summary?, flags? } — edit a node's metadata. Does NOT touch the body. Changing title must keep it unique among siblings.\n" +
		"- { action:'delete', nodeId } — delete a node (cascades children + body).\n\n" +
		"DOC (a node's body document — mirror Read/Write/Edit, addressed by nodeId OR title path):\n" +
		"- { action:'docRead', nodeId? | path? } — read the node's body. path is a hierarchical title path like 'Parent/Child'.\n" +
		"- { action:'docWrite', nodeId? | path?, content } — overwrite the whole body (like Write).\n" +
		"- { action:'docEdit', nodeId? | path?, oldString, newString, replaceAll? } — exact string replace (like Edit). oldString must exist and be unique (or set replaceAll:true to replace every occurrence). No-op/rejected if oldString not found.\n\n" +
		"Rules:\n" +
		"- Identity is nodeId (the primary key). Get nodeIds from expand/search results — this is the reliable way to address a node. Doc ops also accept a title path as a convenience.\n" +
		"- Title path (doc ops) is HIERARCHICAL and RELATIVE to your scope root, walking child→grandchild by TITLE: 'Knowledge/software-dev 工作流'. The root's own title is NOT part of the path, and a bare leaf name ('software-dev 工作流') only works if that node is a DIRECT child of your scope root. Every segment must match an ancestor along the way — if you don't know the full ancestry, use expand to walk down or search to find the nodeId instead of guessing the path.\n" +
		"- Scope = your project subtree (or the global root for global sessions). The GLOBAL ROOT is read-only (expand/search only). Writes require a projectId in your session.\n" +
		"- To edit a node's body, use docEdit/docWrite — never update (update is metadata-only).",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: wikiActionSchema,
	execute: async (input, ctx) => {
		const wiki = resolveWikiStore(ctx);
		const viewRoot = resolveViewRoot(ctx);
		if (!wiki || !viewRoot) return "Error: wiki context not available";

		switch (input.action) {
			// ── STRUCTURE ────────────────────────────────────────────────
			case "expand": {
				if (!input.nodeId) return "Error: nodeId required for expand";
				const node = wiki.getVisible(viewRoot, input.nodeId);
				if (!node) return `Wiki node not visible from this view: ${input.nodeId}`;
				const children = wiki
					.listVisibleFromRoot(viewRoot)
					.filter((n) => n.parentId === input.nodeId)
					.map((n) => `${n.id} [${n.type}] ${n.title}`);
				const childrenLine = children.length
					? `\nChildren (${children.length}):\n  ` + children.join("\n  ")
					: "\nChildren: (none)";
				const detail = wiki.readNodeDetail(input.nodeId);
				if (detail) return detail + childrenLine;
				const flags = node.flags?.length ? `\nFlags: ${node.flags.join(", ")}` : "";
				const prov = node.provenance ? `\nProvenance: ${node.provenance}` : "";
				const summary = node.summary ? `\nSummary: ${node.summary}` : "";
				return ` nodeId: ${node.id}\nTitle: ${node.title}\nType: ${node.type}${prov}${summary}${flags}${childrenLine}`;
			}

			case "search": {
				if (!input.query) return "Error: query required for search";
				const q = input.query.toLowerCase();
				const limit = input.limit ?? 50;
				const nodes = wiki.listVisibleFromRoot(viewRoot);
				const hits = nodes.filter(
					(n) =>
						(n.title?.toLowerCase().includes(q) ?? false) ||
						(n.summary?.toLowerCase().includes(q) ?? false) ||
						(n.path?.toLowerCase().includes(q) ?? false),
				);
				const sliced = hits.slice(0, limit);
				if (sliced.length === 0) return `(no wiki nodes match "${input.query}")`;
				return sliced
					.map((n) => `${n.id} | ${n.type} | ${n.title}\n   ${n.summary ?? ""}`)
					.join("\n");
			}

			case "create": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available (create requires project context)";
				if (!input.parentId) return "Error: parentId required for create";
				if (!input.title) return "Error: title required for create";
				// Parent must be visible in scope.
				const parent = wiki.getVisible(viewRoot, input.parentId);
				if (!parent) return `Error: parent not in scope: ${input.parentId}`;
				// Enforce title uniqueness among siblings (keeps title-path addressing unambiguous).
				const siblings = wiki
					.listVisibleFromRoot(viewRoot)
					.filter((n) => n.parentId === input.parentId);
				if (siblings.some((n) => n.title === input.title)) {
					return `Error: a sibling already has the title "${input.title}" — titles must be unique under the same parent`;
				}
				const path = synthesizePath(parent.path, input.title);
				// type column was dropped; position (path prefix) now carries type.
				// upsertProjectNode's signature still requires a type — pass the
				// parent-inherited type so the row is consistent with its path.
				const inheritedType: "header" | "intent" | "structure" = parent.path?.startsWith("intent:")
					? "intent"
					: parent.path?.startsWith("header:")
						? "header"
						: "structure";
				try {
					const created = wiki.upsertProjectNode(projectId, {
						parentId: input.parentId,
						type: inheritedType,
						path,
						title: input.title,
						summary: input.summary,
						detail: input.content,
						lastUpdatedBy: ctx.agentRole ?? "agent",
					});
					return `Wiki node created: ${created.id} | ${created.title}`;
				} catch (err) {
					return `Create rejected: ${(err as Error).message}`;
				}
			}

			case "update": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available (update requires project context)";
				if (!input.nodeId) return "Error: nodeId required for update";
				const node = wiki.getVisible(viewRoot, input.nodeId);
				if (!node) return `Error: node not in scope: ${input.nodeId}`;
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
						.listVisibleFromRoot(viewRoot)
						.filter((n) => n.parentId === node.parentId && n.id !== node.id);
					if (siblings.some((n) => n.title === patch.title)) {
						return `Error: a sibling already has the title "${patch.title}" — titles must be unique under the same parent`;
					}
				}
				try {
					const updated = wiki.updateNodeMetadata(projectId, input.nodeId, {
						...patch,
						lastUpdatedBy: ctx.agentRole ?? "agent",
					});
					return `Wiki node updated: ${updated.id} | ${updated.title}`;
				} catch (err) {
					return `Update rejected: ${(err as Error).message}`;
				}
			}

			case "delete": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available (delete requires project context)";
				if (!input.nodeId) return "Error: nodeId required for delete";
				const node = wiki.getVisible(viewRoot, input.nodeId);
				if (!node) return `Error: node not in scope: ${input.nodeId}`;
				try {
					wiki.deleteNode(projectId, input.nodeId);
					return `Wiki node deleted: ${input.nodeId}`;
				} catch (err) {
					return `Delete rejected: ${(err as Error).message}`;
				}
			}

			// ── DOC (body document) ──────────────────────────────────────
			case "docRead": {
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docRead";
				const node = resolveNode(input, viewRoot, wiki);
				if (!node) return `Error: node not found (${input.nodeId ?? input.path})`;
				const body = wiki.readNodeDetail(node.id);
				if (body === undefined) return `(node "${node.title}" has no body document yet — use docWrite to create one)`;
				return body;
			}

			case "docWrite": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available (docWrite requires project context)";
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docWrite";
				if (input.content === undefined) return "Error: content required for docWrite";
				const node = resolveNode(input, viewRoot, wiki);
				if (!node) return `Error: node not found (${input.nodeId ?? input.path})`;
				try {
					wiki.writeNodeDetail(node.id, input.content);
					return `Document written: ${node.id} | ${node.title}`;
				} catch (err) {
					return `docWrite rejected: ${(err as Error).message}`;
				}
			}

			case "docEdit": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available (docEdit requires project context)";
				if (!input.nodeId && !input.path) return "Error: nodeId or path required for docEdit";
				if (input.oldString === undefined || input.newString === undefined) {
					return "Error: oldString and newString required for docEdit";
				}
				const node = resolveNode(input, viewRoot, wiki);
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
					wiki.writeNodeDetail(node.id, next);
					return `Document edited: ${node.id} | ${node.title} (${input.replaceAll ? count : 1} replacement${input.replaceAll && count !== 1 ? "s" : ""})`;
				} catch (err) {
					return `docEdit rejected: ${(err as Error).message}`;
				}
			}
		}
		// Exhaustiveness fallback (unreachable if schema validates).
		return `Error: unknown wiki action`;
	},
});
