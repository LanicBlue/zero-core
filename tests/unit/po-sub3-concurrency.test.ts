// platform-observability sub-3 acceptance test: concurrency observation + priority.
//
// # File Spec
//
// ## Core
// Adversarial verification of docs/plan/platform-observability/acceptance-3.md
// (8 cases). Independent from the implementer — asserts the behavior of the real
// ConcurrencyQueue (tier dequeue / FIFO / abort / setMax wake), the ALS context
// (runInConcurrencyContext / getConcurrencyContext), and turnSourceToTier, not
// the implementer's claims.
//
// ## Acceptance cases (acceptance-3.md)
//   Queue observation:
//     1. waiter identity — acquire {sessionId,agentId,tier} → waiter carries;
//        getWaiting returns entries with these + waitedSince
//     2. getWaiting accuracy — pending → list reflects; release one → list shrinks
//     3. abort correctness — pending abort → waiter removed, getWaiting excludes
//   Priority scheduling:
//     4. ALS passes tier — runInConcurrencyContext sets it; getConcurrencyContext
//        reads it (proxy for agent-loop.run → provider-factory acquire)
//     5. tier dequeue (preemption) — P3 queued first, P1 arrives later → release
//        wakes P1 first
//     6. same-tier FIFO — two P2 waiters, earlier waitedSince wins
//     7. strict order — P1>P2>P3; while a higher tier waits, lower never leaves
//     8. regression — non-saturated acquire returns immediately; setMax wake
//        respects tier; concurrency stress doesn't deadlock or leak releases
//
// ## Determinism
// Same-tier FIFO tests deliberately separate `waitedSince` by yielding to the
// event loop between acquisitions, so two P2 waiters never share a ms.
//
// ## Constraints
// English test bodies; no production sessions.db touched (pure unit test).

import { describe, test, expect } from "vitest";

import { ConcurrencyQueue } from "../../src/runtime/concurrency-queue.js";
import {
	concurrencyContext,
	getConcurrencyContext,
	runInConcurrencyContext,
	turnSourceToTier,
	TIER_P1,
	TIER_P2,
	TIER_P3,
} from "../../src/runtime/concurrency-context.js";
import type { TurnSource } from "../../src/runtime/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Yield to the microtask + macrotask queue so Date.now() advances across calls. */
async function tick(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((r) => setImmediate(r));
}

/**
 * Acquire and DON'T release — returns the promise so the caller can await it
 * later (it stays pending while the slot is held). Used to fill the queue.
 */
function hold(q: ConcurrencyQueue): Promise<void> {
	return q.acquire();
}

// ---------------------------------------------------------------------------
// Case 1 — waiter identity
// ---------------------------------------------------------------------------

