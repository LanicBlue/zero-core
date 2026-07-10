// 单元测试: multimodal-input sub-3
//
// # 文件说明书
//
// ## 核心功能
// 验证 getMessagesMultimodal 的 image-only inline + 当前 step 规则 + 历史元信息规则,
// 以及 provider-factory.getMultimodal 的能力检测(undefined→false / true→true /
// false→false)。覆盖 design 组件 3 + 组件 4 + #3 wiring 的下游消费侧。
//
// ## 范围
// - getMultimodal:undefined / true / false / provider 缺失 / model 缺失。
// - getMessagesMultimodal:
//   * 当前 step + image + multimodal=true → inline image part(从盘读 bytes)。
//   * 同一 image 在历史 step → 元信息文本 part。
//   * multimodal=false + 当前 image → 元信息文本。
//   * PDF / 任意文件 → 始终元信息(无论当前/支持)。
//   * 多附件混合(image+file):image inline(当前+支持)、file 元信息。
//   * bytes 读取:写真实临时文件,断言 inline 用了正确 bytes。
//   * 读盘失败 → 降级元信息文本(不崩 turn)。
//
// ## 不做
// run 签名(sub-4)、UI(sub-5)、live TurnStart 写附件(sub-4)。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/runtime/session.js";
import { getMultimodal, getContextWindow } from "../../src/runtime/provider-factory.js";
import type { AttachmentMeta, RuntimeProviderConfig } from "../../src/runtime/types.js";
import type { ISessionStore, StepRow } from "../../src/runtime/session-store-interface.js";

// ── Minimal in-memory ISessionStore stub ────────────────────────────────────
// Only getSteps is exercised by AgentSession.rebuildFromTurns; the rest are
// no-ops so we can drive getMessagesMultimodal without a real DB.
// steps-overhaul sub-3: getMessages/saveTurn/replaceStepsFromMessages removed
// from ISessionStore (messages table redefined to summary+cursor); the summary
// API is optional and omitted here — assembleLLMView null-checks it.
class MemStore implements ISessionStore {
	steps: StepRow[] = [];
	getTurnCount(): number { return this.steps.length; }
	getMainSession(): undefined { return undefined; }
	createSession(): any { throw new Error("not used"); }
	setMainSession(): void { /* no-op */ }
	listSessions(): any[] { return []; }
	listAllSessions(): any[] { return []; }
	deleteSession(): void { /* no-op */ }
	deleteTurn(): void { /* no-op */ }
	clearTurns(): void { this.steps = []; }
	getKVStore(): any { throw new Error("not used"); }
	getSteps(): StepRow[] { return this.steps; }
	getStepGroup(sessionId: string, turnGroup: number): StepRow[] {
		return this.steps.filter(s => s.turnGroup === turnGroup);
	}
	appendStep(
		_sessionId: string, seq: number, turnGroup: number, role: string,
		content: string | null, _usage?: any, attachments?: AttachmentMeta[],
	): void {
		this.steps.push({
			seq, turnGroup, role, content,
			inputTokens: 0, outputTokens: 0, totalTokens: 0,
			createdAt: new Date().toISOString(),
			attachments,
		});
	}
	upsertStep(
		_sessionId: string, seq: number, turnGroup: number, role: string,
		content: string | null, _usage?: any, attachments?: AttachmentMeta[],
	): void {
		const i = this.steps.findIndex(s => s.seq === seq);
		if (i >= 0) {
			this.steps[i] = { ...this.steps[i], turnGroup, role, content, attachments };
		} else {
			this.appendStep(_sessionId, seq, turnGroup, role, content, _usage, attachments);
		}
	}
	updateStepContent(): void { /* no-op */ }
	deleteStepGroup(_sessionId: string, turnGroup: number): void {
		this.steps = this.steps.filter(s => s.turnGroup !== turnGroup);
	}
	getTurnGroupCount(): number {
		return new Set(this.steps.map(s => s.turnGroup)).size;
	}
	recordToolExecution(): void { /* no-op */ }
}

