// steps-overhaul sub-7 acceptance test: Extractor A 多步 agent + topic wiki 合并
//
// # File 说明书
// ## 核心功能
// 独立验证 acceptance-7.md 的核心条目,通过测试直调 ExtractorAService:
//   - Extractor A 是多步 agent(独立 loop,不在工作 session,call 不存储)
//   - 读 memory 子树 + 新 step → 判定新建 topic 节点 vs 补充已有
//   - 合并:去重(同主题不重复)+ 去伪(纠正过时/错误)+ 冲突无法判定 flags 标注
//   - detail 留 ## 历史 段(无 version/history 列,绕过)
//   - 一次压缩可产多个 summary(跨主题)→ 多次 merge 调用
//   - summary 同时写 messages(sub-4 已测)+ 喂 wiki 节点(本测)
//   - 结果核对输出格式(不符重试/兜底)
//   - extraction-hooks 阈值通路 + closeFlushSession 退役(m5-extractors 测)
//
// ## 多步 agent loop 测试策略
// 注入一个 tool-calling stub model,按 step 序列返响应:
//   step 1 → tool-call(createMemory / updateMemory / readTopicMemory ...)
//   step 2 → 最终 text(可选)
// 这样断言 wiki 节点的合并结果(去重/纠正/标注)。
//
// ## callerCtx 注入
// wikiTool.execute 用 buildGlobalAnchorWikiCallerCtx(session-less,整树读写)。
// 验证 createMemory/updateMemory 经工具路径(path 前缀 memory:<slug>,非 store
// 直写的 memory-topic:<topicId>:<slug>)—— 统一 path 前缀不变量。
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
import { ExtractorAService, type MergeSummaryInput } from "../../src/server/extractor-a-service.js";
import type { MessageSummary } from "../../src/server/session-db.js";
import { compressSession } from "../../src/server/compression-core.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let prevGlobal: ReturnType<typeof getWikiStoreGlobal>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub7-extA-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	prevGlobal = getWikiStoreGlobal();
	setWikiStoreGlobal(wiki);
});

afterEach(() => {
	setWikiStoreGlobal(prevGlobal);
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Tool-calling stub model (AI SDK v3 protocol). Returns a SEQUENCE of step
 * responses. Each entry is either:
 *   { kind: "tool-call", toolName, args } → emits a tool-call content part
 *     with finishReason "tool-calls" (the loop continues, executes the tool,
 *     feeds the result back, then calls the model again);
 *   { kind: "text", text } → emits a text content part with finishReason
 *     "stop" (loop ends).
 *
 * v3 protocol NOTE: LanguageModelV3ToolCall.input is a STRINGIFIED JSON
 * string (not an object). We JSON.stringify the args so the SDK can match
 * them against the tool's zod schema. The v3 model also carries
 * `supportedUrls` (required field, empty for stubs).
 *
 * The model pops responses off the queue by step; if exhausted, it ends with
 * an empty stop. doStream is unused (generateText is non-streaming here).
 */
function toolCallingModel(steps: Array<
	| { kind: "tool-call"; toolName: string; args: Record<string, unknown> }
	| { kind: "text"; text: string }
>): any {
	const queue = [...steps];
	const doGenerate = async (opts: any) => {
		const step = queue.shift() ?? { kind: "text", text: "" };
		void opts;
		if (step.kind === "tool-call") {
			const id = `call-${Math.random().toString(36).slice(2, 10)}`;
			return {
				content: [{
					type: "tool-call",
					toolCallId: id,
					toolName: step.toolName,
					input: JSON.stringify(step.args),
				}],
				finishReason: "tool-calls",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				warnings: [],
			};
		}
		return {
			content: [{ type: "text", text: step.text }],
			finishReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			warnings: [],
		};
	};
	return {
		specificationVersion: "v3" as const,
		provider: "stub",
		modelId: "stub",
		supportedUrls: {},
		doGenerate,
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
					controller.close();
				},
			});
			return { stream };
		},
	};
}

/** A minimal 5-section summary for feeding mergeSummaryIntoWiki. */
function makeSummary(opts: {
	purpose?: string;
	plan?: string;
	status?: string;
	artifacts?: string;
	lessons?: string;
	from?: number;
	to?: number;
}): MessageSummary {
	return {
		title: "Compression of test steps",
		sections: {
			purpose: opts.purpose ?? "build auth",
			plan: opts.plan ?? "step 1, 2, 3",
			status: opts.status ?? "did steps. 下一步: run tests",
			artifacts: opts.artifacts ?? "src/auth.ts",
			lessons: opts.lessons ?? "watch out for token expiry",
		},
		stepRange: { from: opts.from ?? 0, to: opts.to ?? 5 },
		createdAt: new Date().toISOString(),
	};
}

