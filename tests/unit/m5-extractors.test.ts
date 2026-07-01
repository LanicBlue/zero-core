// M5 单元测试:归档提取者 + 记忆恢复(D-C)
//
// # 文件说明书
//
// ## 核心功能
// 验证 M5 核心交付 (acceptance-M5.md):
//   - ExtractionCursorStore / TelemetryStore 基础 CRUD + dedupe
//   - 提取者 A 写全局 wiki type=memory 节点(不在 project 子树)+ 按 (subject,type) 演进
//   - 提取者 B 写 telemetry(按 (sessionId,toolName,kind,signature) upsert 累加)
//   - 低 checkpoint 增量提取触发点(20/45/70):按 token-budget 低点,不按 turn
//   - 每次触发只处理 cursor 后 delta
//   - 关闭 flush = 对尾批的最后一次 delta
//   - 大单 turn 不再被裸丢(pruneIfNeeded 截断保留,不裸丢)
//   - resume: 全量原始 turn + 召回 wiki memory(rebuildFromTurns 读 step 表)
//   - new session: 只拿 wiki memory
//   - **明确未引入回归**:无活 checkpoint / 无 transition 检测器 / 无外部事件锚点 / 无每 turn 压缩
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + WikiStore + ExtractionCursorStore + TelemetryStore +
// 注入 testModel stub 的 ExtractorAService / ExtractorBService.
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	memoryTypeRootId,
} from "../../src/server/wiki-node-store.js";
import { ExtractionCursorStore } from "../../src/server/extraction-cursor-store.js";
import { TelemetryStore } from "../../src/server/telemetry-store.js";
import { ExtractorAService } from "../../src/server/extractor-a-service.js";
import { ExtractorBService } from "../../src/server/extractor-b-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { sliceTranscriptDelta } from "../../src/runtime/transcript-delta.js";
import { AgentSession } from "../../src/runtime/session.js";
import {
	registerExtractionHooks,
	closeFlushSession,
	_resetExtractionScheduler,
} from "../../src/runtime/hooks/extraction-hooks.js";
import { HookRegistry } from "../../src/core/hook-registry.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let cursorStore: ExtractionCursorStore;
let telemetryStore: TelemetryStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m5-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	cursorStore = sessionDB.getExtractionCursorStore();
	telemetryStore = sessionDB.getTelemetryStore();
	// Reset hook registry between tests so the extraction hook doesn't carry
	// state across files.
	HookRegistry.getInstance().clear();
	_resetExtractionScheduler();
});

afterEach(() => {
	HookRegistry.getInstance().clear();
	_resetExtractionScheduler();
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────

/** Stub model: returns the given text as generateText result. */
function stubModel(text: string): any {
	return {
		specificationVersion: "v2",
		provider: "stub",
		modelId: "stub",
		async doGenerate() {
			return {
				content: [{ type: "text", text }],
				finishReason: "stop",
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				warnings: [],
			};
		},
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					controller.enqueue({ type: "text-start", id: "1" });
					controller.enqueue({ type: "text-delta", id: "1", delta: text });
					controller.enqueue({ type: "text-end", id: "1" });
					controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
					controller.close();
				},
			});
			return { stream };
		},
	};
}

function makeExtractorA(modelText: string): ExtractorAService {
	return new ExtractorAService({
		providers: [], providerName: "stub", modelId: "stub",
		wiki, testModel: stubModel(modelText),
	});
}

function makeExtractorB(modelText: string): ExtractorBService {
	return new ExtractorBService({
		providers: [], providerName: "stub", modelId: "stub",
		telemetry: telemetryStore, testModel: stubModel(modelText),
	});
}

function seedSteps(sessionId: string, steps: Array<{ role: "user" | "assistant"; content: string }>): void {
	// Offset by existing step count so multiple seedSteps calls on the same
	// session APPEND rather than collide on seq.
	let seq = sessionDB.getTurnCount(sessionId);
	let group = seq > 0 ? seq - 1 : 0;
	for (const s of steps) {
		if (s.role === "user") group = seq;
		sessionDB.appendStep(sessionId, seq, group, s.role, s.content);
		seq++;
	}
}

// ─── 1. ExtractionCursorStore ─────────────────────────────────

