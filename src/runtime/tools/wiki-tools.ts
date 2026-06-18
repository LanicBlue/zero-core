// Wiki 工具 (v0.8 M2 — 全局记忆树 + 写入守卫)
//
// # 文件说明书
//
// ## 核心功能
// archivist 维护 project wiki 子树结构的 LLM 工具。三个工具,职责严格分离
// (RFC §2.16 / §2.17a / 决策 39):
//
//   - **ExpandNode** (read-only)  — 读 wiki 节点详情。按 session 的 wikiRootNodeId
//     截断查询(store 层强制),项目角色 session 看不到别的 project、看不到全
//     局 memory 上层(决策 38)。
//   - **ListWikiTree** (read-only)— 列出当前视角下的 wiki 子树。同样按
//     wikiRootNodeId 截断。
//   - **UpdateWikiNode** (write)  — upsert wiki 节点。**只对 wiki 树有写能力**,
//     限自己 project 子树(WikiStore.upsertProjectNode 在 store 层强制);类型只能
//     header/intent/structure。memory 节点归 M5 提取者 A。
//   - **ReadDoc** (read-only)     — 读项目文档(代码/需求文档/ADR)的实际内容。
//     对项目文档**只读**,无写工具。这是「archivist 写入守卫 = prompt 自约束
//     + 工具能力,不走 AST/hook」的物化(决策 39)—— archivist 没有 Write/Edit,
//     自然写不了代码 / 需求文档内容。
//
// ## 输入
// - ToolExecutionContext(需 wikiStore + contextBundle.wikiRootNodeId + projectId)
//
// ## 输出
// - 节点详情 / 子树列表 / upsert 结果 / doc 内容
//
// ## 定位
// Runtime 工具,被 archivist 角色 agent 调用。
//
// ## 依赖
// - zod
// - ./tool-factory
// - ../../server/wiki-node-store (via ctx.wikiStore.getWikiStore())
//
// ## 维护规则
// - 写入只能经 WikiStore.upsertProjectNode(store 层 scope guard)
// - 读项目文档必须留在 workspaceDir 子树内(防越权读其他目录)
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
// Helpers — resolve the WikiStore from the legacy ctx.wikiStore field
// ---------------------------------------------------------------------------

/**
 * ctx.wikiStore 在 server/index.ts 里被注入为 ProjectWikiStore(兼容层)。
 * 真正的全局 WikiStore 通过 .getWikiStore() 取。新代码统一从这里拿。
 */
function resolveWikiStore(ctx: any): WikiStore | undefined {
	const raw = ctx?.wikiStore;
	if (!raw) return undefined;
	if (typeof raw.getWikiStore === "function") return raw.getWikiStore() as WikiStore;
	// Already a WikiStore.
	if (typeof raw.upsertProjectNode === "function") return raw as WikiStore;
	return undefined;
}

function resolveViewRoot(ctx: any): string | undefined {
	// 优先用 session 上下文 bundle 里的 wikiRootNodeId(决策 38)。
	const fromBundle = ctx?.contextBundle?.wikiRootNodeId;
	if (typeof fromBundle === "string" && fromBundle) return fromBundle;
	// Fallback: derive from projectId(项目角色 session 默认根)。
	if (ctx?.projectId) return projectSubtreeRootId(ctx.projectId);
	// 全局 session 兜底。
	return WIKI_GLOBAL_ROOT_ID;
}

// ---------------------------------------------------------------------------
// ExpandNode — read a Wiki node's detail (view-truncated)
// ---------------------------------------------------------------------------

export const expandNodeTool = buildTool({
	name: "ExpandNode",
	description: "Read a Wiki node's detailed content within the current view scope.",
	prompt: "Expand a Wiki node to read its detailed content.\n\n" +
		"Use when you need to understand a specific file, module, or component in depth.\n" +
		"Input: { nodeId } — the Wiki node id.\n" +
		"Returns: the node's detail field, or a summary if detail is not yet expanded.\n" +
		"Notes: scoped to the session's wikiRootNodeId — project-role sessions cannot " +
		"see other projects' subtrees or the global memory upper structure (decision 38).",

	meta: { category: "agent", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },

	inputSchema: z.object({
		nodeId: z.string().describe("Wiki node id"),
	}),

	execute: async (input, ctx) => {
		const wiki = resolveWikiStore(ctx);
		const viewRoot = resolveViewRoot(ctx);
		if (!wiki || !viewRoot) {
			return "Error: wiki context not available";
		}
		const node = wiki.getVisible(viewRoot, input.nodeId);
		if (!node) {
			return `Wiki node not visible from this view: ${input.nodeId}`;
		}
		// v0.8 (P1 §10.1): node body content lives on disk; read it through
		// the WikiStore (never expose the file path to the agent).
		const detail = wiki.readNodeDetail(input.nodeId);
		if (detail) return detail;
		const flags = node.flags?.length ? `\nFlags: ${node.flags.join(", ")}` : "";
		const prov = node.provenance ? `\nProvenance: ${node.provenance}` : "";
		const ptr = node.docPointer ? `\nDoc pointer: (internal)` : "";
		return `Node: ${node.title}\nPath: ${node.path}\nType: ${node.type}${prov}${ptr}\nSummary: ${node.summary || "No summary"}${flags}\n\n(Detail not yet expanded. Use UpdateWikiNode to add detail.)`;
	},
});

// ---------------------------------------------------------------------------
// ListWikiTree — list visible subtree
// ---------------------------------------------------------------------------