function buildService(steps: Array<
	| { kind: "tool-call"; toolName: string; args: Record<string, unknown> }
	| { kind: "text"; text: string }
>): ExtractorAService {
	return new ExtractorAService({
		providers: [], providerName: "stub", modelId: "stub",
		wiki, testModel: toolCallingModel(steps),
	});
}

function buildMergeInput(opts: {
	topicId?: string;
	summary?: Partial<MessageSummary["sections"]>;
}): MergeSummaryInput {
	return {
		summary: makeSummary(opts.summary ?? {}),
		topicId: opts.topicId ?? "auth-system",
		topicTitle: "Auth System",
		agentId: "dev-1",
		sessionId: "sess-test",
	};
}

// ─── 1. 多步 agent:读 → 判定 → 写(新建 topic 节点)──────────────────

describe("sub-7 Extractor A multi-step agent — new topic node creation", () => {
	test("agent reads topic memory then creates a new memory leaf under the topic", async () => {
		const svc = buildService([
			// step 1: read the topic's existing memory (empty here).
			{ kind: "tool-call", toolName: "readTopicMemory", args: { topicId: "auth-system" } },
			// step 2: create a new memory leaf.
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "auth-system",
				subject: "JWT rotation policy",
				title: "JWT rotation policy",
				summary: "Rotate signing keys every 90 days.",
				content: "## Decision\n\nRotate every 90 days.\n\n## 历史\n\n- 2026-07: set to 90 days (from merge).",
			} },
			// step 3: final text summary.
			{ kind: "text", text: "Created 1 node under topic auth-system." },
		]);

		const result = await svc.mergeSummaryIntoWiki(buildMergeInput({}));
		expect(result.skipped).toBe(false);
		expect(result.mergeCount).toBe(1);
		expect(result.createdCount).toBe(1);

		// The leaf exists under the topic root.
		const root = wiki.get(memoryTopicRootId("auth-system"))!;
		expect(root).toBeDefined();
		const leaves = wiki.getChildren(root.id);
		expect(leaves.length).toBe(1);
		expect(leaves[0].title).toBe("JWT rotation policy");
		// Path prefix = "memory:" (tool path, NOT store-direct "memory-topic:...")
		// — unified path prefix invariant (sub-7: go through the tool).
		expect(leaves[0].path).toMatch(/^memory:/);
	});

	test("agent makes no memory writes → returns skipped with mergeCount=0", async () => {
		const svc = buildService([
			{ kind: "tool-call", toolName: "readTopicMemory", args: { topicId: "auth-system" } },
			{ kind: "text", text: "nothing memory-worthy here" },
		]);
		const result = await svc.mergeSummaryIntoWiki(buildMergeInput({}));
		expect(result.skipped).toBe(true);
		expect(result.mergeCount).toBe(0);
		expect(result.skipReason).toMatch(/no memory writes/);
	});
});

// ─── 2. 合并:去重(同主题同 subject → UPDATE, 不新建)──────────────

describe("sub-7 merge — dedupe (same subject → update, not duplicate)", () => {
	test("second merge with same subject updates the existing node (no duplicate)", async () => {
		// First merge: creates the node.
		const svc1 = buildService([
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "auth", subject: "session-timeout", title: "Session timeout",
				summary: "30min idle → logout.",
				content: "## Decision\n\n30min timeout.",
			} },
			{ kind: "text", text: "created" },
		]);
		await svc1.mergeSummaryIntoWiki(buildMergeInput({ topicId: "auth" }));
		const root = wiki.get(memoryTopicRootId("auth"))!;
		expect(wiki.getChildren(root.id).length).toBe(1);

		// Second merge: same subject → update (no new node).
		const svc2 = buildService([
			{ kind: "tool-call", toolName: "readTopicMemory", args: { topicId: "auth" } },
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "auth", subject: "session-timeout", title: "Session timeout",
				summary: "15min idle → logout.",
				content: "## Decision\n\n15min timeout.\n\n## 历史\n\n- 2026-07: 30min → 15min.",
			} },
			{ kind: "text", text: "updated" },
		]);
		const result2 = await svc2.mergeSummaryIntoWiki(buildMergeInput({ topicId: "auth" }));
		expect(result2.mergeCount).toBe(1);
		expect(result2.createdCount).toBe(0); // no new node
		expect(result2.updatedCount).toBe(1); // updated

		// Still only one node under the topic.
		expect(wiki.getChildren(root.id).length).toBe(1);
		const leaf = wiki.getChildren(root.id)[0];
		expect(leaf.summary).toContain("15min");
		// Body updated via the tool's content arg.
		const body = wiki.readNodeDetail(leaf.id) ?? "";
		expect(body).toContain("15min");
		expect(body).toContain("## 历史");
	});
});

