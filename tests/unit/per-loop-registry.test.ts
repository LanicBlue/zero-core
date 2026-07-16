// Step 1B acceptance (A2): per-loop registry wiring isolation.
//
// Verifies that `registerHooksForLoop(registry, loopKind, deps)` registers the
// correct handler set per loop kind, on the registry the caller passes:
//   - main only:  registerInputQueueHooks / registerMetricsHooks are called
//                 (on the main registry).
//   - delegated only: registerTaskControlHooks is called (on the delegated
//                 registry).
//   - cross-kind negative: main registry does NOT get task-control; delegated
//                 registry does NOT get input-queue / metrics.
//
// sub-4 (subagent-recovery): notification-hooks was DELETED (workbench 收件箱
// replaces it). The main-only set is now input-queue + metrics. This test was
// updated to drop the notification-hooks spies/assertions.
//
// Approach: spy on the per-module register functions (they are the public
// registerHooksForLoop subcontract — each branch dispatches to exactly one set
// of these). This directly verifies the loopKind branch in registerHooksForLoop
// without needing real CoreDatabase / SessionManager / InputQueueStore stores,
// which would require an Electron-aware harness. The spies also capture the
// registry argument so we assert it is the per-loop instance, not the global
// singleton.
//
// Scope note (accept.md): this exercises the *per-loop path* — the explicit
// `(registry, loopKind, deps)` arguments — not the singleton-default path that
// the legacy register*Hooks signatures still accept for back-compat.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerHooksForLoop, type HookWiringDeps } from "../../src/runtime/hooks/index.js";

// The per-module register fns dispatched to by registerHooksForLoop. Importing
// them statically lets us spy on the same module object index.ts re-exports.
import * as InputQueueHooks from "../../src/runtime/hooks/input-queue-hooks.js";
import * as MetricsHooks from "../../src/server/metrics-hooks.js";
import * as TaskControlHooks from "../../src/runtime/hooks/task-control-hooks.js";

// Minimal fake stores — registerHooksForLoop only inspects presence, it does
// not run the loop. db must expose listDelegatedTasks so task-control registers.
function fakeDeps(): HookWiringDeps {
	const db: any = {
		listDelegatedTasks: () => [],
		updateDelegatedTask: () => {},
	};
	const inputQueue: any = { consumeInsertNow: () => [] };
	const sessionManager: any = {
		trackSessionStreaming: () => {},
		trackSessionIdle: () => {},
		trackSessionCreated: () => {},
		trackSessionActivated: () => {},
		recordTokenEstimate: () => {},
		trackSessionError: () => {},
	};
	const sessionDb: any = {};
	return { db, inputQueue, sessionManager, sessionDb };
}

describe("Step 1B · registerHooksForLoop per-loop isolation (A2)", () => {
	let spies: Array<ReturnType<typeof vi.spyOn>>;

	beforeEach(() => {
		// mockRestore any spies from the previous test, then re-attach fresh.
		// Fresh spies per test keep call counts isolated (vi.spyOn otherwise
		// accumulates across tests on the same module object).
		for (const s of spies ?? []) s.mockRestore();
		spies = [
			vi.spyOn(InputQueueHooks, "registerInputQueueHooks"),
			vi.spyOn(MetricsHooks, "registerMetricsHooks"),
			vi.spyOn(TaskControlHooks, "registerTaskControlHooks"),
		];
	});

	it("main loop: input-queue / metrics are registered on the MAIN registry; task-control is NOT", () => {
		const mainRegistry = new HookRegistry();
		const deps = fakeDeps();

		registerHooksForLoop(mainRegistry, "main", deps);

		// main-only registers fired (sub-4: notification-hooks deleted).
		expect(InputQueueHooks.registerInputQueueHooks).toHaveBeenCalledTimes(1);
		expect(MetricsHooks.registerMetricsHooks).toHaveBeenCalledTimes(1);

		// Each received the MAIN registry (not the singleton, not some other).
		expect(InputQueueHooks.registerInputQueueHooks).toHaveBeenCalledWith(expect.anything(), mainRegistry);
		expect(MetricsHooks.registerMetricsHooks).toHaveBeenCalledWith(expect.anything(), mainRegistry);

		// task-control must NOT have been registered for main.
		expect(TaskControlHooks.registerTaskControlHooks).not.toHaveBeenCalled();
	});

	it("delegated loop: task-control is registered on the DELEGATED registry; input-queue / metrics are NOT", () => {
		const delegatedRegistry = new HookRegistry();
		const deps = fakeDeps();

		registerHooksForLoop(delegatedRegistry, "delegated", deps);

		// delegated-only register fired, on the delegated registry.
		expect(TaskControlHooks.registerTaskControlHooks).toHaveBeenCalledTimes(1);
		expect(TaskControlHooks.registerTaskControlHooks).toHaveBeenCalledWith(expect.anything(), delegatedRegistry);

		// main-only registers must NOT have fired for delegated.
		expect(InputQueueHooks.registerInputQueueHooks).not.toHaveBeenCalled();
		expect(MetricsHooks.registerMetricsHooks).not.toHaveBeenCalled();
	});

	it("delegated without db: task-control is not dispatched (gated by db) and still no main-only leak", () => {
		const delegatedRegistry = new HookRegistry();
		// deps with no db → registerHooksForLoop does not even dispatch to
		// task-control (gated by `if (db)`). The key check is the negative:
		// no main-only hook leaks onto a delegated registry.
		const deps: HookWiringDeps = { inputQueue: undefined, sessionManager: undefined };

		registerHooksForLoop(delegatedRegistry, "delegated", deps);

		expect(TaskControlHooks.registerTaskControlHooks).not.toHaveBeenCalled();
		expect(InputQueueHooks.registerInputQueueHooks).not.toHaveBeenCalled();
		expect(MetricsHooks.registerMetricsHooks).not.toHaveBeenCalled();
	});

	it("two distinct registries: main set and delegated set land on separate instances", () => {
		const mainRegistry = new HookRegistry();
		const delegatedRegistry = new HookRegistry();
		const deps = fakeDeps();

		registerHooksForLoop(mainRegistry, "main", deps);
		registerHooksForLoop(delegatedRegistry, "delegated", deps);

		// Input-queue fired exactly once and received the MAIN registry.
		expect(InputQueueHooks.registerInputQueueHooks).toHaveBeenCalledTimes(1);
		expect(InputQueueHooks.registerInputQueueHooks).toHaveBeenCalledWith(expect.anything(), mainRegistry);

		// Task-control fired exactly once and received the DELEGATED registry.
		expect(TaskControlHooks.registerTaskControlHooks).toHaveBeenCalledTimes(1);
		expect(TaskControlHooks.registerTaskControlHooks).toHaveBeenCalledWith(expect.anything(), delegatedRegistry);

		// Cross-kind negative: main registry never received task-control;
		// delegated registry never received input-queue.
		const tcCallReg = TaskControlHooks.registerTaskControlHooks.mock.calls[0][1];
		const iqCallReg = InputQueueHooks.registerInputQueueHooks.mock.calls[0][1];
		expect(tcCallReg).toBe(delegatedRegistry);
		expect(tcCallReg).not.toBe(mainRegistry);
		expect(iqCallReg).toBe(mainRegistry);
		expect(iqCallReg).not.toBe(delegatedRegistry);
	});
});