export const listWikiTreeTool = buildTool({
	name: "ListWikiTree",
	description: "List all Wiki nodes visible from the current session view root.",
	prompt: "List the Wiki subtree visible from this session's wikiRootNodeId.\n\n" +
		"Returns a flat list of nodes (id, type, path, title, summary). Project-role " +
		"sessions only see their own project subtree (decision 38).",

	meta: { category: "agent", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },

	inputSchema: z.object({}),

	execute: async (_input, ctx) => {
		const wiki = resolveWikiStore(ctx);
		const viewRoot = resolveViewRoot(ctx);
		if (!wiki || !viewRoot) return "Error: wiki context not available";
		const nodes = wiki.listVisibleFromRoot(viewRoot);
		if (nodes.length === 0) return "(empty wiki subtree)";
		return nodes
			.map((n) => {
				const flags = n.flags?.length ? ` [${n.flags.join(",")}]` : "";
				return `${n.id} | ${n.type} | ${n.path} | ${n.title}${flags}\n   ${n.summary ?? ""}`;
			})
			.join("\n");
	},
});

// ---------------------------------------------------------------------------
// UpdateWikiNode — upsert a node inside the project subtree (write-scoped)
// ---------------------------------------------------------------------------

const UPSERT_TYPE_ENUM = z.enum(["header", "intent", "structure"]);

export const updateWikiNodeTool = buildTool({
	name: "UpdateWikiNode",
	description:
		"Create or update a Wiki node in this project's subtree. Upsert semantics.",
	prompt: "Create or update a Wiki node in the project subtree you serve.\n\n" +
		"Upsert: if a node at (parentId, path) exists, update; else create.\n\n" +
		"WRITE SCOPE — hard-enforced in the store layer (decision 39):\n" +
		"  - target parentId MUST already live in YOUR project subtree;\n" +
		"  - type MUST be one of header | intent | structure (memory nodes belong\n" +
		"    to extractor A, M5 — not you);\n" +
		"  - you have NO write tool for code or requirement docs. The wiki tree is\n" +
		"    your only writable surface; everything else is read-only.\n\n" +
		"Inputs:\n" +
		"- parentId (required) — parent node id in your project subtree\n" +
		"- type — header | intent | structure\n" +
		"- path (required) — node path, e.g. 'header:src/runtime/agent-loop.ts'\n" +
		"- title — display title\n" +
		"- summary / detail — node content\n" +
		"- provenance — structure | derived | confirmed (§2.17a)\n" +
		"- requirementIds — traceability (§4.6)\n" +
		"- flags — divergence flags (rarely set by you; archivist-service normally does)\n\n" +
		"docPointer is NOT an input — it is a code-internal cache of the node's " +
		"body content file path, derived by the store (P1 §10.1). Project-file " +
		"references belong in the node body as markdown links.",

	meta: { category: "agent", isReadOnly: false, isConcurrencySafe: false, isDestructive: false },

	inputSchema: z.object({
		parentId: z.string().describe("Parent node id within your project subtree"),
		type: UPSERT_TYPE_ENUM.describe("header | intent | structure"),
		path: z.string().describe("Node path, e.g. 'header:src/runtime/agent-loop.ts'"),
		title: z.string().optional().describe("Display title"),
		summary: z.string().optional().describe("Shallow summary"),
		detail: z.string().optional().describe("Detailed content"),
		provenance: z.enum(["structure", "derived", "confirmed"]).optional(),
		requirementIds: z.array(z.string()).optional(),
		flags: z.array(z.string()).optional(),
	}),

	execute: async (input, ctx) => {
		const wiki = resolveWikiStore(ctx);
		const projectId = ctx?.projectId;
		if (!wiki || !projectId) {
			return "Error: wiki context / projectId not available";
		}
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
				lastUpdatedBy: ctx.agentRole ?? "archivist",
			});
			return `Wiki node upserted: ${input.path}`;
		} catch (err) {
			// Write scope violation surfaced as a tool error (the LLM sees the
			// reason and self-corrects). RFC §2.16 / OQ1 / decision 39.
			return `Write rejected: ${(err as Error).message}`;
		}
	},
});

// ---------------------------------------------------------------------------
// ReadDoc — read a project document (read-only)
// ---------------------------------------------------------------------------

export const readDocTool = buildTool({
	name: "ReadDoc",
	description:
		"Read a project document (code / requirement doc / ADR) by its wiki docPointer or workspace-relative path.",
	prompt: "Read a project document from disk by its wiki docPointer (or workspace-relative path).\n\n" +
		"Use to inspect code structure or read requirement docs — your view into the project's artifacts.\n" +
		"Read-only: you have no write tool for project documents (decision 39).\n\n" +
		"Input: { path } — workspace-relative path or docPointer (e.g. 'src/runtime/agent-loop.ts').\n" +
		"Returns: the document content (truncated).",

	meta: { category: "agent", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },

	inputSchema: z.object({
		path: z.string().describe("Workspace-relative path or wiki docPointer"),
	}),

	execute: async (input, ctx) => {
		const workspaceDir = ctx?.contextBundle?.workspaceDir
			?? ctx?.workingDir
			?? "";
		if (!workspaceDir) return "Error: workspace dir not available";

		// Strip "header:"/"intent:" prefixes if the caller passed a docPointer.
		const rel = input.path.replace(/^(header|intent|structure|memory|project):/, "");
		const abs = resolve(workspaceDir, rel);
		// Confine to workspaceDir subtree (no escape via ../..).
		const relCheck = relative(workspaceDir, abs);
		if (isAbsolute(relCheck) || relCheck.startsWith("..")) {
			return `Read rejected: '${rel}' is outside the workspace.`;
		}
		try {
			const content = readFileSync(abs, "utf-8");
			// Truncate to keep tool result bounded.
			const max = 20000;
			if (content.length <= max) return content;
			return content.slice(0, max) + `\n\n[truncated: ${content.length} → ${max} chars]`;
		} catch (err) {
			return `Read failed: ${(err as Error).message}`;
		}
	},
});