// ─── 3. 合并:去伪(纠正过时/错误)──────────────────────────────

describe("sub-7 merge — correct stale/wrong (去伪)", () => {
	test("updateMemory replaces stale value, keeps old in ## 历史", async () => {
		// Seed an existing stale node directly.
		wiki.createMemoryNodeForTopic({
			topicId: "auth",
			subject: "session-timeout",
			title: "Session timeout",
			summary: "30min idle → logout.",
			detail: "## Decision\n\n30min timeout.",
		});
		const existing = wiki.getChildren(wiki.get(memoryTopicRootId("auth"))!.id)[0];

		// Agent reads, sees the stale 30min, corrects to 15min via updateMemory.
		const svc = buildService([
			{ kind: "tool-call", toolName: "readTopicMemory", args: { topicId: "auth" } },
			{ kind: "tool-call", toolName: "updateMemory", args: {
				nodeId: existing.id,
				summary: "15min idle → logout.",
				content: "## Decision\n\n15min timeout.\n\n## 历史\n\n- 2026-07: 30min → 15min (corrected, stale).",
				flags: ["corrected:stale"],
			} },
			{ kind: "text", text: "corrected stale timeout" },
		]);
		const result = await svc.mergeSummaryIntoWiki(buildMergeInput({ topicId: "auth" }));
		expect(result.mergeCount).toBe(1);
		expect(result.updatedCount).toBe(1);

		const updated = wiki.get(existing.id)!;
		expect(updated.summary).toContain("15min");
		expect(updated.flags).toContain("corrected:stale");
		const body = wiki.readNodeDetail(updated.id) ?? "";
		expect(body).toContain("15min");
		// Old value preserved in history (provenance trail).
		expect(body).toContain("30min");
	});
});

// ─── 4. 合并:冲突无法判定 → flags 标注 ──────────────────────────

describe("sub-7 merge — flag unresolvable conflicts (冲突标注)", () => {
	test("two disagreeing sources → flags: [conflict:needs-review], both kept in body", async () => {
		// Existing fact: source A says 15min.
		wiki.createMemoryNodeForTopic({
			topicId: "auth",
			subject: "session-timeout",
			title: "Session timeout",
			summary: "15min idle → logout (source A).",
			detail: "## Decision\n\n15min per source A.",
		});
		const existing = wiki.getChildren(wiki.get(memoryTopicRootId("auth"))!.id)[0];

		// Agent reads, sees 15min, new summary says 30min, can't tell which is
		// right → keeps both, flags conflict.
		const svc = buildService([
			{ kind: "tool-call", toolName: "readTopicMemory", args: { topicId: "auth" } },
			{ kind: "tool-call", toolName: "updateMemory", args: {
				nodeId: existing.id,
				summary: "DISPUTED — source A: 15min, source B: 30min.",
				content: "## Decision\n\n- Source A: 15min idle timeout.\n- Source B: 30min idle timeout.\n\n## 历史\n\n- 2026-07: conflict — both kept pending review.",
				flags: ["conflict:needs-review"],
			} },
			{ kind: "text", text: "flagged conflict" },
		]);
		const result = await svc.mergeSummaryIntoWiki(buildMergeInput({
			topicId: "auth",
			summary: { status: "found 30min timeout in new docs. 下一步: reconcile" },
		}));
		expect(result.mergeCount).toBe(1);
		const updated = wiki.get(existing.id)!;
		expect(updated.flags).toContain("conflict:needs-review");
		const body = wiki.readNodeDetail(updated.id) ?? "";
		// Both values preserved.
		expect(body).toContain("15min");
		expect(body).toContain("30min");
	});
});

// ─── 5. 跨主题产多 summary(每次压缩喂多次 merge)─────────────────