// ── Test fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-mm-sub3-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function imageAttachment(fileName: string, mime: string, bytes: Buffer): AttachmentMeta {
	const diskPath = join(tmpDir, fileName);
	writeFileSync(diskPath, bytes);
	return {
		id: fileName + "-id",
		kind: "image",
		fileName,
		mimeType: mime,
		size: bytes.length,
		diskPath,
	};
}

function pdfAttachment(fileName: string): AttachmentMeta {
	const bytes = Buffer.from("%PDF-1.4 fake pdf body");
	const diskPath = join(tmpDir, fileName);
	writeFileSync(diskPath, bytes);
	return {
		id: fileName + "-id",
		kind: "pdf",
		fileName,
		mimeType: "application/pdf",
		size: bytes.length,
		diskPath,
	};
}

function fileAttachment(fileName: string, mime: string): AttachmentMeta {
	const bytes = Buffer.from("plain file payload");
	const diskPath = join(tmpDir, fileName);
	writeFileSync(diskPath, bytes);
	return {
		id: fileName + "-id",
		kind: "file",
		fileName,
		mimeType: mime,
		size: bytes.length,
		diskPath,
	};
}

/** Build a session pre-populated with user steps (the rebuild-from-turns path). */
function buildSession(opts: {
	multimodal?: boolean;
	steps: { seq: number; turnGroup: number; text: string; attachments?: AttachmentMeta[] }[];
}): { session: AgentSession; store: MemStore } {
	const store = new MemStore();
	for (const s of opts.steps) {
		store.appendStep("sess", s.seq, s.turnGroup, "user", s.text, undefined, s.attachments);
	}
	const session = new AgentSession("sys", 128000, "sess", store, opts.multimodal ?? false);
	return { session, store };
}

/** Pull the user message at index i out of a getMessagesMultimodal result. */
function userMsgAt(msgs: any[], i: number): any {
	const userMsgs = msgs.filter(m => m.role === "user");
	return userMsgs[i];
}

// ── getMultimodal / getContextWindow parity ────────────────────────────────

describe("getMultimodal — capability detection (component 4)", () => {
	const baseProviders = (multimodal: boolean | undefined): RuntimeProviderConfig[] => [{
		name: "openrouter",
		type: "openai-compatible",
		apiKey: "k",
		baseUrl: "https://openrouter.ai/api/v1",
		enabled: true,
		models: [{ id: "m1", name: "Model 1", multimodal }],
	}];

	test("multimodal === true → true", () => {
		expect(getMultimodal(baseProviders(true), "openrouter", "m1")).toBe(true);
	});

	test("multimodal === false → false", () => {
		expect(getMultimodal(baseProviders(false), "openrouter", "m1")).toBe(false);
	});

	test("multimodal === undefined → false (safe default, design D3)", () => {
		expect(getMultimodal(baseProviders(undefined), "openrouter", "m1")).toBe(false);
	});

	test("provider not found → false", () => {
		expect(getMultimodal(baseProviders(true), "nonexistent", "m1")).toBe(false);
	});

	test("model not found → false", () => {
		expect(getMultimodal(baseProviders(true), "openrouter", "missing")).toBe(false);
	});

	test("rides the SAME find path as getContextWindow (parity)", () => {
		// Same provider, same model lookup → multimodal flag comes off the same
		// ProviderModel object that supplies contextWindow.
		expect(getContextWindow(baseProviders(true), "openrouter", "m1")).toBe(128000);
		expect(getMultimodal(baseProviders(true), "openrouter", "m1")).toBe(true);
	});

	test("provider name normalization matches getContextWindow (case/sep agnostic)", () => {
		// getContextWindow normalizes "OpenRouter" → "openrouter"; getMultimodal
		// uses the SAME normalizeName so a differently-cased lookup still hits.
		expect(getMultimodal(baseProviders(true), "OpenRouter", "m1")).toBe(true);
	});
});

// ── getMessagesMultimodal — current/history + image-only inline ────────────