describe("ExtractionCursorStore", () => {
	test("get returns undefined for unknown session", () => {
		expect(cursorStore.get("nope")).toBeUndefined();
	});

	test("upsert creates then updates the same row", () => {
		cursorStore.upsert({ sessionId: "s1", lastExtractedSeq: 5, lastThresholdIdx: 0 });
		let row = cursorStore.get("s1")!;
		expect(row.lastExtractedSeq).toBe(5);
		expect(row.lastThresholdIdx).toBe(0);

		cursorStore.upsert({ sessionId: "s1", lastExtractedSeq: 12, lastThresholdIdx: 1 });
		row = cursorStore.get("s1")!;
		expect(row.lastExtractedSeq).toBe(12);
		expect(row.lastThresholdIdx).toBe(1);
	});

	test("delete removes the cursor", () => {
		cursorStore.upsert({ sessionId: "s1", lastExtractedSeq: 3, lastThresholdIdx: 0 });
		cursorStore.delete("s1");
		expect(cursorStore.get("s1")).toBeUndefined();
	});
});

// ─── 2. TelemetryStore ────────────────────────────────────────

describe("TelemetryStore", () => {
	test("record creates a row on first occurrence", () => {
		const r = telemetryStore.record({
			sessionId: "s1", toolName: "bash",
			kind: "bad_arguments", signature: "bash#missing-flag--recursive",
			sample: "ran bash --recursive",
		});
		expect(r.occurrenceCount).toBe(1);
		expect(telemetryStore.listBySession("s1").length).toBe(1);
	});

	test("record dedupes by (sessionId, toolName, kind, signature) and bumps count", () => {
		telemetryStore.record({ sessionId: "s1", toolName: "bash", kind: "bad_arguments", signature: "sig1" });
		telemetryStore.record({ sessionId: "s1", toolName: "bash", kind: "bad_arguments", signature: "sig1" });
		telemetryStore.record({ sessionId: "s1", toolName: "bash", kind: "bad_arguments", signature: "sig1" });
		const rows = telemetryStore.listBySession("s1");
		expect(rows.length).toBe(1);
		expect(rows[0].occurrenceCount).toBe(3);
	});

	test("same signature different session → two rows", () => {
		telemetryStore.record({ sessionId: "s1", toolName: "bash", kind: "bad_arguments", signature: "sig1" });
		telemetryStore.record({ sessionId: "s2", toolName: "bash", kind: "bad_arguments", signature: "sig1" });
		expect(telemetryStore.listBySession("s1").length).toBe(1);
		expect(telemetryStore.listBySession("s2").length).toBe(1);
	});
});

// ─── 3. ExtractorA: writes global memory node + evolves ───────

describe("ExtractorAService", () => {
	test("writes global type=memory nodes (NOT under any project subtree)", async () => {
		const svc = makeExtractorA(JSON.stringify([
			{ subject: "ProjectX", type: "decision", content: "Decided to use SQLite." },
		]));
		const result = await svc.extractDelta({
			sessionId: "s1", agentId: "dev",
			transcript: "User: ... Assistant: we picked SQLite",
			fromSeq: 0, toSeq: 2,
		});
		expect(result.skipped).toBe(false);
		expect(result.createdCount).toBe(1);

		const memoryNodes = wiki.listMemoryNodes();
		expect(memoryNodes.length).toBeGreaterThan(0);
		// Memory node should NOT live under any project subtree.
		const projects = wiki.listProjects();
		for (const p of projects) {
			const subtreeIds = wiki.listByProject(p).map(n => n.id);
			for (const m of memoryNodes) {
				expect(subtreeIds).not.toContain(m.id);
			}
		}
	});

	test("merges into existing memory node by (subject, type) — UPDATE not new", async () => {
		// First extraction: creates a decision node.
		const svc1 = makeExtractorA(JSON.stringify([
			{ subject: "ProjectX", type: "decision", content: "v1" },
		]));
		await svc1.extractDelta({ sessionId: "s1", transcript: "x", fromSeq: 0, toSeq: 1 });
		const after1 = wiki.listMemoryNodes().filter(n => !n.path?.startsWith("memory-root:"));
		expect(after1.length).toBe(1);

		// Second extraction: same subject + type → UPDATE existing.
		const svc2 = makeExtractorA(JSON.stringify([
			{ subject: "ProjectX", type: "decision", content: "v2 — superseded" },
		]));
		const result2 = await svc2.extractDelta({ sessionId: "s1", transcript: "x", fromSeq: 1, toSeq: 2 });
		expect(result2.createdCount).toBe(0);
		expect(result2.updatedCount).toBe(1);

		const after2 = wiki.listMemoryNodes().filter(n => !n.path?.startsWith("memory-root:"));
		expect(after2.length).toBe(1); // still only one — UPDATE not new
		// The summary was updated to v2.
		expect(after2[0].summary).toContain("v2");
	});

	test("returns skipped=true when transcript is empty", async () => {
		const svc = makeExtractorA("[]");
		const result = await svc.extractDelta({ sessionId: "s1", transcript: "", fromSeq: 0, toSeq: 0 });
		expect(result.skipped).toBe(true);
	});

	test("returns skipped=true when LLM returns no facts", async () => {
		const svc = makeExtractorA("[]");
		const result = await svc.extractDelta({ sessionId: "s1", transcript: "stuff", fromSeq: 0, toSeq: 1 });
		expect(result.skipped).toBe(true);
	});
});