describe("sub-7 multi-topic — one compression feeds multiple merges", () => {
	test("two summaries (different topics) → two independent topic subtrees", async () => {
		// Merge 1: auth topic.
		const svc1 = buildService([
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "auth", subject: "jwt", title: "JWT",
				summary: "JWT rotation.", content: "## Decision\n\nRotate JWT.",
			} },
			{ kind: "text", text: "auth merge done" },
		]);
		await svc1.mergeSummaryIntoWiki(buildMergeInput({ topicId: "auth", topicTitle: "Auth" }));

		// Merge 2: billing topic (different topic subtree).
		const svc2 = buildService([
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "billing", subject: "invoice-cadence", title: "Invoice cadence",
				summary: "Monthly invoicing.", content: "## Decision\n\nMonthly.",
			} },
			{ kind: "text", text: "billing merge done" },
		]);
		await svc2.mergeSummaryIntoWiki(buildMergeInput({ topicId: "billing", topicTitle: "Billing" }));

		// Two independent topic roots.
		const authRoot = wiki.get(memoryTopicRootId("auth"));
		const billingRoot = wiki.get(memoryTopicRootId("billing"));
		expect(authRoot).toBeDefined();
		expect(billingRoot).toBeDefined();
		expect(authRoot!.id).not.toBe(billingRoot!.id);
		// Each has one leaf.
		expect(wiki.getChildren(authRoot!.id).length).toBe(1);
		expect(wiki.getChildren(billingRoot!.id).length).toBe(1);
		expect(wiki.getChildren(authRoot!.id)[0].title).toBe("JWT");
		expect(wiki.getChildren(billingRoot!.id)[0].title).toBe("Invoice cadence");
	});
});

// ─── 6. callerCtx 注入:走 wikiTool → path 前缀 memory:(非 memory-topic:)─

describe("sub-7 callerCtx — writes go through wikiTool (unified path prefix)", () => {
	test("createMemory tool path produces path prefix 'memory:', NOT 'memory-topic:'", async () => {
		const svc = buildService([
			{ kind: "tool-call", toolName: "createMemory", args: {
				topicId: "path-prefix-test", subject: "fact-x", title: "Fact X",
				summary: "x", content: "x",
			} },
			{ kind: "text", text: "done" },
		]);
		await svc.mergeSummaryIntoWiki(buildMergeInput({ topicId: "path-prefix-test" }));
		const root = wiki.get(memoryTopicRootId("path-prefix-test"))!;
		const leaf = wiki.getChildren(root.id)[0];
		// The tool's createMemory synthesizes path `memory:<slug>` (sub-6),
		// NOT the store-direct `memory-topic:<topicId>:<slug>`. This is the
		// unified-path-prefix invariant — going through the tool avoids mixing
		// two path schemes under the same topic parent.
		expect(leaf.path).toMatch(/^memory:/);
		expect(leaf.path).not.toMatch(new RegExp(`^${MEMORY_TOPIC_PATH_PREFIX}:`));
	});
});

// ─── 7. 输出格式核对 + 兜底(agent loop 失败 → skipped,不抛)──────────

describe("sub-7 output check + fallback (agent loop failure → skipped, never throws)", () => {
	test("LLM error during the loop → result skipped, no throw", async () => {
		const failingModel = {
			specificationVersion: "v3" as const,
			provider: "stub",
			modelId: "stub",
			supportedUrls: {},
			async doGenerate() { throw new Error("provider down"); },
			async doStream() { throw new Error("provider down"); },
		};
		const svc = new ExtractorAService({
			providers: [], providerName: "stub", modelId: "stub",
			wiki, testModel: failingModel,
		});
		// Must NOT throw — the merge is fire-and-forget from compressSession.
		const result = await svc.mergeSummaryIntoWiki(buildMergeInput({}));
		expect(result.skipped).toBe(true);
		expect(result.mergeCount).toBe(0);
	});

	test("empty summary sections → skipped immediately, no agent call", async () => {
		let modelCalled = 0;
		const svc = new ExtractorAService({
			providers: [], providerName: "stub", modelId: "stub",
			wiki,
			testModel: {
				specificationVersion: "v3" as const, provider: "stub", modelId: "stub",
				supportedUrls: {},
				async doGenerate() { modelCalled++; return { content: [{ type: "text", text: "" }], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] }; },
				async doStream() { modelCalled++; return { stream: new ReadableStream() }; },
			},
		});
		const result = await svc.mergeSummaryIntoWiki({
			summary: { title: "empty", sections: {}, stepRange: { from: 0, to: 1 }, createdAt: "" },
			topicId: "x",
		});
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toMatch(/empty summary/);
		expect(modelCalled).toBe(0); // never invoked
	});
});

