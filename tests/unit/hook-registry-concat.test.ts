// Unit tests for Step 1A: hook-registry instance isolation + array concat.
//
// Covers the four cases required by
// docs/design/hook-redesign/steps/1A-registry-infra/accept.md (A2):
//   1. concat            - array fields concatenate in registration order
//   2. scalar LWW        - scalar fields are last-writer-wins
//   3. blocked short-circuit - blocked:true stops, later handlers do not run
//   4. instance isolation - two instances do not share handlers
//
// Plus a transitional-compat check (A3): getInstance() + triggerHooks().

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry, triggerHooks } from "../../src/core/hook-registry.js";

describe("Step 1A · hook-registry concat / isolation", () => {
	// Each test gets its own fresh instance so handlers never leak between tests.
	let registry: HookRegistry;
	beforeEach(() => {
		registry = new HookRegistry();
	});

	it("case1 concat: array fields concatenate in registration order", async () => {
		registry.register("Notification", async () => ({
			appendMessages: [{ role: "user", content: "a" }],
		}));
		registry.register("Notification", async () => ({
			appendMessages: [{ role: "user", content: "b" }],
		}));

		const result = await registry.trigger("Notification", {});

		const msgs = result.appendMessages as Array<{ role: string; content: string }>;
		expect(Array.isArray(msgs)).toBe(true);
		expect(msgs.length).toBe(2);
		expect(msgs[0].content).toBe("a");
		expect(msgs[1].content).toBe("b");
	});

	it("case2 scalar LWW: scalar fields are last-writer-wins", async () => {
		registry.register("Notification", async () => ({ ragContext: "x" }));
		registry.register("Notification", async () => ({ ragContext: "y" }));

		const result = await registry.trigger("Notification", {});

		expect(result.ragContext).toBe("y");
	});

	it("case3 blocked short-circuit: blocked:true stops and skips later handlers", async () => {
		const h1 = vi.fn(async () => ({ blocked: true, reason: "no" }));
		const h2 = vi.fn(async () => ({ ragContext: "should-not-run" }));
		const h3 = vi.fn(async () => ({ appendMessages: [{ role: "user", content: "z" }] }));

		registry.register("Notification", h1);
		registry.register("Notification", h2);
		registry.register("Notification", h3);

		const result = await registry.trigger("Notification", {});

		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("no");
		expect(h1).toHaveBeenCalledTimes(1);
		expect(h2).not.toHaveBeenCalled();
		expect(h3).not.toHaveBeenCalled();
	});

	it("case4 instance isolation: two registries do not share handlers", async () => {
		const r1 = new HookRegistry();
		const r2 = new HookRegistry();
		const handlerA = vi.fn(async () => ({ ragContext: "A" }));
		const handlerB = vi.fn(async () => ({ ragContext: "B" }));

		r1.register("Notification", handlerA);
		r2.register("Notification", handlerB);

		const a = await r1.trigger("Notification", {});
		const b = await r2.trigger("Notification", {});

		expect(a.ragContext).toBe("A");
		expect(b.ragContext).toBe("B");
		expect(handlerA).toHaveBeenCalledTimes(1);
		expect(handlerB).toHaveBeenCalledTimes(1);
	});
});

describe("Step 1A · transitional compatibility (A3)", () => {
	it("getInstance() returns a usable instance", () => {
		const inst = HookRegistry.getInstance();
		expect(inst).toBeInstanceOf(HookRegistry);
	});

	it("triggerHooks() global still routes through the singleton", async () => {
		// Use the singleton directly so the test is self-contained; clean up after.
		const inst = HookRegistry.getInstance();
		inst.clear();
		const seen = vi.fn(async () => ({ ragContext: "global-hit" }));
		inst.register("Notification", seen);

		const result = await triggerHooks("Notification", { hello: "world" });

		expect(seen).toHaveBeenCalledTimes(1);
		expect(result.ragContext).toBe("global-hit");
		// triggerHooks() must auto-inject `timestamp` into the context the handler sees.
		const callCtx = seen.mock.calls[0][0] as { timestamp?: unknown };
		expect(typeof callCtx.timestamp).toBe("number");
		inst.clear();
	});
});