// ─── 4. ExtractorB: writes telemetry ──────────────────────────

describe("ExtractorBService", () => {
	test("extracts findings + writes to telemetry store", async () => {
		const svc = makeExtractorB(JSON.stringify([
			{
				toolName: "bash", kind: "bad_arguments",
				signature: "bash#missing-flag", sample: "ran bash --recursive",
			},
		]));
		const result = await svc.extractDelta({
			sessionId: "s1", transcript: "User: ... Assistant: tool[bash]",
			fromSeq: 0, toSeq: 1,
			knownToolNames: ["bash"],
		});
		expect(result.skipped).toBe(false);
		expect(result.extractedCount).toBe(1);
		const rows = telemetryStore.listBySession("s1");
		expect(rows.length).toBe(1);
		expect(rows[0].toolName).toBe("bash");
		expect(rows[0].kind).toBe("bad_arguments");
	});

	test("demotes hallucinated_tool to other_failure when name IS in known catalog", async () => {
		const svc = makeExtractorB(JSON.stringify([
			{
				toolName: "bash", kind: "hallucinated_tool",
				signature: "bash#fake", sample: "called nonexistent bash",
			},
		]));
		await svc.extractDelta({
			sessionId: "s1", transcript: "x",
			fromSeq: 0, toSeq: 1,
			knownToolNames: ["bash"], // bash IS known
		});
		const rows = telemetryStore.listBySession("s1");
		expect(rows[0].kind).toBe("other_failure");
	});
});

// ─── 5. Mechanism 2: low-checkpoint incremental extraction ────