// ─── 8. compressSession 接 Extractor A(summary 写 messages + 喂 wiki)─

describe("sub-7 wiring — compressSession feeds summaries to Extractor A", () => {
	test("compressSession with extractorA wired → each summary triggers a wiki merge", async () => {
		// Seed a compressible session (tiny window → fresh-tail budget small).
		const sessionId = "sess-wire";
		const big = "x".repeat(3000);
		sessionDB.appendStep(sessionId, 0, 0, "user", "build auth");
		sessionDB.appendStep(sessionId, 1, 0, "assistant", JSON.stringify([{ type: "text", text: big }]));
		sessionDB.appendStep(sessionId, 2, 2, "user", "build billing");
		sessionDB.appendStep(sessionId, 3, 2, "assistant", JSON.stringify([{ type: "text", text: big }]));

		let mergeCalls = 0;
		const fakeService = {
			mergeSummaryIntoWiki: async (_input: MergeSummaryInput) => {
				mergeCalls++;
				return { extractedCount: 1, createdCount: 1, updatedCount: 0, mergeCount: 1, skipped: false };
			},
		};
		const summaryModel = (() => {
			let n = 0;
			return {
				specificationVersion: "v3" as const, provider: "stub", modelId: "stub",
				supportedUrls: {},
				async doGenerate() {
					n++;
					// Two segments (turn_group 0 + 2) → two summary LLM calls.
					return {
						content: [{ type: "text", text: JSON.stringify({
							purpose: `task ${n}`,
							plan: "p", status: `did. 下一步: continue`, artifacts: "a", lessons: "l",
						}) }],
						finishReason: "stop",
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
						warnings: [],
					};
				},
				async doStream() { return { stream: new ReadableStream() }; },
			};
		})();

		const result = await compressSession(sessionId, sessionDB, {
			providers: [], providerName: "stub", modelId: "stub",
			contextWindow: 1000,
			testModel: summaryModel,
			extractorA: {
				service: fakeService as any,
				resolveTopic: (summary, _seg, sid) => ({ topicId: `topic-${sid}-${summary.stepRange?.from}`, agentId: "dev" }),
			},
		});

		// 2 segments → 2 summaries → 2 merge calls.
		expect(result.summaries.length).toBe(2);
		// Fire-and-forget: the merges are dispatched but not awaited by
		// compressSession. Since our fakeService.mergeSummaryIntoWiki resolves
		// synchronously, we macrotask-wait for the void promise to settle.
		await new Promise(r => setTimeout(r, 50));
		expect(mergeCalls).toBe(2);
	});

	test("compressSession without extractorA → only messages summary (sub-4 behavior intact)", async () => {
		const sessionId = "sess-no-wiki";
		const big = "x".repeat(3000);
		// Seed 2 segments so the older one is pushed past the fresh-tail
		// budget (window=1000 → budget ≈ 200 token ≈ 800 char; one ~3000-char
		// segment exceeds it, making the older segment compressible).
		sessionDB.appendStep(sessionId, 0, 0, "user", "go");
		sessionDB.appendStep(sessionId, 1, 0, "assistant", JSON.stringify([{ type: "text", text: big }]));
		sessionDB.appendStep(sessionId, 2, 2, "user", "again");
		sessionDB.appendStep(sessionId, 3, 2, "assistant", JSON.stringify([{ type: "text", text: big }]));

		const result = await compressSession(sessionId, sessionDB, {
			providers: [], providerName: "stub", modelId: "stub",
			contextWindow: 1000,
			testModel: {
				specificationVersion: "v3" as const, provider: "stub", modelId: "stub",
				supportedUrls: {},
				async doGenerate() {
					return {
						content: [{ type: "text", text: JSON.stringify({ status: "did. 下一步: x" }) }],
						finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [],
					};
				},
				async doStream() { return { stream: new ReadableStream() }; },
			},
			// no extractorA — wiki merge not wired.
		});
		expect(result.summaries.length).toBeGreaterThanOrEqual(1);
		// No wiki nodes written (no extractorA wired).
		expect(wiki.listMemoryNodes().length).toBe(0);
	});
});
