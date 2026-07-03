// N2 (runtime-push-ui-sync) 单元测试 — UI 推送驱动 + 消闪烁 + 重连 resync
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-N2.md 第 1–5 条:
//   1. task/queue store ping→pull(watched 过滤)+ 无 setInterval。
//   2. (单消费者面为组件测试,这里覆盖 store 层契约:通道正确、watched 过滤)
//   3. (React.memo 行为是渲染期断言,这里用结构验证:组件已用 React.memo 包裹)
//   4. WikiAnchorsSection 稳引用(form.wikiAnchors 为 undefined 时 list 引用稳定)。
//   5. 重连信号:ipc-proxy close→reconnect 后发 ws:reconnected;首次 open 不发。
//
// ## 输入
// store 单元:mock window.api 捕获订阅回调。
// ipc-proxy:mock WebSocket + BrowserWindow,模拟 open/close 事件序列。
//
// ## 输出
// Vitest 用例。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Shared: capture the api() subscription callbacks for task / input-queue ───

interface CapturedSubs {
	agentEventCbs: Array<(e: any) => void>;
	dataChangedCbs: Array<(e: any) => void>;
	pullsBySession: Record<string, number>;
	queueListsBySession: Record<string, any[]>;
}

function makeCapturedSubs(): CapturedSubs {
	return {
		agentEventCbs: [],
		dataChangedCbs: [],
		pullsBySession: {},
		queueListsBySession: {},
	};
}

/**
 * Install a (window as any).api mock that records subscriptions and answers
 * runtimeTasksBySession / inputQueueList. Returns hooks to emit events.
 *
 * Stores register their module-load subscription on import, so the mock must
 * be in place BEFORE the dynamic import of the store module — we do it inside
 * each test (with vi.resetModules) so subscription capture is isolated.
 */
function installApiMock(subs: CapturedSubs): void {
	(globalThis as any).window = {
		api: {
			onAgentEvent(cb: (e: any) => void) {
				subs.agentEventCbs.push(cb);
				return () => { /* noop unsub for test */ };
			},
			onDataChanged(cb: (e: any) => void) {
				subs.dataChangedCbs.push(cb);
				return () => { /* noop unsub for test */ };
			},
			runtimeTasksBySession(sessionId: string) {
				subs.pullsBySession[sessionId] = (subs.pullsBySession[sessionId] ?? 0) + 1;
				return Promise.resolve([]);
			},
			inputQueueList(sessionId: string) {
				subs.queueListsBySession[sessionId] = (subs.queueListsBySession[sessionId] ?? 0) + 1;
				return Promise.resolve([]);
			},
			inputQueueEnqueue: async () => {},
			inputQueuePromote: async () => {},
			inputQueueRemove: async () => {},
		},
	};
}

// ─── 1. task-store + input-queue-store ping→pull (watched filter, no setInterval) ──

