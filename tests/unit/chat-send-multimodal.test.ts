// Unit tests: multimodal-input sub-4
//
// # File Spec
//
// ## Core
// Verifies the chat:send → run → live-persist → display-source wiring for
// multimodal input, without spinning up the full AgentService (heavy deps).
// Three contract surfaces are exercised in isolation:
//
//   1. InputQueueStore: a queued UserContent round-trips with its attachments
//      (drain returns the full UserContent, not just the text portion).
//   2. Live TurnStart persistence: registerTurnHooks + HookRegistry + MemStore
//      — driving TurnStart with `attachments` in the ctx writes them through
//      appendStep onto the user step row. This is the LIVE-path wiring sub-3
//      noted was missing (sub-3 only covered rebuild). Bytes never enter here
//      (principle A).
//   3. Display source: the persisted attachments surface on the data shape that
//      buildStepLevelMessages consumes (AgentSession.getCachedTurns(), which
//      feeds loop.getSessionTurns() → buildStepLevelMessages → ChatMessage).
//
// ## Non-goals
// Frontend UX (sub-5), modal display (sub-6), bytes rendering endpoint (sub-5).
// The buildStepLevelMessages function itself is private on AgentService (heavy
// ctor); these tests prove the DATA it reads carries attachments end-to-end
// (live write → cached turns → the field buildStepLevelMessages copies from).

import { describe, test, expect, beforeEach } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { deleteTurnSeq } from "../../src/runtime/hooks/turn-seq-tracker.js";
import { InputQueueStore } from "../../src/server/input-queue-store.js";
import { AgentSession } from "../../src/runtime/session.js";
import type { AttachmentMeta, UserContent } from "../../src/shared/types.js";
import type { ISessionStore, StepRow } from "../../src/runtime/session-store-interface.js";

