// Wiki anchor resolution + injection rendering (v0.8 P1 §10.6 / §10.3.1)
//
// # 文件说明书
//
// ## 核心功能
// 把一个 session 的 wiki 锚点(自动 memory + 自动 project + 自由 wikiAnchors)
// 解析成 nodeId 列表(scope guard 用)+ 渲染成可注入的文本(system / context
// 两个通道)。两类锚点的渲染语义严格按 plan-P1 §12:
//
//   - project 锚点 → 子树前 2 层 title+summary(不带正文);depth 可配。
//   - memory  锚点 → 索引(MEMORY.md 式:每条 title + nodeId 链接,不展开内容)。
//
// 注入通道(plan-P1 §11):
//   - inject=system  → 走 SystemPromptAssembler 的 section(可缓存,子树变再刷新)
//   - inject=context → 走 PreLLMCall buildContextMessage(每轮重算,不入 history)
//   - inject=off     → 不注入但仍计入 scope 锚点集(可见但沉默)
//
// ## 输入
// - WikiStore
// - session 的 (agentId, contextBundle.projectId) — 派生自动锚点
// - AgentRecord.wikiAnchors — 自由锚点
//
// ## 输出
// - resolveAnchorNodeIds():string[] —— 多锚点并集(给 scope guard)
// - renderSystemAnchors():string —— system 锚点 section 文本(可缓存)
// - renderContextAnchors():string —— context 锚点文本(每轮重算)
//
// ## 定位
// runtime 层 helper,被 agent-loop(prompt-sections 装配) + context-message
// (PreLLMCall 注入)调用。本模块不读 DB-wiki 内容文件(ExpandNode 才读),
// 只渲染结构。
//
// ## 依赖
// - ../../server/wiki-node-store (WikiStore + 常量)
// - ../shared/types (AgentRecord / SessionContextBundle)
//

import { createHash } from "node:crypto";
import type { WikiStore } from "../server/wiki-node-store.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
	memoryAgentRootId,
} from "../server/wiki-node-store.js";
import type {
	AgentRecord,
	SessionContextBundle,
	WikiNode,
} from "../shared/types.js";

/** Default depth for project-anchor subtree expansion (plan-P1 §12). */
export const DEFAULT_PROJECT_ANCHOR_DEPTH = 1;

/**
 * Format a node body's byte size for compact display next to a node entry.
 * Labels make body presence EXPLICIT so the agent knows a node has a readable
 * document (vs being structure-only): 0 (no body file) ⇒ "(no doc)"; has body
 * ⇒ "(doc 1.8kb)" / "(doc 230b)". mb kept for very large bodies.
 */
export function formatBodySize(bytes: number): string {
	if (!bytes || bytes <= 0) return "(no doc)";
	if (bytes < 1024) return `(doc ${bytes}b)`;
	if (bytes < 1024 * 1024) return `(doc ${(bytes / 1024).toFixed(1)}kb)`;
	return `(doc ${(bytes / (1024 * 1024)).toFixed(1)}mb)`;
}

/**
 * Derive a short, deterministic, uniform handle for ANY node id (UUID leaves
 * AND synthetic roots like "wiki-root:global" / "wiki-root:<projectId>").
 * shortIdOf = first 8 hex of sha1(id) — stable across sessions (no per-session
 * state), ~32 bits so collision-free for realistic subtrees. The agent sees
 * and addresses nodes by this 8-char handle instead of the full UUID/"wiki-root:"
 * id, which were bloating every injected outline / tool result line.
 */
export function shortIdOf(nodeId: string): string {
	return createHash("sha1").update(nodeId).digest("hex").slice(0, 8);
}

/**
 * Display form of a node handle: "#a3f2b1c0". Used everywhere a nodeId is shown
 * to the agent (injected outlines, expand/search/create/update/delete results).
 * Synthetic roots are displayed the SAME way as leaves — no "wiki-root:" prefix
 * leaks to the agent. The tool layer resolves a short id back to the full nodeId
 * via resolveNodeIdArg (exact get first, then short-id scan in scope).
 */
