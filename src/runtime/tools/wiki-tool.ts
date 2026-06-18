// Wiki action 工具 (v0.8 P3 — §10.7)
//
// # 文件说明书
//
// ## 核心功能
// "Wiki" 是 v0.8 P3 四个判别联合 action 工具之一。一个工具 + action 字段
// 切换 4 个操作 (§10.7):
//   - expand   读节点详情(P1 ExpandNode)
//   - read     读项目文档(P1 ReadDoc)
//   - upsert   upsert 项目子树节点(P1 UpdateWikiNode)
//   - search   简单子串搜索(P3 新增;P5 全文检索细化)
//
// scope = caller 锚点并集(P1 §10.6 + 决策 38):由 WikiStore.listVisibleFromRoot
// 在 store 层强制,session 的 wikiRootNodeId 之外不可见。
//
// ## 命名 (§7.3 硬原则)
// 原 ExpandNode / ReadDoc / UpdateWikiNode / ListWikiTree 四个分散工具
// 合并到此 "Wiki"。注意:这些原工具仍保留在 wiki-tools.ts 中导出(供
// archivist session 用同名字面调用,P3 不强制改 archivist 的 toolPolicy);
// 本工具是给 zero / lead / PM 用的"统一入口"。
//
// ## 输入
// - ctx.wikiStore (ProjectWikiStore 兼容层 → .getWikiStore() 取真 WikiStore)
//
// ## 输出
// - export const wikiTool
//

import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";
import { buildTool } from "./tool-factory.js";
import type { WikiStore } from "../../server/wiki-node-store.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
} from "../../server/wiki-node-store.js";

// ---------------------------------------------------------------------------
// Helpers (mirror wiki-tools.ts; P3 doesn't merge that file — archivist still
// uses the named tools there. P5 may consolidate.)
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

// ---------------------------------------------------------------------------
// Discriminated-union schema
// ---------------------------------------------------------------------------

const wikiActionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("expand"),
		nodeId: z.string(),
	}),
	z.object({
		action: z.literal("read"),
		path: z.string().describe("Workspace-relative path or wiki docPointer"),
	}),
	z.object({
		action: z.literal("upsert"),
		parentId: z.string(),
		type: z.enum(["header", "intent", "structure"]),
		path: z.string(),
		title: z.string().optional(),
		summary: z.string().optional(),
		detail: z.string().optional(),
		provenance: z.enum(["structure", "derived", "confirmed"]).optional(),
		requirementIds: z.array(z.string()).optional(),
		flags: z.array(z.string()).optional(),
	}),
	z.object({
		action: z.literal("search"),
		query: z.string().describe("Substring or simple keyword query"),
		limit: z.number().optional(),
	}),
]);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const wikiTool = buildTool({
	name: "Wiki",
	description:
		"Read + write the project Wiki tree. Action-switched: expand/read/upsert/search. Scope = caller's anchor union (project subtree).",
	prompt:
		"Operate on the project Wiki via a single action-switched tool.\n\n" +
		"Actions:\n" +
		"- { action:'expand', nodeId } — read a node's detail (scoped to your wikiRootNodeId).\n" +
		"- { action:'read', path } — read a project document (code/requirement/ADR) by workspace-relative path or wiki docPointer. Read-only.\n" +
		"- { action:'upsert', parentId, type, path, title?, summary?, detail?, ... } — upsert a node in YOUR project subtree. type ∈ header|intent|structure. Write scope is hard-enforced in the store layer.\n" +
		"- { action:'search', query, limit? } — substring search across visible wiki nodes (title/summary/path). P3 simple match; P5 lands full-text.\n\n" +
		"Scope is the caller's anchor union — you cannot see other projects' subtrees.",
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
			case "expand": {
				const node = wiki.getVisible(viewRoot, input.nodeId);
				if (!node) return `Wiki node not visible from this view: ${input.nodeId}`;
				const detail = wiki.readNodeDetail(input.nodeId);
				if (detail) return detail;
				const flags = node.flags?.length ? `\nFlags: ${node.flags.join(", ")}` : "";
				const prov = node.provenance ? `\nProvenance: ${node.provenance}` : "";
				return `Node: ${node.title}\nPath: ${node.path}\nType: ${node.type}${prov}\nSummary: ${node.summary || "No summary"}${flags}`;
			}
			case "read": {
				const workspaceDir = ctx?.contextBundle?.workspaceDir ?? ctx?.workingDir ?? "";
				if (!workspaceDir) return "Error: workspace dir not available";
				const rel = input.path.replace(/^(header|intent|structure|memory|project):/, "");
				const abs = resolve(workspaceDir, rel);
				const relCheck = relative(workspaceDir, abs);
				if (isAbsolute(relCheck) || relCheck.startsWith("..")) {
					return `Read rejected: '${rel}' is outside the workspace.`;
				}
				try {
					const content = readFileSync(abs, "utf-8");
					const max = 20000;
					if (content.length <= max) return content;
					return content.slice(0, max) + `\n\n[truncated: ${content.length} → ${max} chars]`;
				} catch (err) {
					return `Read failed: ${(err as Error).message}`;
				}
			}
			case "upsert": {
				const projectId = ctx?.projectId;
				if (!projectId) return "Error: projectId not available";
				try {
					wiki.upsertProjectNode(projectId, {
						parentId: input.parentId,
						type: input.type,
						path: input.path,
						title: input.title ?? input.path,
						summary: input.summary,
						detail: input.detail,
						provenance: input.provenance,
						requirementIds: input.requirementIds,
						flags: input.flags,
						lastUpdatedBy: ctx.agentRole ?? "agent",
					});
					return `Wiki node upserted: ${input.path}`;
				} catch (err) {
					return `Write rejected: ${(err as Error).message}`;
				}
			}
			case "search": {
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
					.map((n) => `${n.id} | ${n.type} | ${n.path} | ${n.title}\n   ${n.summary ?? ""}`)
					.join("\n");
			}
		}
		// Exhaustiveness fallback (unreachable if schema validates).
		return `Error: unknown wiki action`;
	},
});
