// M5 单元测试:归档提取者 + 记忆恢复(D-C) —— steps-overhaul sub-7 修订版
//
// # 文件说明书
//
// ## 核心功能
// sub-7 退役了 extraction-hooks 的阈值独立抽取通路(机制 2 StepEnd 阈值 +
// 机制 3 closeFlushSession):wiki 抽取现在由 compressSession 的 Force-档 memory
// ephemeral turn 承担(sub-3c)。本测试反映这个新现实:
//
// 仍验证(未退役的部分):
//   - ExtractionCursorStore / TelemetryStore 基础 CRUD + dedupe
//   - ExtractorBService 类仍可独立调(未来触发器可挂回;B 的 telemetry 写入
//     语义没变)
//   - sliceTranscriptDelta 切片器(压缩/抽取都用)
//   - resume: 全量原始 turn(step 表);new session 只拿 wiki memory
//   - pruneIfNeeded 大单 turn 不裸丢
//
// compression-archive-simplify sub-5: extraction-hooks.ts 整体删除。本文件原
// 「extraction-hooks RETIRED」section(测 no-op stubs)一并删除——无 live
// code 可测。registerExtractionHooks / closeFlushSession / _resetExtractionScheduler
// imports + beforeEach/afterEach 调用清掉。ExtractorB 部分(独立类,文件保留)
// 不受影响。
//
// ## 输入
// 临时 CoreDatabase (mkdtempSync) + ExtractionCursorStore + TelemetryStore +
// 注入 testModel stub 的 ExtractorBService.
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
// round-2 E4: WikiStore import removed (wiki-node-store deleted in plan-08
// §1). The `wiki` variable in beforeEach was created but never referenced by
// any case in this file — pure dead wiring. All non-wiki coverage
// (ExtractionCursorStore / TelemetryStore / ExtractorBService /
// sliceTranscriptDelta / AgentSession prune) preserved.
import { ExtractionCursorStore } from "../../src/server/extraction-cursor-store.js";
import { TelemetryStore } from "../../src/server/telemetry-store.js";
import { ExtractorBService } from "../../src/server/extractor-b-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { sliceTranscriptDelta } from "../../src/runtime/transcript-delta.js";
import { AgentSession } from "../../src/runtime/session.js";
import { HookRegistry } from "../../src/core/hook-registry.js";

let tmpDir: string;
let sessionDB: CoreDatabase;
let cursorStore: ExtractionCursorStore;
let telemetryStore: TelemetryStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m5-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	cursorStore = sessionDB.getExtractionCursorStore();
	telemetryStore = sessionDB.getTelemetryStore();
	// Reset hook registry between tests so nothing carries state across files.
	HookRegistry.getInstance().clear();
});

afterEach(() => {
	HookRegistry.getInstance().clear();
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────

/** Stub model: returns the given text as generateText result (no tool calls). */
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

function makeExtractorB(modelText: string): ExtractorBService {
	return new ExtractorBService({
		providers: [], providerName: "stub", modelId: "stub",
		telemetry: telemetryStore, testModel: stubModel(modelText),
	});
}

function seedSteps(sessionId: string, steps: Array<{ role: "user" | "assistant"; content: string }>): void {
	// Offset by existing step count so multiple seedSteps calls on the same
	// session APPEND rather than collide on seq.
	let seq = sessionDB.getStepCount(sessionId);
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

// ─── 3. ExtractorBService: writes telemetry (class preserved, sub-7) ──

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

// ─── 4. extraction-hooks RETIRED + DELETED (compression-archive-simplify sub-5)
//
// compression-archive-simplify sub-5: extraction-hooks.ts 整体删除。原 section
// 测的是 no-op stubs 的「不调度 extractor」+「source 仍含 RETIRED 标记」.
// 文件已不存在 → 无可测对象,section 整体删除。ExtractorA 的 wiki 合并通路
// 现由 compressSession 的 Force-档 memory ephemeral turn 承担(sub-3c),其
// 行为在 sub-3c/sub-4 专项测试覆盖。

// ─── 5. Mechanism 1 + resume: raw turns already in session storage ──

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
});

// ─── 6. prune/compress order fix — large single turn not naked-dropped ──

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

// ─── 7. sliceTranscriptDelta ──────────────────────────────────

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
