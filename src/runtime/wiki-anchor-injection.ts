// Wiki anchor resolution + injection rendering (v0.8 P1 §10.6 / §10.3.1)
//
// # 文件说明书
//
// ## 核心功能
// 把一个 session 的 wiki 锚点(自动 memory + 自动 project + 自由 wikiAnchors)
// 解析成 nodeId 列表(scope guard 用)+ 渲染成可注入的文本(system / context
// 两个通道)。
//
// 注入格式(所有锚点统一,不区分 project/memory,固定一层):
//   ### <root title>  #<id> (doc <size>)
//   <root doc,截到 INJECT_ROOT_DOC_MAX,有则注入;空则省>
//     - <child title> — <summary> (doc <size>) #<id> ▾<N>   // N=该子节点的子节点数
//     - <child title> — <summary> (doc <size>) #<id> leaf   // 无下层
//
//   summary 是"节点是什么 + doc 摘要"(写入已截到 SUMMARY_MAX_BYTES);注入里
//   再过一遍 SUMMARY_MAX_BYTES 兜存量。根 doc 是唯一注入的正文(其余正文靠
//   docRead),让 agent 一眼拿到子树 overview + 一层结构 + 哪些该再 expand。
//
// 注入通道(默认根 memory/project/global 都进 system,享冻结快照):
//   - inject=system  → 走 SystemPromptAssembler 的 wiki-system-anchors section
//                       (cacheBreak:false;session 开始定格,mid-session wiki 写
//                       不触发重渲染 → prefix cache 稳定;压缩后刷新)
//   - inject=context → sub-7 anchor merger 后同样并入 cached wiki-system-anchors
//                       section 渲染(不再每轮重算);free 锚点保留此选项
//   - inject=off     → 不注入但仍计入 scope 锚点集(可见但沉默)
//
// 注:本模块**只对根节点**读一次正文 doc(10kb 上限);其余节点只渲染结构
// (title/summary/size/id)。这是为了让注入携带子树 overview 而做的有界例外。
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
// (PreLLMCall 注入)调用。
//
// ## 依赖
// - ../../server/wiki-node-store (WikiStore + 常量 SUMMARY_MAX_BYTES)
// - ../shared/file-utils (truncateUtf8Bytes)
// - ../shared/types (AgentRecord / SessionContextBundle)
//

import { createHash } from "node:crypto";
import type { WikiStore } from "../server/wiki-node-store.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
	memoryAgentRootId,
	SUMMARY_MAX_BYTES,
} from "../server/wiki-node-store.js";
import { truncateUtf8Bytes } from "../shared/file-utils.js";
import type {
	AgentRecord,
	SessionContextBundle,
	WikiNode,
} from "../shared/types.js";

/**
 * Max UTF-8 bytes of the ROOT node's doc injected inline. Root doc = subtree
 * overview, the one piece of body content worth injecting. 10kb keeps it under
 * the 16K externalize threshold. Deeper bodies stay behind docRead.
 */
const INJECT_ROOT_DOC_MAX = 10 * 1024;

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
 * the anchor's injection channel and target node id. All anchors render with
 * the SAME outline (root doc + one level of children); `kind` is retained only
 * for callers that distinguish project vs memory anchors for other reasons.
 */
export interface ResolvedAnchor {
	nodeId: string;
	inject: "system" | "context" | "off";
	/** 'project' = project subtree anchor; 'memory' = memory index anchor. */
	kind: "project" | "memory";
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
	//    writes here (ExtractorA, 待 sub-5 删) / the session itself (memory
	//    ephemeral turn, compression-archive-simplify sub-2+); the anchor
	//    renders the subtree as a MEMORY.md-style index in the cached system
	//    section (inject:"system" sub-1 — frozen snapshot, design §零).
	//
	//    (Pre-P2 used the 5 shared global type roots; that scheme is retired
	//    but old data under those roots is left in place — P9 cleanup.)
	if (opts.agentId) {
		out.push({
			nodeId: memoryAgentRootId(opts.agentId),
			inject: "system", // memory anchor — cached system section (frozen snapshot, compression-archive sub-1)
			kind: "memory",
		});
	}

	// 2. Auto project anchor — wiki-root:<projectId>. Project-role sessions
	//    always anchor into their own subtree.
	if (contextBundle?.projectId) {
		out.push({
			nodeId: projectSubtreeRootId(contextBundle.projectId),
			inject: "system", // project anchor default channel
			kind: "project",
		});
	} else {
		// v0.8 (读写同界 / pure anchor model): GLOBAL ROOT 作为 scope 锚点只给
		// **zero**(平台管家,需跨项目巡视整棵 wiki 树,read=write=whole tree)。
		// 其他 agent 的 general session 默认**不**放开整棵全局树 —— 只有自己的
		// memory 根(上面已加)+ 显式 free wikiAnchors。需要碰某 project 的 wiki
		// 就走该 project 的 session(拿到 project 子树锚点)。
		//
		// compression-archive-simplify sub-1: zero global-root inject 从 "off"
		// 改 "system" —— 渲染 doc + 一层 children summary(受 INJECT_ROOT_DOC_MAX
		// / SUMMARY_MAX_BYTES cap 有界),让 zero 一眼看到整棵 wiki 顶层结构。
		// 享冻结快照(同 memory/project 根)。
		if (opts.agentId === "zero") {
			out.push({
				nodeId: WIKI_GLOBAL_ROOT_ID,
				inject: "system", // zero global-root — cached system section (frozen snapshot, compression-archive sub-1)
				kind: "project",
			});
		}
	}