export function formatNodeId(nodeId: string): string {
	return `#${shortIdOf(nodeId)}`;
}

/**
 * Strip U+FFFD replacement chars (mojibake from a non-UTF-8 source file read
 * with the wrong encoding) so the agent never sees garbled summary text. Runs
 * of replacement chars are removed; surrounding whitespace is collapsed. This
 * is a render-time safety net on top of the root-cause fix in
 * wiki-skeleton-service.readFileText + ensureSummary self-heal — it covers
 * stale rows that haven't been recomputed yet.
 */
export function sanitizeText(s: string | undefined): string {
	if (!s) return "";
	return s.replace(/�+/g, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * A resolved anchor entry — combines the auto-derived vs free-origin flag with
 * the anchor's injection channel and target node id. `kind` controls how the
 * anchor is rendered (project-subtree outline vs memory index).
 */
export interface ResolvedAnchor {
	nodeId: string;
	inject: "system" | "context" | "off";
	/** 'project' = project subtree anchor; 'memory' = memory index anchor. */
	kind: "project" | "memory";
	depth: number;
}

/**
 * v0.8 (P1 §10.3.1): resolve a session's full anchor set:
 *
 *   auto = [
 *     memory anchor (this agent's per-agent memory subtree root:
 *                    wiki-root:memory-agent:<agentId>, P2 §11.6),
 *     project anchor (wiki-root:<projectId>) if contextBundle.projectId set,
 *   ]
 *   free = AgentRecord.wikiAnchors (each entry classified project vs memory
 *          by inspecting the node's position in the tree)
 *
 * The union is what the scope guard treats as the caller's visible+writeable
 * surface (acceptance-P1: write scope = visible scope). Anchors that don't
 * exist as rows are kept (they may exist later; the scope guard just returns
 * an empty subtree for them).
 *
 * Special case: zero / global sessions (no projectId) get the GLOBAL ROOT as
 * an auto scope anchor (inject:"off") so their read scope == write scope ==
 * the whole tree. Free anchors can still extend or narrow specific subtrees.
 */
export function resolveAnchors(opts: {
	wiki: WikiStore;
	agentId: string;
	contextBundle?: SessionContextBundle;
	wikiAnchors?: AgentRecord["wikiAnchors"];
}): ResolvedAnchor[] {
	const { wiki, contextBundle, wikiAnchors } = opts;
	const out: ResolvedAnchor[] = [];

	// 1. Auto memory anchor — this session's agent's per-agent memory subtree
	//    root (P2 §11.6). Memory is global to the agent (cross-project): the
	//    same agent's memory spans every project it touches. Extractor A
	//    writes here; the anchor renders the subtree as a MEMORY.md-style
	//    index in the context channel.
	//
	//    (Pre-P2 used the 5 shared global type roots; that scheme is retired
	//    but old data under those roots is left in place — P9 cleanup.)
	if (opts.agentId) {
		out.push({
			nodeId: memoryAgentRootId(opts.agentId),
			inject: "context", // memory anchor default channel
			kind: "memory",
			// depth 1: memory leaves hang directly under the per-agent root, so
			// one level already surfaces the index. Keeps the injected memory
			// block lean (default expand = 1 layer).
			depth: 1,
		});
	}

	// 2. Auto project anchor — wiki-root:<projectId>. Project-role sessions
	//    always anchor into their own subtree.
	if (contextBundle?.projectId) {
		out.push({
			nodeId: projectSubtreeRootId(contextBundle.projectId),
			inject: "system", // project anchor default channel
			kind: "project",
			depth: DEFAULT_PROJECT_ANCHOR_DEPTH,
		});
	} else {
		// v0.8 (读写同界 / pure anchor model): GLOBAL ROOT 作为 scope 锚点只给
		// **zero**(平台管家,需跨项目巡视整棵 wiki 树,read=write=whole tree)。
		// 其他 agent 的 general session 默认**不**放开整棵全局树 —— 只有自己的
		// memory 根(上面已加)+ 显式 free wikiAnchors。需要碰某 project 的 wiki
		// 就走该 project 的 session(拿到 project 子树锚点)。inject:"off" → 算
		// scope 锚点但不进 prompt(整树注入没意义)。
		if (opts.agentId === "zero") {
			out.push({
				nodeId: WIKI_GLOBAL_ROOT_ID,
				inject: "off",
				kind: "project",
				depth: 0,
			});
		}
	}

	// 3. Free anchors (AgentRecord.wikiAnchors). Override kind/inject/depth as
	//    specified; classify kind by inspecting the node's position.
	if (wikiAnchors) {
		for (const entry of wikiAnchors) {
			const node = wiki.get(entry.nodeId);
			const kind = classifyAnchorKind(entry.nodeId, node);
			out.push({
				nodeId: entry.nodeId,
				inject: entry.inject,
				kind,
				depth: entry.depth ?? (kind === "project" ? DEFAULT_PROJECT_ANCHOR_DEPTH : 1),
			});
		}
	}

	return dedupeAnchors(out);
}

/** Flatten resolved anchors into the nodeId union used by the scope guard. */
export function anchorNodeIds(anchors: ResolvedAnchor[]): string[] {
	return [...new Set(anchors.map((a) => a.nodeId))];
}

function classifyAnchorKind(nodeId: string, node: WikiNode | undefined): "project" | "memory" {
	// v0.8 (P2 §11.6): per-agent memory roots (`wiki-root:memory-agent:<id>`)
	// + legacy global type roots (`wiki-root:memory:<type>`) → memory.
	if (nodeId.startsWith("wiki-root:memory-agent:")) return "memory";
	if (nodeId.startsWith("wiki-root:memory:")) return "memory";
	if (node && node.type === "memory") return "memory";
	if (node && node.path && node.path.startsWith("memory")) return "memory";
	// Everything else (project subtree roots, header/intent/structure nodes,
	// global root) → project-kind outline.
	return "project";
}

function dedupeAnchors(anchors: ResolvedAnchor[]): ResolvedAnchor[] {
	const byNode = new Map<string, ResolvedAnchor>();
	// First-write-wins for kind/depth (auto anchors come first); but inject
	// is overridden by any free entry that targets the same node (free wins).
	for (const a of anchors) {
		const existing = byNode.get(a.nodeId);
		if (!existing) {
			byNode.set(a.nodeId, { ...a });
		} else {
			// Free override wins on inject; keep the more permissive depth (max).
			byNode.set(a.nodeId, {
				...existing,
				inject: a.inject !== "context" || existing.inject === "context" ? a.inject : existing.inject,
				depth: Math.max(existing.depth, a.depth),
			});
		}
	}
	return [...byNode.values()];
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/**
 * Render the system-channel anchors as a single system-prompt section. Output
 * is empty when there are no system anchors. Stable across turns (caller
 * caches via SystemPromptAssembler; invalidate on subtree change).
 *
 * Layout:
 *   ## Wiki Project Anchors
 *   ### <project subtree root title>
 *   - <child level 1 title> — <summary>
 *     - <grandchild level 2 title> — <summary>
 *   ### <another project root>
 *   ...
 */
export function renderSystemAnchors(opts: {
	wiki: WikiStore;
	anchors: ResolvedAnchor[];
}): string {
	const { wiki, anchors } = opts;
	const sys = anchors.filter((a) => a.inject === "system");
	if (sys.length === 0) return "";

	const blocks: string[] = [];
	for (const anchor of sys) {
		const node = wiki.get(anchor.nodeId);
		if (!node) continue;
		const rendered = anchor.kind === "project"
			? renderProjectSubtreeOutline(wiki, anchor.nodeId, anchor.depth)
			: renderMemoryIndex(wiki, anchor.nodeId, anchor.depth);
		if (rendered) blocks.push(rendered);
	}
	if (blocks.length === 0) return "";
	return "## Wiki Anchors (system)\n"
		+ "用 Wiki 工具操作这些节点(不要用 Glob/Read 去文件系统探索):docRead 读正文、expand 遍历子树、docWrite/docEdit 写。每个节点带一个 8 字符短 id(#xxxxxxxx),用它(或 title path)寻址即可,无需完整 nodeId。\n\n"
		+ blocks.join("\n\n");
}

/**
 * Render context-channel anchors as a single text block for the PreLLMCall
 * buildContextMessage. Empty when no context anchors.
 *
 * Mirrors renderSystemAnchors but the caller (context-message.ts) wraps the
 * result in a `## Wiki Anchors (context)` subsection.
 */
export function renderContextAnchors(opts: {
	wiki: WikiStore;
	anchors: ResolvedAnchor[];
}): string {
	const { wiki, anchors } = opts;
	const ctx = anchors.filter((a) => a.inject === "context");
	if (ctx.length === 0) return "";
	const blocks: string[] = [];
	for (const anchor of ctx) {
		const node = wiki.get(anchor.nodeId);
		if (!node) continue;
		const rendered = anchor.kind === "project"
			? renderProjectSubtreeOutline(wiki, anchor.nodeId, anchor.depth)
			: renderMemoryIndex(wiki, anchor.nodeId, anchor.depth);
		if (rendered) blocks.push(rendered);
	}
	return blocks.join("\n\n");
}

/**
 * Project anchor render — first N levels of the subtree as title + summary
 * bullets, WITHOUT pulling body content. Plan-P1 §12: "子树前 2 层
 * title+summary(不带正文); depth 可配".
 */
function renderProjectSubtreeOutline(wiki: WikiStore, rootId: string, depth: number): string {
	const root = wiki.get(rootId);
	if (!root) return "";
	const lines: string[] = [];
	lines.push(`### ${root.title}  ${formatNodeId(root.id)} ${formatBodySize(wiki.getNodeDetailSize(root.id))}`);
	if (root.summary) lines.push(`> ${sanitizeText(root.summary)}`);
	renderSubtreeChildren(wiki, rootId, 1, depth, lines);
	return lines.join("\n");
}

function renderSubtreeChildren(
	wiki: WikiStore,
	parentId: string,
	level: number,
	maxDepth: number,
	lines: string[],
): void {
	if (level > maxDepth) return;
	const children = wiki.getChildren(parentId);
	for (const child of children) {
		const indent = "  ".repeat(level) + "- ";
		const summary = child.summary ? ` — ${sanitizeText(child.summary)}` : "";
		const size = formatBodySize(wiki.getNodeDetailSize(child.id));
		lines.push(`${indent}${child.title}${summary} ${size} ${formatNodeId(child.id)}`);
		renderSubtreeChildren(wiki, child.id, level + 1, maxDepth, lines);
	}
}

/**
 * Memory anchor render — MEMORY.md-style index: each memory leaf is one
 * bullet with its title + nodeId link, no content expansion. Plan-P1 §12:
 * "索引(MEMORY.md 式:每条 title + nodeId 链接,不展开内容)".
 */
function renderMemoryIndex(wiki: WikiStore, rootId: string, depth: number): string {
	const root = wiki.get(rootId);
	if (!root) return "";
	const lines: string[] = [];
	lines.push(`### ${root.title}`);
	const leaves = collectMemoryLeaves(wiki, rootId, depth);
	if (leaves.length === 0) {
		lines.push("(no memory leaves yet)");
		return lines.join("\n");
	}
	for (const leaf of leaves) {
		lines.push(`- ${leaf.title} ${formatBodySize(wiki.getNodeDetailSize(leaf.id))} ${formatNodeId(leaf.id)}`);
	}
	return lines.join("\n");
}

function collectMemoryLeaves(wiki: WikiStore, rootId: string, maxDepth: number): WikiNode[] {
	const out: WikiNode[] = [];
	const visit = (id: string, level: number) => {
		if (level > maxDepth) return;
		const children = wiki.getChildren(id);
		for (const child of children) {
			// Skip nested type-root-like containers; only collect actual leaves.
			if (child.id.startsWith("wiki-root:")) {
				visit(child.id, level + 1);
				continue;
			}
			out.push(child);
		}
	};
	visit(rootId, 1);
	return out;
}

/** Re-export for tests / consumers that need the global root id. */
export { WIKI_GLOBAL_ROOT_ID };