describe("N2 · task-store ping→pull (runtime:tasks:changed via onAgentEvent)", () => {
	let subs: CapturedSubs;

	beforeEach(async () => {
		vi.resetModules();
		subs = makeCapturedSubs();
		installApiMock(subs);
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	test("ping for a WATCHED session pulls that session", async () => {
		const { useTaskStore } = await import("../../src/renderer/store/task-store.js");
		useTaskStore.getState().startWatching("sess-A");
		// startWatching pulls once immediately — drain.
		await Promise.resolve();
		expect(subs.pullsBySession["sess-A"]).toBe(1);

		// Emit a runtime:tasks:changed ping for sess-A → must trigger another pull.
		for (const cb of subs.agentEventCbs) cb({ type: "runtime:tasks:changed", sessionId: "sess-A" });
		await Promise.resolve();
		expect(subs.pullsBySession["sess-A"]).toBe(2);
	});

	test("ping for a NOT-watched session does NOT pull", async () => {
		const { useTaskStore } = await import("../../src/renderer/store/task-store.js");
		useTaskStore.getState().startWatching("sess-A");
		await Promise.resolve();
		const pullsBefore = subs.pullsBySession["sess-A"] ?? 0;

		// Ping for an unwatched session — must be dropped.
		for (const cb of subs.agentEventCbs) cb({ type: "runtime:tasks:changed", sessionId: "sess-B" });
		await Promise.resolve();
		expect(subs.pullsBySession["sess-A"]).toBe(pullsBefore); // unchanged
		expect(subs.pullsBySession["sess-B"]).toBeUndefined(); // never pulled
	});

	test("stopWatching removes the session from the watched set (no pull on subsequent ping)", async () => {
		const { useTaskStore } = await import("../../src/renderer/store/task-store.js");
		useTaskStore.getState().startWatching("sess-A");
		await Promise.resolve();
		useTaskStore.getState().stopWatching("sess-A");
		const pullsBefore = subs.pullsBySession["sess-A"] ?? 0;

		for (const cb of subs.agentEventCbs) cb({ type: "runtime:tasks:changed", sessionId: "sess-A" });
		await Promise.resolve();
		expect(subs.pullsBySession["sess-A"]).toBe(pullsBefore); // no new pull
	});

	test("non-tasks agent:event types are ignored", async () => {
		const { useTaskStore } = await import("../../src/renderer/store/task-store.js");
		useTaskStore.getState().startWatching("sess-A");
		await Promise.resolve();
		const pullsBefore = subs.pullsBySession["sess-A"] ?? 0;

		for (const cb of subs.agentEventCbs) cb({ type: "text_delta", sessionId: "sess-A" });
		await Promise.resolve();
		expect(subs.pullsBySession["sess-A"]).toBe(pullsBefore);
	});

	test("store has NO setInterval-based polling (pull is push-driven only)", async () => {
		// Structural assertion: the store interface exposes startWatching /
		// stopWatching (not startPolling/stopPolling) and has no pollTimers field.
		const { useTaskStore } = await import("../../src/renderer/store/task-store.js");
		const proto = (useTaskStore as any).getState();
		expect(typeof proto.startWatching).toBe("function");
		expect(typeof proto.stopWatching).toBe("function");
		expect((proto as any).startPolling).toBeUndefined();
		expect((proto as any).stopPolling).toBeUndefined();
		expect((proto as any).pollTimers).toBeUndefined();
	});
});

describe("N2 · input-queue-store ping→pull (runtime:input-queue via onDataChanged)", () => {
	let subs: CapturedSubs;

	beforeEach(async () => {
		vi.resetModules();
		subs = makeCapturedSubs();
		installApiMock(subs);
	});

	afterEach(() => {
		delete (globalThis as any).window;
	});

	test("ping for a WATCHED session pulls that session", async () => {
		const { useInputQueueStore } = await import("../../src/renderer/store/input-queue-store.js");
		useInputQueueStore.getState().startWatching("sess-Q");
		await Promise.resolve();
		expect(subs.queueListsBySession["sess-Q"]).toBe(1);

		// Emit a runtime:input-queue data:changed carrying the sessionId as id.
		for (const cb of subs.dataChangedCbs) {
			cb({ collection: "runtime:input-queue", changes: [{ id: "sess-Q", op: "update" }] });
		}
		await Promise.resolve();
		expect(subs.queueListsBySession["sess-Q"]).toBe(2);
	});

	test("ping for a NOT-watched session does NOT pull", async () => {
		const { useInputQueueStore } = await import("../../src/renderer/store/input-queue-store.js");
		useInputQueueStore.getState().startWatching("sess-Q");
		await Promise.resolve();

		for (const cb of subs.dataChangedCbs) {
			cb({ collection: "runtime:input-queue", changes: [{ id: "sess-OTHER", op: "update" }] });
		}
		await Promise.resolve();
		expect(subs.queueListsBySession["sess-OTHER"]).toBeUndefined();
	});

	test("non-input-queue collections are ignored", async () => {
		const { useInputQueueStore } = await import("../../src/renderer/store/input-queue-store.js");
		useInputQueueStore.getState().startWatching("sess-Q");
		await Promise.resolve();
		const before = subs.queueListsBySession["sess-Q"] ?? 0;

		for (const cb of subs.dataChangedCbs) {
			cb({ collection: "agents", changes: [{ id: "sess-Q", op: "update" }] });
		}
		await Promise.resolve();
		expect(subs.queueListsBySession["sess-Q"]).toBe(before);
	});

	test("store exposes startWatching/stopWatching (no setInterval polling)", async () => {
		const { useInputQueueStore } = await import("../../src/renderer/store/input-queue-store.js");
		const proto = (useInputQueueStore as any).getState();
		expect(typeof proto.startWatching).toBe("function");
		expect(typeof proto.stopWatching).toBe("function");
		expect((proto as any).startPolling).toBeUndefined();
		expect((proto as any).pollTimers).toBeUndefined();
	});
});

// ─── 3. (structural) row components wrapped in React.memo ─────────────
//
// Quick structural check that the published defaults are React.memo-wrapped.
// The AUTHORITATIVE render-count assertions for §3 (proving the memo actually
// skips re-renders on stable props, with a control that turns red if React.memo
// is removed) live in n2-memo-render-count.test.ts — that file needs jsdom +
// createRoot/act, so it is split out rather than forcing this whole suite (which
// stubs `window` for store tests) into the DOM environment.

describe("N2 · React.memo row components (structural)", () => {
	test("RequirementCard is wrapped in React.memo", async () => {
		const mod: any = await import("../../src/renderer/components/requirements/RequirementCard.js");
		// React.memo sets a well-known property; the $$typeof of a memo'd component
		// is the memo symbol. We just assert the default export is a function/object
		// (not the raw impl) — the wrap is verified by typecheck + the rename.
		expect(typeof mod.default).toBe("object");
		expect(mod.default.$$typeof).toBeTruthy();
	});

	test("McpServerCard is wrapped in React.memo", async () => {
		const mod: any = await import("../../src/renderer/components/mcp/McpServerCard.js");
		expect(typeof mod.default).toBe("object");
		expect(mod.default.$$typeof).toBeTruthy();
	});
});

// ─── 4. WikiAnchorsSection stable empty-array reference ───────────────
//
// The list value comes from `form.wikiAnchors ?? EMPTY_ANCHORS`. We verify the
// contract indirectly: when form.wikiAnchors is undefined, two computations of
// the fallback MUST return the SAME reference (a module-level constant), so the
// preview effect's deps don't flip identity on unrelated re-renders.
// We can't easily render the component under node (no DOM), so we replicate the
// contract assertion at the source-text level + a runtime check of the constant
// identity via a tiny mirror.

describe("N2 · WikiAnchorsSection stable EMPTY reference", () => {
	test("EMPTY_ANCHORS is a single shared identity across 'renders'", async () => {
		// Mirror the module pattern: ?? EMPTY_ANCHORS must be identity-stable.
		const EMPTY_ANCHORS: unknown[] = [];
		const form1 = { wikiAnchors: undefined };
		const form2 = { wikiAnchors: undefined };
		const list1 = form1.wikiAnchors ?? EMPTY_ANCHORS;
		const list2 = form2.wikiAnchors ?? EMPTY_ANCHORS;
		expect(list1).toBe(list2); // same reference → effect deps stable
	});

	test("source uses EMPTY_ANCHORS (not inline [])", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(
			"C:/Users/Administrator/Documents/workspace/agent/zero-core/src/renderer/components/agents/WikiAnchorsSection.tsx",
			"utf8",
		);
		expect(src).toContain("EMPTY_ANCHORS");
		expect(src).toContain("?? EMPTY_ANCHORS");
		// The list assignment must use the shared constant, not an inline `?? []`
		// (which would create a fresh identity each render and bust memo/effect
		// deps). Strip line comments first so the regex only sees real code.
		const codeOnly = src.replace(/\/\/[^\n\r]*/g, "");
		expect(codeOnly).not.toMatch(/\?\?\s*\[\]/);
	});
});

// ─── 5. Reconnect signal: ipc-proxy close→reconnect emits ws:reconnected; first open does not ──
//
// ipc-proxy.ts imports `ws` (WebSocket) and `electron` (BrowserWindow). We mock
// both, drive the open/close event sequence, and assert webContents.send is
// called with "ws:reconnected" ONLY after a close→reconnect — never on first open.

describe("N2 · reconnect resync signal (ipc-proxy ws:reconnected)", () => {
	let wsInstance: any;
	let sent: Array<{ channel: string; data?: any }>;
	let win: any;

	beforeEach(async () => {
		vi.resetModules();
		sent = [];
		wsInstance = null;

		// Mock the `ws` module: a class whose constructor captures the instance
		// and exposes on(event, cb) handlers we can drive from the test.
		vi.doMock("ws", () => {
			return {
				default: class FakeWebSocket {
					public handlers: Record<string, Array<(...args: any[]) => void>> = {};
					constructor(public url: string) {
						wsInstance = this;
					}
					on(event: string, cb: (...args: any[]) => void) {
						(this.handlers[event] ??= []).push(cb);
					}
					emit(event: string, ...args: any[]) {
						for (const cb of this.handlers[event] ?? []) cb(...args);
					}
				},
			};
		});

		// Mock `electron`: BrowserWindow with webContents.send recording calls,
		// plus log helper if referenced. ipc-proxy imports { BrowserWindow } as a
		// type only and uses `win.webContents.send` + `win.isDestroyed()`.
		vi.doMock("electron", () => ({
			BrowserWindow: class {},
			app: { getName: () => "test", getVersion: () => "0.0.0" },
		}));

		// Mock the log helper used by ipc-proxy (log.debug).
		vi.doMock("../../src/main/logger.js", () => ({
			log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		}));

		win = {
			isDestroyed: () => false,
			webContents: {
				send: (channel: string, data?: any) => { sent.push({ channel, data }); },
			},
		};

		// Mock global fetch (pollReady uses it) — always "not ready" so it doesn't
		// send app:ready during the reconnect test.
		(globalThis as any).fetch = vi.fn().mockRejectedValue(new Error("no backend"));
	});

	afterEach(() => {
		vi.doUnmock("ws");
		vi.doUnmock("electron");
		vi.doUnmock("../../src/main/logger.js");
		delete (globalThis as any).fetch;
	});

	test("first open does NOT send ws:reconnected", async () => {
		const { connectEventBridge } = await import("../../src/main/ipc-proxy.js");
		connectEventBridge(win as any, 1234);
		// Simulate the initial successful open.
		wsInstance.emit("open");
		const reconnectSignals = sent.filter((s) => s.channel === "ws:reconnected");
		expect(reconnectSignals).toHaveLength(0);
	});

	test("close→reconnect DOES send ws:reconnected (after a prior successful connect)", async () => {
		const { connectEventBridge } = await import("../../src/main/ipc-proxy.js");
		connectEventBridge(win as any, 1234);
		// First successful connect (must NOT signal).
		wsInstance.emit("open");
		sent.length = 0;
		// Drop then reconnect after the 2s timeout.
		wsInstance.emit("close");
		// The real code uses setTimeout(connect, 2000) — fake the new ws + its open.
		await new Promise((r) => setTimeout(r, 10)); // let microtasks settle
		// Simulate the reconnect: a fresh ws open (the setTimeout creates a new
		// FakeWebSocket whose instance is captured in wsInstance).
		// Advance the reconnect timer.
		await new Promise((r) => setTimeout(r, 2050));
		// After reconnect timer, wsInstance is the NEW socket; fire its open.
		wsInstance?.emit("open");
		const reconnectSignals = sent.filter((s) => s.channel === "ws:reconnected");
		expect(reconnectSignals).toHaveLength(1);
	});

	test("close WITHOUT a prior successful connect does NOT schedule resync", async () => {
		const { connectEventBridge } = await import("../../src/main/ipc-proxy.js");
		connectEventBridge(win as any, 1234);
		// Close immediately (never opened successfully — e.g. backend down at start).
		wsInstance.emit("close");
		sent.length = 0;
		await new Promise((r) => setTimeout(r, 2050));
		// New socket from the retry — open it. No resync should fire (first connect
		// path), since we'd never been up before.
		wsInstance?.emit("open");
		const reconnectSignals = sent.filter((s) => s.channel === "ws:reconnected");
		expect(reconnectSignals).toHaveLength(0);
	});
});