// ── Minimal in-memory ISessionStore stub (reused shape from sub-3 test) ─────
// Only appendStep/getSteps are exercised here; the rest are no-ops so we can
// drive the TurnStart hook + AgentSession.getCachedTurns without a real DB.
// steps-overhaul sub-3: getMessages/saveTurn/replaceStepsFromMessages removed
// from ISessionStore (messages table redefined to summary+cursor).
class MemStore implements ISessionStore {
	steps: StepRow[] = [];
	getStepCount(): number { return this.steps.length; }
	getMainSession(): undefined { return undefined; }
	createSession(): any { throw new Error("not used"); }
	setMainSession(): void { /* no-op */ }
	listSessions(): any[] { return []; }
	listAllSessions(): any[] { return []; }
	deleteSession(): void { /* no-op */ }
	deleteTurn(): void { /* no-op */ }
	clearTurns(): void { this.steps = []; }
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

function imageAttachment(fileName: string): AttachmentMeta {
	return {
		id: fileName + "-id",
		kind: "image",
		fileName,
		mimeType: "image/png",
		size: 1024,
		diskPath: `/tmp/attachments/sess/${fileName}`,
	};
}

function pdfAttachment(fileName: string): AttachmentMeta {
	return {
		id: fileName + "-id",
		kind: "pdf",
		fileName,
		mimeType: "application/pdf",
		size: 2048,
		diskPath: `/tmp/attachments/sess/${fileName}`,
	};
}

// ── 1. InputQueueStore: UserContent round-trip on the queued path ──────────

describe("InputQueueStore — UserContent round-trip (sub-4 queued path)", () => {
	let q: InputQueueStore;

	beforeEach(() => {
		q = new InputQueueStore();
	});

	test("a queued UserContent drains back with its attachments intact", () => {
		const uc: UserContent = {
			text: "look at this",
			attachments: [imageAttachment("cat.png")],
		};
		q.enqueue("sess", uc, "queued");

		const drained = q.drainNextQueued("sess");
		// Drain returns the FULL UserContent (not just text) so loop.run can
		// thread attachments into TurnStart.
		expect(typeof drained).toBe("object");
		expect((drained as UserContent).text).toBe("look at this");
		expect((drained as UserContent).attachments).toHaveLength(1);
		expect((drained as UserContent).attachments[0].fileName).toBe("cat.png");
	});

	test("a bare string enqueue drains back as a bare string (back-compat)", () => {
		q.enqueue("sess", "hello", "queued");
		const drained = q.drainNextQueued("sess");
		expect(drained).toBe("hello");
	});

	test("insert_now enqueues keep string-only shape (sub-4 scope: insert_now is not multimodal)", () => {
		// Even if a UserContent is passed to insert_now, only its text is stored
		// (insert_now is mid-step injection; multimodal insert_now is out of scope).
		const uc: UserContent = { text: "mid-step", attachments: [pdfAttachment("d.pdf")] };
		q.enqueue("sess", uc, "insert_now");
		const list = q.list("sess");
		expect(list[0].content).toBe("mid-step");
		expect(list[0].userContent).toBeUndefined();
	});

	test("mixed enqueue + drain preserves FIFO order across string and UserContent items", () => {
		q.enqueue("sess", "first", "queued");
		q.enqueue("sess", { text: "second", attachments: [imageAttachment("a.png")] }, "queued");
		const d1 = q.drainNextQueued("sess");
		const d2 = q.drainNextQueued("sess");
		expect(d1).toBe("first");
		expect(typeof d2).toBe("object");
		expect((d2 as UserContent).attachments).toHaveLength(1);
	});
});

// ── 2. Live TurnStart: persist attachments via appendStep ──────────────────

describe("Live TurnStart hook — persists attachment META to turns (sub-4)", () => {
	let registry: HookRegistry;
	let store: MemStore;

	beforeEach(() => {
		// The turn-seq tracker is a module-level Map shared across the process
		// (turn-seq-tracker.ts). Clear the test session's marker so each test
		// starts as a fresh turn (otherwise TurnStart's hasTurnSeq guard skips
		// the write, since a prior test set it).
		deleteTurnSeq("sess");
		registry = new HookRegistry();
		store = new MemStore();
		registerTurnHooks(store, registry);
	});

	test("TurnStart with attachments → appendStep writes them onto the user step row", async () => {
		const atts = [imageAttachment("cat.png"), pdfAttachment("doc.pdf")];
		await registry.trigger("TurnStart", {
			sessionId: "sess",
			userMessage: "see these",
			attachments: atts,
			source: "user",
		});

		// The user step row is the one persisted by TurnStart.
		const userSteps = store.getSteps().filter(s => s.role === "user");
		expect(userSteps).toHaveLength(1);
		expect(userSteps[0].content).toBe("see these");
		// attachments carried through appendStep onto the row.
		expect(userSteps[0].attachments).toEqual(atts);
		expect(userSteps[0].attachments).toHaveLength(2);
	});

	test("TurnStart WITHOUT attachments (legacy string path) → user step row has undefined attachments (back-compat)", async () => {
		await registry.trigger("TurnStart", {
			sessionId: "sess",
			userMessage: "plain text",
			source: "background",
			// no `attachments` key
		});

		const userSteps = store.getSteps().filter(s => s.role === "user");
		expect(userSteps).toHaveLength(1);
		expect(userSteps[0].content).toBe("plain text");
		expect(userSteps[0].attachments).toBeUndefined();
	});

	test("TurnStart with empty attachments array → treated as no attachments (undefined on row)", async () => {
		// An empty array is the normalized form for a bare-string run() call.
		// The hook passes it through; appendStep stores it as-is. Either way no
		// spurious meta-info text is generated downstream (getMessagesMultimodal
		// treats length===0 the same as undefined).
		await registry.trigger("TurnStart", {
			sessionId: "sess",
			userMessage: "hi",
			attachments: [],
			source: "user",
		});
		const userSteps = store.getSteps().filter(s => s.role === "user");
		expect(userSteps).toHaveLength(1);
		// Empty array is acceptable; what matters is no attachment objects.
		const atts = userSteps[0].attachments;
		expect(atts === undefined || atts.length === 0).toBe(true);
	});

	test("TurnStart skipped on recovery (turn seq already set) does NOT overwrite the prior row", async () => {
		// First turn writes the user step.
		await registry.trigger("TurnStart", {
			sessionId: "sess", userMessage: "first", attachments: [imageAttachment("a.png")], source: "user",
		});
		// A second TurnStart for the same session before TurnEnd closes it is
		// treated as recovery (hasTurnSeq true) → skip. The first row is the
		// source of truth.
		await registry.trigger("TurnStart", {
			sessionId: "sess", userMessage: "second", attachments: [pdfAttachment("b.pdf")], source: "user",
		});
		const userSteps = store.getSteps().filter(s => s.role === "user");
		expect(userSteps).toHaveLength(1);
		expect(userSteps[0].content).toBe("first");
		expect(userSteps[0].attachments).toHaveLength(1);
		expect(userSteps[0].attachments![0].fileName).toBe("a.png");
	});
});

// ── 3. Display source: persisted attachments surface on getCachedTurns ─────
//
// buildStepLevelMessages is private on AgentService (heavy ctor), so this test
// exercises the DATA it reads: loop.getSessionTurns() returns
// AgentSession.getCachedTurns(), which refreshTurnsCache() rebuilds from
// store.getSteps(). After a live TurnStart wrote attachments, the cached turns
// (the display source) carry them — i.e. the field buildStepLevelMessages
// copies onto ChatMessage.attachments is populated.

describe("Display source — getCachedTurns carries attachments after live write (sub-4)", () => {
	let registry: HookRegistry;
	let store: MemStore;

	beforeEach(() => {
		deleteTurnSeq("sess");
		registry = new HookRegistry();
		store = new MemStore();
		registerTurnHooks(store, registry);
	});

	test("after TurnStart, AgentSession.getCachedTurns() exposes attachments on the user turn", async () => {
		const atts = [imageAttachment("cat.png")];
		await registry.trigger("TurnStart", {
			sessionId: "sess", userMessage: "see this", attachments: atts, source: "user",
		});

		// AgentSession is constructed against the same store the hook wrote to;
		// refreshTurnsCache is what loop.refreshTurnsCache()/getSessionTurns()
		// feed from. This is the exact data buildStepLevelMessages groups + reads.
		const session = new AgentSession("sys", 128000, "sess", store, true);
		session.refreshTurnsCache();
		const turns = session.getCachedTurns();

		const userTurn = turns.find(t => t.role === "user");
		expect(userTurn).toBeDefined();
		expect(userTurn!.attachments).toEqual(atts);
	});

	test("a user step WITHOUT attachments yields undefined attachments on the cached turn (no spurious render)", async () => {
		await registry.trigger("TurnStart", {
			sessionId: "sess", userMessage: "plain", source: "user",
		});
		const session = new AgentSession("sys", 128000, "sess", store, true);
		session.refreshTurnsCache();
		const userTurn = session.getCachedTurns().find(t => t.role === "user");
		expect(userTurn!.attachments).toBeUndefined();
	});
});