describe("Mechanism 2 — low-checkpoint incremental extraction hook", () => {
	test("triggers at 20% threshold (NOT at 0%) and processes cursor delta", async () => {
		// Start with 2 turns. As the test progresses we add more turns so each
		// subsequent threshold crossing has new delta to extract.
		const sessionId = "sess-A";
		seedSteps(sessionId, [
			{ role: "user", content: "what storage?" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "we should pick SQLite" }]) },
		]);

		// Register hook with stub-backed extractors.
		let aCalled = 0;
		registerExtractionHooks({
			cursorStore,
			buildExtractorA: () => {
				aCalled++;
				return makeExtractorA(JSON.stringify([
					{ subject: "ProjectX", type: "decision", content: "use SQLite" },
				]));
			},
			buildExtractorB: () => makeExtractorB("[]"),
		});

		const registry = HookRegistry.getInstance();
		const config: any = {
			agentId: "dev", sessionId,
			db: sessionDB,
			providerName: "stub", modelId: "stub",
			toolPolicy: {},
			extractors: { A: { enabled: true }, B: { enabled: false }, checkpointThresholds: [0.2, 0.45, 0.7] },
		};

		// 0% usage → no trigger.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.0, providers: [],
		});
		expect(aCalled).toBe(0);

		// 20% usage → first threshold crossed → trigger.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.21, providers: [],
		});
		expect(aCalled).toBe(1);

		// Cursor advanced: lastThresholdIdx = 0.
		const cursor = cursorStore.get(sessionId)!;
		expect(cursor.lastThresholdIdx).toBe(0);
		expect(cursor.lastExtractedSeq).toBeGreaterThanOrEqual(0);

		// 25% usage (same threshold band) → no new trigger.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.25, providers: [],
		});
		expect(aCalled).toBe(1);

		// Add 2 more turns so the 45% trigger has new delta to process.
		seedSteps(sessionId, [
			{ role: "user", content: "what next?" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "build the schema" }]) },
		]);

		// 45% usage → second threshold crossed → trigger again.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.46, providers: [],
		});
		expect(aCalled).toBe(2);
		expect(cursorStore.get(sessionId)!.lastThresholdIdx).toBe(1);

		// Add 2 more turns for the 70% trigger.
		seedSteps(sessionId, [
			{ role: "user", content: "what else?" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "test it" }]) },
		]);

		// 70% usage → third threshold crossed → trigger again.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.71, providers: [],
		});
		expect(aCalled).toBe(3);
		expect(cursorStore.get(sessionId)!.lastThresholdIdx).toBe(2);
	});

	test("each trigger only processes delta after cursor (not whole transcript)", async () => {
		const sessionId = "sess-delta";
		// Seed 4 turns.
		seedSteps(sessionId, [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "a1" }]) },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "a2" }]) },
		]);

		const sliceSpy: Array<{ fromSeq: number; toSeq: number }> = [];
		let aModelJson = JSON.stringify([
			{ subject: "SubjX", type: "decision", content: "v1" },
		]);

		registerExtractionHooks({
			cursorStore,
			buildExtractorA: () => {
				const svc = new ExtractorAService({
					providers: [], providerName: "stub", modelId: "stub",
					wiki, testModel: stubModel(aModelJson),
				});
				const orig = svc.extractDelta.bind(svc);
				svc.extractDelta = async (delta) => {
					sliceSpy.push({ fromSeq: delta.fromSeq, toSeq: delta.toSeq });
					return orig(delta);
				};
				return svc;
			},
			buildExtractorB: () => makeExtractorB("[]"),
		});

		const registry = HookRegistry.getInstance();
		const config: any = {
			agentId: "dev", sessionId, db: sessionDB,
			providerName: "stub", modelId: "stub",
			toolPolicy: {},
			extractors: { A: { enabled: true }, B: { enabled: false }, checkpointThresholds: [0.2, 0.45] },
		};

		// Fire at 20% — first 4 steps, cursor was -1, so fromSeq=0.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.21, providers: [],
		});
		expect(sliceSpy.length).toBe(1);
		expect(sliceSpy[0].fromSeq).toBe(0);

		// Add 2 more steps (turns 5,6) so the next slice has work to do.
		seedSteps(sessionId, [
			{ role: "user", content: "q3" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "a3" }]) },
		]);

		// Fire at 45% — should process only the delta (cursor+1 to current).
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.46, providers: [],
		});
		expect(sliceSpy.length).toBe(2);
		// The second slice's fromSeq must be GREATER than the first's
		// (delta-only, not whole transcript again).
		expect(sliceSpy[1].fromSeq).toBeGreaterThan(sliceSpy[0].fromSeq);
	});
});

// ─── 6. Mechanism 3: close flush ──────────────────────────────

describe("Mechanism 3 — close flush (session eviction)", () => {
	test("closeFlushSession runs extractor A on tail batch (post-cursor)", async () => {
		const sessionId = "sess-flush";
		seedSteps(sessionId, [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "decided X" }]) },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "decided Y (tail batch)" }]) },
		]);
		// Simulate that mechanism 2 already extracted up to seq 1.
		cursorStore.upsert({ sessionId, lastExtractedSeq: 1, lastThresholdIdx: 2 });

		let aCalled = 0;
		let capturedFromSeq = -1;
		registerExtractionHooks({
			cursorStore,
			buildExtractorA: () => {
				aCalled++;
				const svc = new ExtractorAService({
					providers: [], providerName: "stub", modelId: "stub",
					wiki, testModel: stubModel(JSON.stringify([
						{ subject: "TailBatch", type: "decision", content: "tail decision" },
					])),
				});
				const orig = svc.extractDelta.bind(svc);
				svc.extractDelta = async (delta) => {
					capturedFromSeq = delta.fromSeq;
					return orig(delta);
				};
				return svc;
			},
			buildExtractorB: () => makeExtractorB("[]"),
		});

		const config: any = {
			agentId: "dev", sessionId, db: sessionDB,
			providerName: "stub", modelId: "stub",
			toolPolicy: {},
			extractors: { A: { enabled: true }, B: { enabled: false } },
		};

		await closeFlushSession({
			sessionId,
			resolveConfig: () => config,
			resolveProviders: () => [],
		});

		expect(aCalled).toBe(1);
		// Tail batch starts AFTER cursor (cursor was 1, so tail starts at seq 2).
		expect(capturedFromSeq).toBe(2);
	});

	test("closeFlushSession is a no-op when cursor is already at the tail", async () => {
		const sessionId = "sess-flush-empty";
		seedSteps(sessionId, [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "a1" }]) },
		]);
		// Cursor already past all turns.
		cursorStore.upsert({ sessionId, lastExtractedSeq: 1, lastThresholdIdx: 2 });

		let aCalled = 0;
		registerExtractionHooks({
			cursorStore,
			buildExtractorA: () => { aCalled++; return makeExtractorA("[]"); },
			buildExtractorB: () => makeExtractorB("[]"),
		});
		const config: any = {
			agentId: "dev", sessionId, db: sessionDB,
			providerName: "stub", modelId: "stub", toolPolicy: {},
			extractors: { A: { enabled: true }, B: { enabled: false } },
		};
		await closeFlushSession({
			sessionId,
			resolveConfig: () => config,
			resolveProviders: () => [],
		});
		expect(aCalled).toBe(0); // no tail to flush
	});
});

