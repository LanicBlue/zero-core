// 单元测试:wiki 按 topic 分根 (steps-overhaul sub-6)
//
// # 文件说明书
//
// ## 核心功能
// sub-6 为 Extractor A(sub-7 多步 agent)提供 wiki 按 topic 分根的 store + 工具能力:
//   1. memoryTopicRootId / ensureMemoryTopicRoot 建 topic 根,挂 global root 下
//   2. createMemoryNodeForTopic 按 (topicId, subject) upsert 稳定绑定
//   3. topic 节点 deriveTypeFromPosition 正确归类(根=project 索引,叶子=memory)
//   4. topic 节点能被 searchMemoryNodes 找到(叶子能,根不能)
//   5. flags/detail 可写(冲突标注 + 合并正文)
//   6. topic 根不撞 knowledge/projects/memory 容器名
//   7. Wiki 工具 createMemory/updateMemory 走 anchor scope(global-anchor callerCtx)
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 新建 WikiStore
//
// ## 输出
// Vitest 用例
//
// ## 维护规则
// - topic 子树路径或 id 前缀(memory-topic:)变更需同步本测试
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	memoryTopicRootId,
	MEMORY_TOPIC_PATH_PREFIX,
	getWikiStoreGlobal,
	setWikiStoreGlobal,
} from "../../src/server/wiki-node-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { wikiTool, buildGlobalAnchorWikiCallerCtx } from "../../src/tools/wiki-tool.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let prevGlobal: ReturnType<typeof getWikiStoreGlobal>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-wikitopic-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	// Wiki tool reads the process-wide singleton (resolveWikiStore →
	// getWikiStoreGlobal). Install our per-test instance so execute can reach
	// it, and restore the prior value afterwards (other tests rely on it).
	prevGlobal = getWikiStoreGlobal();
	setWikiStoreGlobal(wiki);
});