describe("getMessagesMultimodal — image-only inline + current-step rule", () => {
	const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

	test("CURRENT step + image + multimodal=true → inline image part with disk bytes", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "look at this", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		expect(u.role).toBe("user");
		expect(Array.isArray(u.content)).toBe(true);
		// text part first, then image part
		expect(u.content[0]).toEqual({ type: "text", text: "look at this" });
		expect(u.content[1].type).toBe("image");
		expect(u.content[1].mimeType).toBe("image/png");
		// image bytes = the disk file contents (Buffer is a Uint8Array subclass → valid DataContent)
		expect(Buffer.isBuffer(u.content[1].image)).toBe(true);
		expect(Buffer.from(u.content[1].image)).toEqual(PNG_BYTES);
	});

	test("same image in a HISTORY step → meta-info text (NOT inline), even with multimodal=true", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			// seq 0 = history, seq 2 = current (next user turn). The image sits on the HISTORY step.
			steps: [
				{ seq: 0, turnGroup: 0, text: "earlier", attachments: [att] },
				{ seq: 2, turnGroup: 2, text: "now" },
			],
		});
		session.setCurrentUserStepSeq(2);

		const msgs = session.getMessagesMultimodal();
		const history = userMsgAt(msgs, 0);
		expect(history.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: "earlier" }),
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("[attachment: cat.png"),
				}),
			]),
		);
		// no image part on the history message
		expect(history.content.some((p: any) => p.type === "image")).toBe(false);
		// meta-info carries the diskPath + size + mimeType
		const metaText = history.content.find((p: any) => typeof p.text === "string" && p.text.startsWith("[attachment:"));
		expect(metaText.text).toContain("type=image/png");
		expect(metaText.text).toContain(`size=${PNG_BYTES.length}`);
		expect(metaText.text).toContain("history attachment");
	});

	test("multimodal=false + current image step → meta-info text (NOT inline)", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: false,
			steps: [{ seq: 0, turnGroup: 0, text: "hi", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		expect(u.content.some((p: any) => p.type === "image")).toBe(false);
		expect(u.content.some((p: any) => p.text?.startsWith("[attachment: cat.png"))).toBe(true);
		expect(u.content.some((p: any) => p.text?.includes("model not multimodal"))).toBe(true);
	});

	test("PDF attachment → always meta-info (even current + multimodal=true)", () => {
		const att = pdfAttachment("doc.pdf");
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "read this", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		expect(u.content.some((p: any) => p.type === "image")).toBe(false);
		const meta = u.content.find((p: any) => p.text?.startsWith("[attachment: doc.pdf"));
		expect(meta).toBeDefined();
		expect(meta.text).toContain("type=application/pdf");
		expect(meta.text).toContain("pdf attachment");
	});

	test("arbitrary file attachment → always meta-info", () => {
		const att = fileAttachment("notes.txt", "text/plain");
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "see file", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		expect(u.content.some((p: any) => p.type === "image")).toBe(false);
		expect(u.content.some((p: any) => p.text?.startsWith("[attachment: notes.txt"))).toBe(true);
	});

	test("mixed attachments (image + file) on current step + multimodal → image inline, file meta", () => {
		const img = imageAttachment("a.png", "image/png", PNG_BYTES);
		const fil = fileAttachment("b.txt", "text/plain");
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "both", attachments: [img, fil] }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		// one image part (the png)
		const imageParts = u.content.filter((p: any) => p.type === "image");
		expect(imageParts.length).toBe(1);
		expect(imageParts[0].mimeType).toBe("image/png");
		// one meta-info text for the txt
		const txtMeta = u.content.find((p: any) => p.text?.startsWith("[attachment: b.txt"));
		expect(txtMeta).toBeDefined();
		expect(txtMeta.text).toContain("type=text/plain");
	});

	test("multi-step turn: same current user step stays 'current' across calls (all in-turn calls inline)", () => {
		const att = imageAttachment("x.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "q", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		// Two LLM-call reads within the same turn (simulating multi-step loop) —
		// both must see the inline image (current-step rule is per-turn, not per-call).
		const m1 = userMsgAt(session.getMessagesMultimodal(), 0);
		const m2 = userMsgAt(session.getMessagesMultimodal(), 0);
		expect(m1.content.some((p: any) => p.type === "image")).toBe(true);
		expect(m2.content.some((p: any) => p.type === "image")).toBe(true);
	});

	test("no currentUserStepSeq marked (default -1) → every user step treated as history (meta-info)", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "hi", attachments: [att] }],
		});
		// deliberate: do NOT call setCurrentUserStepSeq (default -1)

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		expect(u.content.some((p: any) => p.type === "image")).toBe(false);
		expect(u.content.some((p: any) => p.text?.startsWith("[attachment:"))).toBe(true);
	});

	test("getMessagesMultimodal does NOT mutate this.messages (bytes are per-call edge concern)", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "hi", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		// Original messages (the write-through cache) stay as plain-string user content.
		const before = session.getMessages();
		expect(before[0].content).toBe("hi");

		session.getMessagesMultimodal();

		const after = session.getMessages();
		expect(after[0].content).toBe("hi");
	});

	test("disk read failure → degrades to meta-info text (does NOT crash the turn)", () => {
		const att = imageAttachment("cat.png", "image/png", PNG_BYTES);
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "hi", attachments: [att] }],
		});
		session.setCurrentUserStepSeq(0);

		// Make the file unreadable. On Windows chmod 0 isn't always honored for
		// the owner, so we DELETE the file instead — readFileSync then throws ENOENT.
		rmSync(att.diskPath, { force: true });

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		// No image part; meta-info text carries an unreadable hint.
		expect(u.content.some((p: any) => p.type === "image")).toBe(false);
		const meta = u.content.find((p: any) => p.text?.startsWith("[attachment: cat.png"));
		expect(meta).toBeDefined();
		expect(meta.text).toContain("unreadable");
	});

	test("user step without attachments passes through unchanged (string content)", () => {
		const { session } = buildSession({
			multimodal: true,
			steps: [{ seq: 0, turnGroup: 0, text: "plain text only" }],
		});
		session.setCurrentUserStepSeq(0);

		const msgs = session.getMessagesMultimodal();
		const u = userMsgAt(msgs, 0);
		// No attachments → passes through as the plain string content.
		expect(u.content).toBe("plain text only");
	});

	test("fast path: no attachments anywhere → returns this.messages unchanged", () => {
		const { session } = buildSession({
			multimodal: true,
			steps: [
				{ seq: 0, turnGroup: 0, text: "first" },
				{ seq: 2, turnGroup: 2, text: "second" },
			],
		});
		const plain = session.getMessages();
		const mm = session.getMessagesMultimodal();
		expect(mm).toBe(plain); // identity — same array reference, no enrichment
	});
});

// ── AgentSession multimodal field wiring ─────────────────────────────────────

describe("AgentSession multimodal field (setter / getter parity)", () => {
	test("constructor accepts multimodal and getMultimodalCapability reads it", () => {
		const store = new MemStore();
		const s = new AgentSession("sys", 128000, "sess", store, true);
		expect(s.getMultimodalCapability()).toBe(true);
	});

	test("setMultimodal updates capability mid-session (model hot-sync path)", () => {
		const store = new MemStore();
		const s = new AgentSession("sys", 128000, "sess", store, false);
		expect(s.getMultimodalCapability()).toBe(false);
		s.setMultimodal(true);
		expect(s.getMultimodalCapability()).toBe(true);
	});

	test("setCurrentUserStepSeq / getCurrentUserStepSeq round-trip", () => {
		const store = new MemStore();
		const s = new AgentSession("sys", 128000, "sess", store, true);
		expect(s.getCurrentUserStepSeq()).toBe(-1);
		s.setCurrentUserStepSeq(42);
		expect(s.getCurrentUserStepSeq()).toBe(42);
	});
});