// ─── 7. Mechanism 1 + resume: raw turns already in session storage ──

describe("Mechanism 1 — raw turn persistence (resume gets full history)", () => {
	test("AgentSession rebuilds messages from step-level storage on construct", () => {
		const sessionId = "sess-raw";
		seedSteps(sessionId, [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "hi" }]) },
			{ role: "user", content: "do thing" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "done" }]) },
		]);
		// New AgentSession pointing at the existing sessionId reconstructs
		// from the step table (mechanism 1 — zero LLM cost).
		const sess = new AgentSession("sysprompt", 128000, sessionId, sessionDB);
		const msgs = sess.getMessages();
		expect(msgs.length).toBe(4);
		expect((msgs[0] as any).role).toBe("user");
		expect((msgs[3] as any).role).toBe("assistant");
	});

	test("new session (no steps) gets empty messages but recall can still hit wiki memory", async () => {
		// Write a wiki memory node via extractor A (simulating prior close flush).
		const svc = makeExtractorA(JSON.stringify([
			{ subject: "ImportantThing", type: "decision", content: "we chose X" },
		]));
		await svc.extractDelta({ sessionId: "old-sess", transcript: "x", fromSeq: 0, toSeq: 1 });

		// New session: no steps at all.
		const newSessionId = "new-sess";
		const sess = new AgentSession("sys", 128000, newSessionId, sessionDB);
		expect(sess.getMessages().length).toBe(0);

		// v0.8 (P2 §11.6): MemoryRecall is retired — memory is now a wiki
		// per-agent subtree. Reading goes through WikiStore.searchMemoryNodes
		// (title+summary+body scan) + WikiStore.readNodeDetail (body).
		const hits = wiki.searchMemoryNodes("ImportantThing");
		expect(hits.length).toBeGreaterThan(0);
		const detail = wiki.readNodeDetail(hits[0].id) ?? "";
		expect(detail).toContain("ImportantThing");
	});
});

// ─── 8. prune/compress order fix — large single turn not naked-dropped ──

describe("prune/compress order fix (RFC §2.18)", () => {
	test("large single turn is truncated to fit, NOT naked-dropped", () => {
		// Build a session with one giant assistant message.
		const sess = new AgentSession("sys", 1000 /* tiny context */, undefined, undefined);
		// 100k chars → ~25k tokens, way over the 1000-token context.
		const huge = "X".repeat(100000);
		sess.addMessage({ role: "user", content: "go" } as any);
		sess.addMessage({ role: "assistant", content: huge } as any);
		// Before prune: 2 messages.
		expect(sess.getMessages().length).toBe(2);
		return (sess as any).pruneIfNeeded().then(() => {
			const msgs = sess.getMessages();
			// After prune: at least 1 message survives (NOT zero — that would
			// be the naked-drop bug).
			expect(msgs.length).toBeGreaterThanOrEqual(1);
			// The kept message is truncated (has the truncation note).
			const last = msgs[msgs.length - 1] as any;
			const content = typeof last.content === "string"
				? last.content
				: JSON.stringify(last.content ?? {});
			expect(content).toContain("truncated by pruneIfNeeded");
		});
	});
});

// ─── 9. sliceTranscriptDelta ──────────────────────────────────

describe("sliceTranscriptDelta", () => {
	test("returns empty slice when no steps in range", () => {
		seedSteps("sess-x", [
			{ role: "user", content: "q1" },
			{ role: "assistant", content: JSON.stringify([{ type: "text", text: "a1" }]) },
		]);
		const slice = sliceTranscriptDelta(sessionDB, "sess-x", 5, 10);
		expect(slice.transcript).toBe("");
		expect(slice.stepCount).toBe(0);
	});

	test("renders user + assistant text + tool blocks", () => {
		seedSteps("sess-y", [
			{ role: "user", content: "what files?" },
			{ role: "assistant", content: JSON.stringify([
				{ type: "text", text: "listing" },
				{ type: "tool", name: "glob", status: "done", args: { pattern: "*" }, result: "['a.ts']" },
			]) },
		]);
		const slice = sliceTranscriptDelta(sessionDB, "sess-y", 0, 2);
		expect(slice.stepCount).toBe(2);
		expect(slice.transcript).toContain("User:");
		expect(slice.transcript).toContain("Assistant:");
		expect(slice.transcript).toContain("glob");
	});
});