afterEach(() => {
	setWikiStoreGlobal(prevGlobal);
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// Run a Wiki tool action through execute and return the rendered text.
//
// The tool wrapper (tool-factory) reconstructs callerCtx from
// `experimental_context`: if it carries a `buildCallerCtx` factory, that's
// used as-is; otherwise the legacy ToolExecutionContext is bridged via
// callerCtxFromLegacyCtx (which reads wikiAnchorNodeIds off ctx). sub-7's
// Extractor A will plug `buildGlobalAnchorWikiCallerCtx` in as buildCallerCtx;
// here we exercise BOTH paths:
//   - `runWiki`: buildCallerCtx path (the real sub-7 wiring);
//   - `runWikiLegacy`: legacy-ctx path (mirrors how existing tests call the
//     tool with a bare ctx carrying wikiAnchorNodeIds).
async function runWiki(input: any): Promise<string> {
	const host = {
		ctx: { workingDir: "", agentId: "", emit: () => {} },
		buildCallerCtx: () => buildGlobalAnchorWikiCallerCtx(),
	};
	try {
		const raw: any = await (wikiTool as any).execute(input, { experimental_context: host });
		// raw is either a ToolResult (data.text) or a pre-formatted string.
		if (raw && typeof raw === "object" && typeof raw.ok === "boolean") {
			return raw.data?.text ?? "";
		}
		return typeof raw === "string" ? raw : String(raw ?? "");
	} catch (err) {
		// tool-factory wraps ok:false results into a thrown Error carrying the
		// LLM-facing text as its message. Surface that text so error-path
		// assertions match the same strings success-path ones do.
		return (err as Error).message;
	}
}

async function runWikiLegacy(input: any, legacyCtx: any): Promise<string> {
	try {
		const raw: any = await (wikiTool as any).execute(input, { experimental_context: legacyCtx });
		if (raw && typeof raw === "object" && typeof raw.ok === "boolean") {
			return raw.data?.text ?? "";
		}
		return typeof raw === "string" ? raw : String(raw ?? "");
	} catch (err) {
		return (err as Error).message;
	}
}

describe("wiki topic memory (steps-overhaul sub-6)", () => {
	describe("ensureMemoryTopicRoot", () => {
		test("creates a real row under WIKI_GLOBAL_ROOT_ID with id memoryTopicRootId(topicId)", () => {
			const root = wiki.ensureMemoryTopicRoot("auth-system");
			expect(root.id).toBe(memoryTopicRootId("auth-system"));
			expect(root.parentId).toBe(WIKI_GLOBAL_ROOT_ID);
			// topic root is an INDEX/anchor container (parallel to per-agent root):
			// deriveTypeFromPosition classifies `wiki-root:memory-topic:` as
			// type=project (matches the generic `wiki-root:` rule, NOT the
			// `wiki-root:memory:` rule — colon position differs). So it is NOT
			// picked up by listMemoryNodes / searchMemoryNodes (type !== memory).
			expect(root.type).toBe("project");
			expect(root.nodeType).toBe("section");
			expect(root.title).toBe("Memory Topic: auth-system");
		});

		test("is idempotent — second call returns the same row", () => {
			const first = wiki.ensureMemoryTopicRoot("auth-system");
			const second = wiki.ensureMemoryTopicRoot("auth-system");
			expect(second.id).toBe(first.id);
		});

		test("syncs title when topicTitle changes (same id)", () => {
			const first = wiki.ensureMemoryTopicRoot("auth-system");
			const renamed = wiki.ensureMemoryTopicRoot("auth-system", "Auth Subsystem");
			expect(renamed.id).toBe(first.id);
			expect(renamed.title).toBe("Auth Subsystem");
		});

		test("different topics get different roots", () => {
			const a = wiki.ensureMemoryTopicRoot("auth");
			const b = wiki.ensureMemoryTopicRoot("billing");
			expect(a.id).not.toBe(b.id);
		});

		test("topic root path does NOT collide with knowledge/projects/memory containers", () => {
			const root = wiki.ensureMemoryTopicRoot("auth");
			// The prefixed path `memory-topic:<id>` is structurally distinct
			// from the bare §10.5 container names (knowledge / workflow /
			// projects / memory). It also cannot match the legacy type-root
			// path `memory-root:<type>` or the per-agent `memory-agent:<id>`.
			expect(root.path).toBe(`${MEMORY_TOPIC_PATH_PREFIX}:auth`);
			expect(root.path).not.toBe("knowledge");
			expect(root.path).not.toBe("workflow");
			expect(root.path).not.toBe("projects");
			expect(root.path).not.toBe("memory");
			// No row at (parent=global-root, path=<container>) is shadowed.
			const existing = wiki.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, "projects");
			expect(existing?.id).toBe("wiki-root:projects"); // container intact
		});
	});

	describe("createMemoryNodeForTopic upsert", () => {
		test("writes a memory leaf under the topic's subtree", () => {
			const node = wiki.createMemoryNodeForTopic({
				topicId: "auth-system",
				subject: "JWT rotation policy",
				title: "JWT rotation policy",
				summary: "Rotate signing keys every 90 days.",
			});
			expect(node.parentId).toBe(memoryTopicRootId("auth-system"));
			expect(node.type).toBe("memory");
			expect(node.title).toBe("JWT rotation policy");
			// Path encodes topic + slugged subject for stable upsert.
			expect(node.path).toBe(`${MEMORY_TOPIC_PATH_PREFIX}:auth-system:jwt-rotation-policy`);
		});

		test("upsert by (topicId, subject) is stable — second call updates the same node", () => {
			const first = wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "Subject-X",
				title: "Original Title",
				summary: "Original summary.",
			});
			const second = wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "Subject-X",
				title: "Updated Title",
				summary: "Updated summary.",
			});
			expect(second.id).toBe(first.id);
			expect(second.title).toBe("Updated Title");
			expect(second.summary).toBe("Updated summary.");
		});

		test("different subjects under the same topic get distinct nodes", () => {
			const a = wiki.createMemoryNodeForTopic({
				topicId: "auth", subject: "A", title: "A", summary: "a",
			});
			const b = wiki.createMemoryNodeForTopic({
				topicId: "auth", subject: "B", title: "B", summary: "b",
			});
			expect(a.id).not.toBe(b.id);
		});

		test("different topics with the same subject get distinct nodes", () => {
			const a = wiki.createMemoryNodeForTopic({
				topicId: "auth", subject: "Shared", title: "S", summary: "s",
			});
			const b = wiki.createMemoryNodeForTopic({
				topicId: "billing", subject: "Shared", title: "S", summary: "s",
			});
			expect(a.id).not.toBe(b.id);
			expect(a.parentId).not.toBe(b.parentId);
		});

		test("flags + detail (body) round-trip — conflict markers + merged markdown body", () => {
			const node = wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "session-timeout",
				title: "Session timeout",
				summary: "15min idle → logout.",
				detail: "## Decision\n\n15min idle timeout.\n\n## 历史\n\n- 2026-07: set to 15min (was 30min).",
				flags: ["conflict:source-disagrees"],
			});
			// flags persisted on the row.
			const reloaded = wiki.get(node.id)!;
			expect(reloaded.flags).toContain("conflict:source-disagrees");
			// detail (body) persisted on disk via docPointer.
			const body = wiki.readNodeDetail(node.id);
			expect(body).toContain("## Decision");
			expect(body).toContain("## 历史");
			expect(body).toContain("set to 15min");
		});

		test("update path leaves omitted fields alone (patch semantics)", () => {
			const node = wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "partial",
				title: "Original Title",
				summary: "Original summary.",
				detail: "Original body.",
				flags: ["orig-flag"],
			});
			// Update with ONLY title — summary/detail/flags should be untouched.
			const updated = wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "partial",
				title: "New Title",
				// summary, detail, flags deliberately omitted
			});
			expect(updated.title).toBe("New Title");
			expect(updated.summary).toBe("Original summary.");
			expect(updated.flags).toEqual(["orig-flag"]);
			const body = wiki.readNodeDetail(updated.id);
			expect(body).toBe("Original body.");
		});
	});

	describe("deriveTypeFromPosition classifies topic nodes correctly", () => {
		test("topic root → type=project (index container, NOT memory)", () => {
			const root = wiki.ensureMemoryTopicRoot("auth");
			expect(root.type).toBe("project");
		});

		test("topic leaf → type=memory", () => {
			const leaf = wiki.createMemoryNodeForTopic({
				topicId: "auth", subject: "fact", title: "Fact", summary: "s",
			});
			expect(leaf.type).toBe("memory");
		});
	});

	describe("searchMemoryNodes finds topic leaves but not the topic root", () => {
		test("topic leaf is searchable by title term", () => {
			wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "MultiTenantAuthModel",
				title: "MultiTenantAuthModel",
				summary: "How multi-tenant auth works.",
			});
			const hits = wiki.searchMemoryNodes("MultiTenantAuthModel");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits.some((h) => h.title === "MultiTenantAuthModel")).toBe(true);
		});

		test("topic leaf is searchable by a term only in the body", () => {
			wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "body-only-term",
				title: "Some Title",
				summary: "Generic summary.",
				detail: "UniqueBodyTokenXYZ inside the body only.",
			});
			const hits = wiki.searchMemoryNodes("UniqueBodyTokenXYZ");
			expect(hits.length).toBeGreaterThan(0);
		});

		test("topic ROOT is NOT in search results (it is an empty index container)", () => {
			wiki.ensureMemoryTopicRoot("searchable-topic-name", "Searchable Topic Name");
			const hits = wiki.searchMemoryNodes("Searchable Topic Name");
			expect(hits.every((h) => h.id !== memoryTopicRootId("searchable-topic-name"))).toBe(true);
		});

		test("topic leaves and per-agent leaves coexist in search results", () => {
			wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "decision",
				subject: "AgentDecisionFoo",
				title: "AgentDecisionFoo",
				summary: "Agent-side memory.",
			});
			wiki.createMemoryNodeForTopic({
				topicId: "auth",
				subject: "TopicMemoryFoo",
				title: "TopicMemoryFoo",
				summary: "Topic-side memory.",
			});
			// Both findable.
			expect(wiki.searchMemoryNodes("AgentDecisionFoo").length).toBeGreaterThan(0);
			expect(wiki.searchMemoryNodes("TopicMemoryFoo").length).toBeGreaterThan(0);
		});
	});

	describe("Wiki tool createMemory / updateMemory (global-anchor callerCtx)", () => {
		test("buildGlobalAnchorWikiCallerCtx returns a session-less ctx anchored to global root", () => {
			const c = buildGlobalAnchorWikiCallerCtx();
			expect(c.caller).toBe("internal");
			expect(c.sessionId).toBeUndefined();
			expect(c.agentId).toBeUndefined();
			expect(c.wikiAnchorNodeIds).toEqual([WIKI_GLOBAL_ROOT_ID]);
		});

		test("createMemory upserts a memory leaf under a topic root via the tool", async () => {
			// Ensure the topic root first so the tool has a parent to write under.
			const topicRoot = wiki.ensureMemoryTopicRoot("tool-auth", "Tool Auth Topic");
			const created = await runWiki({
				action: "createMemory",
				parentId: topicRoot.id,
				subject: "token-refresh",
				title: "Token refresh flow",
				summary: "Silent refresh via refresh tokens.",
				content: "## Flow\n\nClient uses refresh token to get new access token.",
				flags: ["derived"],
			});
			expect(created).toMatch(/Memory node (created|updated)/i);
			// Findable via the tool's search.
			const searched = await runWiki({ action: "search", query: "Token refresh" });
			expect(searched).toMatch(/Token refresh/);
		});

		test("createMemory is idempotent — same subject updates the same node", async () => {
			const topicRoot = wiki.ensureMemoryTopicRoot("tool-auth2");
			await runWiki({
				action: "createMemory",
				parentId: topicRoot.id,
				subject: "stable-subject",
				title: "V1",
				summary: "v1 summary",
			});
			const r2 = await runWiki({
				action: "createMemory",
				parentId: topicRoot.id,
				subject: "stable-subject",
				title: "V2",
				summary: "v2 summary",
			});
			expect(r2).toMatch(/updated/i);
			// The tool's createMemory synthesizes a `memory:<slug>` path (the
			// stable upsert key is (parentId, path) — same topic parent + same
			// subject → same node). Only one node exists under that parent+path.
			const path = `memory:stable-subject`;
			const nodes = wiki.listMemoryNodes().filter((n) => n.parentId === topicRoot.id && n.path === path);
			expect(nodes.length).toBe(1);
			expect(nodes[0].title).toBe("V2");
		});

		test("createMemory rejects a non-memory parent (structure node)", async () => {
			// Projects container is a structure/project container, not a memory container.
			const r = await runWiki({
				action: "createMemory",
				parentId: "wiki-root:projects",
				subject: "x",
				title: "X",
			});
			expect(r).toMatch(/Error:/);
			expect(r).toMatch(/memory container/i);
		});

		test("updateMemory patches a memory leaf's metadata + body", async () => {
			const topicRoot = wiki.ensureMemoryTopicRoot("tool-auth3");
			await runWiki({
				action: "createMemory",
				parentId: topicRoot.id,
				subject: "patch-target",
				title: "Original",
				summary: "Original summary.",
				content: "Original body.",
			});
			// Re-resolve the short id via search (the tool returns short ids).
			const searched = await runWiki({ action: "search", query: "Original" });
			const shortId = (searched.split("\n")[0].split("|")[0].trim()).replace(/^#/, "");
			const r = await runWiki({
				action: "updateMemory",
				nodeId: shortId,
				title: "Patched Title",
				content: "Patched body.",
			});
			expect(r).toMatch(/updated/i);
			// Verify the patch landed.
			const node = wiki.listMemoryNodes().find((n) => n.title === "Patched Title");
			expect(node).toBeDefined();
			expect(wiki.readNodeDetail(node!.id)).toBe("Patched body.");
		});

		test("updateMemory rejects a non-memory node", async () => {
			// projects container is type=project, not memory.
			const r = await runWiki({
				action: "updateMemory",
				nodeId: "wiki-root:projects",
				title: "X",
			});
			expect(r).toMatch(/Error:/);
			expect(r).toMatch(/memory leaves only/i);
		});

		test("legacy-ctx path (callerCtxFromLegacyCtx) also resolves global anchors", async () => {
			// Existing tests / server tool-execute pass a bare ToolExecutionContext
			// carrying wikiAnchorNodeIds; the wrapper bridges it. A global-anchor
			// ctx built this way must also reach the whole tree.
			const topicRoot = wiki.ensureMemoryTopicRoot("legacy-ctx-topic");
			const legacyCtx = {
				workingDir: "",
				agentId: "",
				emit: () => {},
				wikiAnchorNodeIds: [WIKI_GLOBAL_ROOT_ID],
			};
			const r = await runWikiLegacy({
				action: "createMemory",
				parentId: topicRoot.id,
				subject: "legacy",
				title: "Legacy Ctx Memory",
			}, legacyCtx);
			expect(r).toMatch(/Memory node (created|updated)/i);
		});
	});

	describe("topic root doesn't pollute listProjects", () => {
		test("topic root (no projectId) is not listed as a project", () => {
			wiki.ensureMemoryTopicRoot("auth");
			const projects = wiki.listProjects();
			expect(projects).not.toContain("auth");
		});
	});
});