describe("acceptance-3 / 1 — waiter identity", () => {
	test("acquire {sessionId,agentId,tier} → getWaiting carries identity + waitedSince", async () => {
		const q = new ConcurrencyQueue(1);
		// Fill the single slot so the next acquire queues.
		await q.acquire();

		// This one blocks → goes to the waiter list.
		const pending = q.acquire({
			sessionId: "sess-A",
			agentId: "agent-X",
			tier: TIER_P2,
		});
		// Don't await; let it register.
		await tick();

		const waiting = q.getWaiting();
		expect(waiting.length).toBe(1);
		expect(waiting[0].sessionId).toBe("sess-A");
		expect(waiting[0].agentId).toBe("agent-X");
		expect(waiting[0].tier).toBe(TIER_P2);
		expect(typeof waiting[0].waitedSince).toBe("number");
		expect(waiting[0].waitedSince).toBeGreaterThan(0);

		// Cleanup: release twice to drain (slot holder + the waiter resolves + clears).
		q.release();
		await pending;
		q.release();
	});

	test("getWaiting omits internal resolve/reject/abortHandler (no callback leak)", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		const pending = q.acquire({ sessionId: "s", agentId: "a", tier: TIER_P1 });
		await tick();

		const entry: any = q.getWaiting()[0];
		expect(entry.resolve).toBeUndefined();
		expect(entry.reject).toBeUndefined();
		expect(entry.abortHandler).toBeUndefined();

		q.release();
		await pending;
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 2 — getWaiting accuracy
// ---------------------------------------------------------------------------

describe("acceptance-3 / 2 — getWaiting accuracy", () => {
	test("three queued → getWaiting lists all three; release one → list shrinks by one", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // hold the slot

		const a = q.acquire({ sessionId: "s1", agentId: "a", tier: TIER_P3 });
		const b = q.acquire({ sessionId: "s2", agentId: "a", tier: TIER_P3 });
		const c = q.acquire({ sessionId: "s3", agentId: "a", tier: TIER_P3 });
		await tick();

		expect(q.getWaiting().length).toBe(3);

		q.release(); // wakes one (FIFO among same-tier → s1)
		await a;
		await tick();

		expect(q.getWaiting().length).toBe(2);
		expect(q.getWaiting().map((w) => w.sessionId)).toEqual(["s2", "s3"]);

		q.release();
		await b;
		q.release();
		await c;
		q.release();
	});

	test("getWaitingCount stays in sync with getWaiting length", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		q.acquire({ sessionId: "x", tier: TIER_P3 });
		await tick();
		expect(q.getWaitingCount()).toBe(q.getWaiting().length);
		q.release();
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 3 — abort correctness
// ---------------------------------------------------------------------------

describe("acceptance-3 / 3 — abort correctness", () => {
	test("abort while pending → waiter removed from getWaiting; AbortError thrown", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // hold slot

		const ac = new AbortController();
		const pending = q.acquire({
			signal: ac.signal,
			sessionId: "s",
			tier: TIER_P2,
		});
		await tick();
		expect(q.getWaiting().length).toBe(1);

		ac.abort();

		await expect(pending).rejects.toThrow(); // AbortError
		expect(q.getWaiting().length).toBe(0);
	});

	test("abort of a waiting waiter does NOT touch active count", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // active=1
		expect(q.getActiveCount()).toBe(1);

		const ac = new AbortController();
		const pending = q.acquire({ signal: ac.signal, tier: TIER_P2 });
		await tick();
		// active is still 1 (the waiter hasn't been woken).
		expect(q.getActiveCount()).toBe(1);

		ac.abort();
		await expect(pending).rejects.toThrow();
		// active unchanged — abort must not release a slot it never held.
		expect(q.getActiveCount()).toBe(1);

		q.release();
		expect(q.getActiveCount()).toBe(0);
	});

	test("pre-aborted signal → acquire rejects immediately, never enters queue", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		const ac = new AbortController();
		ac.abort();
		await expect(q.acquire({ signal: ac.signal, tier: TIER_P1 })).rejects.toThrow();
		expect(q.getWaiting().length).toBe(0);
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 4 — ALS passes tier (agent-loop.run → provider-factory proxy)
// ---------------------------------------------------------------------------

describe("acceptance-3 / 4 — ALS passes tier", () => {
	test("runInConcurrencyContext sets; getConcurrencyContext reads (proxy for run → acquire)", async () => {
		const outer = getConcurrencyContext();
		expect(outer).toBeUndefined();

		const result = await runInConcurrencyContext(
			{ sessionId: "s1", agentId: "a1", tier: TIER_P1 },
			async () => {
				// Simulate provider-factory.acquire reading the ALS.
				const ctx = getConcurrencyContext();
				expect(ctx).toBeDefined();
				expect(ctx!.sessionId).toBe("s1");
				expect(ctx!.agentId).toBe("a1");
				expect(ctx!.tier).toBe(TIER_P1);
				return "ok";
			},
		);
		expect(result).toBe("ok");

		// After run, ALS is restored.
		expect(getConcurrencyContext()).toBeUndefined();
	});

	test("ALS propagates across await boundary (streamText → acquire chain)", async () => {
		await runInConcurrencyContext({ tier: TIER_P2 }, async () => {
			await Promise.resolve(); // microtask
			await new Promise<void>((r) => setImmediate(r)); // macrotask
			expect(getConcurrencyContext()?.tier).toBe(TIER_P2);
		});
	});

	test("nested runInConcurrencyContext overrides for the inner scope", async () => {
		await runInConcurrencyContext({ tier: TIER_P3 }, async () => {
			expect(getConcurrencyContext()?.tier).toBe(TIER_P3);
			await runInConcurrencyContext({ tier: TIER_P1 }, async () => {
				expect(getConcurrencyContext()?.tier).toBe(TIER_P1);
			});
			expect(getConcurrencyContext()?.tier).toBe(TIER_P3);
		});
	});

	test("concurrencyContext is the AsyncLocalStorage instance (public API surface)", () => {
		// Implementation must expose it; agent-loop imports runInConcurrencyContext,
		// provider-factory imports getConcurrencyContext. Both go through this store.
		expect(concurrencyContext).toBeDefined();
		expect(typeof concurrencyContext.run).toBe("function");
		expect(typeof concurrencyContext.getStore).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// turnSourceToTier mapping (needed for case 4 — agent-loop.run sets source)
// ---------------------------------------------------------------------------

describe("turnSourceToTier mapping", () => {
	const cases: Array<[TurnSource | undefined, number]> = [
		["user", TIER_P1],
		["work", TIER_P2],
		["cron", TIER_P2],
		["background", TIER_P3],
		[undefined, TIER_P3],
	];
	for (const [src, expected] of cases) {
		test(`${JSON.stringify(src)} → tier ${expected}`, () => {
			expect(turnSourceToTier(src)).toBe(expected);
		});
	}
	test("lower tier number = higher priority (P1<P2<P3)", () => {
		expect(TIER_P1).toBeLessThan(TIER_P2);
		expect(TIER_P2).toBeLessThan(TIER_P3);
	});
});

// ---------------------------------------------------------------------------
// Case 5 — tier dequeue (preemption)
// ---------------------------------------------------------------------------

describe("acceptance-3 / 5 — tier dequeue (preemption)", () => {
	test("P3 queued first, P1 arrives later → release wakes P1 first", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // hold slot

		const p3 = q.acquire({ sessionId: "p3", tier: TIER_P3 });
		await tick(); // P3 has been waiting a while

		const p1 = q.acquire({ sessionId: "p1", tier: TIER_P1 });
		await tick(); // P1 arrived later

		// Release the slot → P1 must win despite arriving later.
		q.release();
		await p1; // P1 resolves
		expect(q.getActiveCount()).toBe(1);

		// P3 still queued.
		expect(q.getWaiting().map((w) => w.sessionId)).toEqual(["p3"]);

		q.release();
		await p3;
		q.release();
	});

	test("P2 queued first, P1 later → P1 wins", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		const p2 = q.acquire({ sessionId: "p2", tier: TIER_P2 });
		await tick();
		const p1 = q.acquire({ sessionId: "p1", tier: TIER_P1 });
		await tick();

		q.release();
		await p1;
		q.release();
		await p2;
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 6 — same-tier FIFO
// ---------------------------------------------------------------------------

describe("acceptance-3 / 6 — same-tier FIFO", () => {
	test("two P2 waiters → earlier waitedSince resolves first", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();

		const first = q.acquire({ sessionId: "first", tier: TIER_P2 });
		await tick(); // ensure distinct waitedSince
		const second = q.acquire({ sessionId: "second", tier: TIER_P2 });
		await tick();

		const resolved: string[] = [];
		first.then(() => resolved.push("first"));
		second.then(() => resolved.push("second"));

		q.release();
		await tick();

		// Exactly one resolved, and it's the first one (FIFO).
		expect(resolved).toEqual(["first"]);

		q.release();
		await tick();
		expect(resolved).toEqual(["first", "second"]);

		q.release();
	});

	test("getWaiting ordering: tier asc then waitedSince asc", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		q.acquire({ sessionId: "p3-early", tier: TIER_P3 });
		await tick();
		q.acquire({ sessionId: "p1-late", tier: TIER_P1 });
		await tick();
		q.acquire({ sessionId: "p3-late", tier: TIER_P3 });
		await tick();

		const order = q.getWaiting().map((w) => w.sessionId);
		// P1 first regardless of arrival; then P3s in arrival order.
		expect(order).toEqual(["p1-late", "p3-early", "p3-late"]);

		// drain
		q.release(); q.release(); q.release();
		await tick();
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 7 — strict priority (P1>P2>P3); P3 starves while higher waits
// ---------------------------------------------------------------------------

describe("acceptance-3 / 7 — strict priority", () => {
	test("release order across three tiers: P1, then P2, then P3", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		const p3 = q.acquire({ sessionId: "p3", tier: TIER_P3 });
		await tick();
		const p2 = q.acquire({ sessionId: "p2", tier: TIER_P2 });
		await tick();
		const p1 = q.acquire({ sessionId: "p1", tier: TIER_P1 });
		await tick();

		const order: string[] = [];
		p1.then(() => order.push("p1"));
		p2.then(() => order.push("p2"));
		p3.then(() => order.push("p3"));

		q.release();
		await tick();
		expect(order).toEqual(["p1"]);

		q.release();
		await tick();
		expect(order).toEqual(["p1", "p2"]);

		q.release();
		await tick();
		expect(order).toEqual(["p1", "p2", "p3"]);

		q.release();
	});

	test("P3 starvation: while P1 keeps arriving, P3 never wakes", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // initial holder

		const p3 = q.acquire({ sessionId: "starved-p3", tier: TIER_P3 });
		await tick();

		// A P1 arrives after P3 — P1 should preempt on the next release.
		const p1a = q.acquire({ sessionId: "p1-a", tier: TIER_P1 });
		await tick();

		q.release(); // wakes p1-a
		await p1a;

		// Immediately another P1 turns up before we free the slot again.
		const p1b = q.acquire({ sessionId: "p1-b", tier: TIER_P1 });
		await tick();

		q.release(); // wakes p1-b, NOT the still-waiting P3
		await p1b;

		// P3 is still waiting (starved).
		expect(q.getWaiting().map((w) => w.sessionId)).toEqual(["starved-p3"]);

		q.release();
		await p3;
		q.release();
	});
});

// ---------------------------------------------------------------------------
// Case 8 — regression + setMax wake priority + stress
// ---------------------------------------------------------------------------

describe("acceptance-3 / 8 — regression, setMax wake, stress", () => {
	test("non-saturated acquire resolves immediately (same as old behavior)", async () => {
		const q = new ConcurrencyQueue(3);
		// Two of three slots free → acquire must NOT queue.
		const a = q.acquire();
		const b = q.acquire();
		// Synchronous resolution: Promise.resolve() settles before await.
		await a;
		await b;
		expect(q.getActiveCount()).toBe(2);
		expect(q.getWaitingCount()).toBe(0);

		q.release();
		q.release();
		expect(q.getActiveCount()).toBe(0);
	});

	test("acquire with bare AbortSignal (legacy signature) still works → queues, releases", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire();
		// Legacy call shape: pass AbortSignal directly.
		const ac = new AbortController();
		const pending = q.acquire(ac.signal);
		await tick();
		expect(q.getWaiting().length).toBe(1);
		// Default tier applied (P3).
		expect(q.getWaiting()[0].tier).toBe(TIER_P3);

		q.release();
		await pending;
		q.release();
	});

	test("setMax raising cap wakes waiters by tier priority (NOT FIFO)", async () => {
		const q = new ConcurrencyQueue(1);
		await q.acquire(); // hold the original slot

		// Queue P3 first, then P2, then P1. If setMax used FIFO, P3 would wake first.
		const p3 = q.acquire({ sessionId: "p3", tier: TIER_P3 });
		await tick();
		const p2 = q.acquire({ sessionId: "p2", tier: TIER_P2 });
		await tick();
		const p1 = q.acquire({ sessionId: "p1", tier: TIER_P1 });
		await tick();

		const order: string[] = [];
		p1.then(() => order.push("p1"));
		p2.then(() => order.push("p2"));
		p3.then(() => order.push("p3"));

		// Raise cap from 1 → 3. Two new slots open → must wake P1 then P2 (tier order),
		// NOT P3 then P2 (FIFO).
		q.setMax(3);
		await tick();

		expect(order).toEqual(["p1", "p2"]);
		// P3 still queued.
		expect(q.getWaiting().map((w) => w.sessionId)).toEqual(["p3"]);

		// drain: original holder still active. Two wakes brought active to 3 (1+2).
		expect(q.getActiveCount()).toBe(3);

		q.release(); // wakes P3
		await tick();
		expect(order).toEqual(["p1", "p2", "p3"]);

		q.release();
		q.release();
		q.release();
	});

	test("setMax to a lower cap does NOT preempt active waiters", async () => {
		const q = new ConcurrencyQueue(3);
		await q.acquire();
		await q.acquire();
		await q.acquire();
		expect(q.getActiveCount()).toBe(3);

		// Lower cap — should not crash, not wake anything, not over-release.
		q.setMax(1);
		expect(q.getActiveCount()).toBe(3); // active unchanged until released
		q.release();
		expect(q.getActiveCount()).toBe(2);
		// No wake happens since cap (1) < active (2).
		expect(q.getWaitingCount()).toBe(0);
		q.release();
		q.release();
	});

	test("stress: many acquisitions across tiers, all resolve exactly once, no deadlock", async () => {
		const q = new ConcurrencyQueue(2);
		let acquired = 0;
		let released = 0;
		const N = 50;
		const tiers = [TIER_P1, TIER_P2, TIER_P3];

		const tasks = Array.from({ length: N }, (_, i) =>
			(async () => {
				await q.acquire({
					sessionId: `s${i}`,
					agentId: `a${i % 3}`,
					tier: tiers[i % 3],
				});
				acquired++;
				// Simulate work, then release.
				await tick();
				released++;
				q.release();
			})(),
		);

		await Promise.all(tasks);

		expect(acquired).toBe(N);
		expect(released).toBe(N);
		expect(q.getActiveCount()).toBe(0);
		expect(q.getWaitingCount()).toBe(0);
	});

	test("stress with aborts: aborted waiters don't get a slot, no double-release", async () => {
		const q = new ConcurrencyQueue(1);
		let acquired = 0;
		const completed: number[] = [];

		// Hold the slot to force queuing, then free it gradually.
		const holder = q.acquire();

		const tasks = Array.from({ length: 20 }, (_, i) => {
			const ac = new AbortController();
			// Abort ~half of them while queued.
			if (i % 2 === 0) {
				setImmediate(() => ac.abort());
			}
			return (async () => {
				try {
					await q.acquire({ signal: ac.signal, sessionId: `s${i}`, tier: TIER_P1 });
					acquired++;
					completed.push(i);
					await tick();
					q.release();
				} catch {
					// aborted — must not have acquired.
				}
			})();
		});

		// Free the holder so the queue can drain.
		setImmediate(() => q.release());
		await Promise.all(tasks);

		// Every acquired slot was released (no leak), and no aborted task appears as completed.
		expect(q.getActiveCount()).toBe(0);
		for (const i of completed) {
			expect(i % 2).toBe(1); // only the non-aborted (odd) indices complete
		}
		void holder;
	});
});