// ─── 10. "Explicit not introduced" regression (acceptance-M5 末尾) ──

describe("M5 regression — explicitly NOT introduced", () => {
	test("no live checkpoint concept — cursor is just (lastExtractedSeq, lastThresholdIdx)", () => {
		// The cursor store's columns are extraction-progress only.
		// There is no "current work state" / "active checkpoint" node.
		cursorStore.upsert({ sessionId: "x", lastExtractedSeq: 0, lastThresholdIdx: 0 });
		const row = cursorStore.get("x")!;
		expect(Object.keys(row).sort()).toEqual(
			["createdAt", "lastExtractedAt", "lastExtractedSeq", "lastThresholdIdx", "sessionId", "updatedAt"].sort(),
		);
		// No 'transition' / 'taskState' / 'workState' / 'activeCheckpoint' field.
		expect((row as any).transition).toBeUndefined();
		expect((row as any).taskState).toBeUndefined();
		expect((row as any).workState).toBeUndefined();
		expect((row as any).activeCheckpoint).toBeUndefined();
	});

	test("no transition / task-change detector — extraction triggers only on token budget", async () => {
		// Confirm the hook checks contextUsage against thresholds and nothing else.
		const sessionId = "sess-no-trans";
		seedSteps(sessionId, [{ role: "user", content: "q" }]);

		let aCalled = 0;
		registerExtractionHooks({
			cursorStore,
			buildExtractorA: () => { aCalled++; return makeExtractorA("[]"); },
			buildExtractorB: () => makeExtractorB("[]"),
		});
		const registry = HookRegistry.getInstance();
		const config: any = {
			agentId: "dev", sessionId, db: sessionDB,
			providerName: "stub", modelId: "stub", toolPolicy: {},
			// Even with NO checkpointThresholds, the default is the token-budget
			// triple [0.2, 0.45, 0.7]. There is no "transition detector" that
			// would fire on tool-name changes or task boundaries.
			extractors: { A: { enabled: true }, B: { enabled: false } },
		};
		// Below 20% → no trigger, regardless of how many "task transitions"
		// happened in the transcript.
		await (registry as any).trigger("StepEnd", {
			agentId: "dev", sessionId, config, contextUsage: 0.1, providers: [],
		});
		expect(aCalled).toBe(0);
	});

	test("no external-event anchor — extraction source files have no write/api/委托 anchors", () => {
		// Static check: the M5 extraction hook file must not contain logic
		// that keys off toolName === "Write" / API calls / 委托 type as a
		// trigger. Trigger is contextUsage (token budget) only.
		const fs = require("node:fs");
		const path = require("node:path");
		const src = fs.readFileSync(
			path.join(__dirname, "..", "..", "src", "runtime", "hooks", "extraction-hooks.ts"),
			"utf-8",
		);
		// Hook should reference contextUsage + thresholds.
		expect(src).toContain("contextUsage");
		expect(src).toContain("thresholds");
		// Hook should NOT key off tool name or event type as the trigger.
		expect(src).not.toContain('toolName === "Write"');
		expect(src).not.toContain('toolName === "Edit"');
		expect(src).not.toContain('event === "api"');
	});

	test("no per-turn compression — extractor fires only at budget checkpoints", () => {
		// Mechanism 2 explicitly states: trigger by token-budget low point,
		// NOT by turn (every turn would be too expensive).
		// The hook only fires when a new threshold is crossed — calling it
		// every turn at the same usage does NOT re-fire (covered by the
		// 'same threshold band → no new trigger' assertion in test 5).
		// This test exists to document the invariant explicitly.
		const fs = require("node:fs");
		const path = require("node:path");
		const src = fs.readFileSync(
			path.join(__dirname, "..", "..", "src", "runtime", "hooks", "extraction-hooks.ts"),
			"utf-8",
		);
		// Each threshold fires at most once per session — enforced by the
		// cursor's lastThresholdIdx check.
		expect(src).toContain("nextIdx === cursor.lastThresholdIdx");
	});
});