	// 3. Free anchors (AgentRecord.wikiAnchors). Override inject as specified;
	//    classify kind by inspecting the node's position.
	if (wikiAnchors) {
		for (const entry of wikiAnchors) {
			const node = wiki.get(entry.nodeId);
			const kind = classifyAnchorKind(entry.nodeId, node);
			out.push({
				nodeId: entry.nodeId,
				inject: entry.inject,
				kind,
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
	// v0.8 (steps-overhaul sub-6): per-TOPIC memory roots
	// (`wiki-root:memory-topic:<topicId>`) → memory (parallel to per-agent).
	// Recognized by id prefix so a topic root resolves to memory-kind EVEN
	// BEFORE its row is lazily created (Extractor A's callerCtx may inject the
	// topic root id as an anchor before ensureMemoryTopicRoot has run).
	if (nodeId.startsWith("wiki-root:memory-agent:")) return "memory";
	if (nodeId.startsWith("wiki-root:memory-topic:")) return "memory";
	if (nodeId.startsWith("wiki-root:memory:")) return "memory";
	if (node && node.type === "memory") return "memory";
	if (node && node.path && node.path.startsWith("memory")) return "memory";
	// Everything else (project subtree roots, header/intent/structure nodes,
	// global root) → project-kind outline.
	return "project";
}

function dedupeAnchors(anchors: ResolvedAnchor[]): ResolvedAnchor[] {
	const byNode = new Map<string, ResolvedAnchor>();
	// First-write-wins for kind; inject is overridden by any free entry that
	// targets the same node (free wins).
	for (const a of anchors) {
		const existing = byNode.get(a.nodeId);
		if (!existing) {
			byNode.set(a.nodeId, { ...a });
		} else {
			byNode.set(a.nodeId, {
				...existing,
				inject: a.inject !== "context" || existing.inject === "context" ? a.inject : existing.inject,
			});
		}
	}
	return [...byNode.values()];
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/**
 * Render ONE anchor as the unified outline:
 *   ### <root title>  #<id> (doc <size>)
 *   <root doc, ≤ INJECT_ROOT_DOC_MAX, with truncation marker; omitted if empty>
 *     - <child title> — <summary> (doc <size>) #<id> ▾<N>      // has N children
 *     - <child title> — <summary> (doc <size>) #<id> leaf      // no children
 *
 * - Root doc is the ONLY body content injected (subtree overview); read via
 *   wiki.readNodeDetail, capped to INJECT_ROOT_DOC_MAX. Other bodies stay
 *   behind docRead.
 * - Children are exactly ONE level (fixed; depth is no longer configurable).
 * - Each child summary is re-capped to SUMMARY_MAX_BYTES at render time so
 *   legacy oversized rows (pre-cap) don't bloat the injection.
 * - `▾<N>` / `leaf` tells the agent which children have further structure to
 *   expand (injection is one level, so this is the cue to call expand/docRead).
 */
function renderAnchorOutline(wiki: WikiStore, anchor: ResolvedAnchor): string {
	const root = wiki.get(anchor.nodeId);
	if (!root) return "";
	const lines: string[] = [];
	lines.push(`### ${root.title}  ${formatNodeId(root.id)} ${formatBodySize(wiki.getNodeDetailSize(root.id))}`);

	// Root doc (capped). readNodeDetail is optional on the type for test stubs.
	const doc = wiki.readNodeDetail?.(root.id);
	if (doc && doc.trim()) {
		lines.push(truncateUtf8Bytes(doc.trim(), INJECT_ROOT_DOC_MAX, " …(doc truncated, use docRead)"));
	}

	const children = wiki.getChildren(root.id);
	for (const child of children) {
		const summary = child.summary
			? ` — ${sanitizeText(truncateUtf8Bytes(child.summary, SUMMARY_MAX_BYTES))}`
			: "";
		const size = formatBodySize(wiki.getNodeDetailSize(child.id));
		const grandChildCount = wiki.getChildren(child.id).length;
		const marker = grandChildCount > 0 ? ` ▾${grandChildCount}` : " leaf";
		lines.push(`  - ${child.title}${summary} ${size} ${formatNodeId(child.id)}${marker}`);
	}
	return lines.join("\n");
}

/**
 * Render the system-channel anchors as a single system-prompt section. Output
 * is empty when there are no system anchors. Stable across turns (caller
 * caches via SystemPromptAssembler; invalidate on subtree change).
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
		const rendered = renderAnchorOutline(wiki, anchor);
		if (rendered) blocks.push(rendered);
	}
	if (blocks.length === 0) return "";
	return "## Wiki Anchors (system)\n"
		+ "用 Wiki 工具操作这些节点(不要用 Glob/Read 去文件系统探索):docRead 读正文、expand 遍历子树、docWrite/docEdit 写。每个节点带一个 8 字符短 id(#xxxxxxxx),用它(或 title path)寻址即可,无需完整 nodeId。▾N 表示该节点还有 N 个子节点(用 expand 深入),leaf 表示叶子。\n\n"
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
		const rendered = renderAnchorOutline(wiki, anchor);
		if (rendered) blocks.push(rendered);
	}
	return blocks.join("\n\n");
}

/** Re-export for tests / consumers that need the global root id. */
export { WIKI_GLOBAL_ROOT_ID };
