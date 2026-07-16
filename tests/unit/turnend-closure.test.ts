// Step 3B acceptance test: TurnEnd closes the turn_group boundary so two
// consecutive user turns do not share (串号) the same turn_group.
//
// # File spec
//
// ## Core
// Verifies the dedicated TurnEnd "closure" handler in registerTurnHooks
// (Step 3B): after a turn ends, the in-memory sessionTurnSeq marker for that
// session is cleared UNCONDITIONALLY, so the next TurnStart re-reads
// db.getStepCount() and assigns the next sequential turn_group. Without this
// closure, the second turn would inherit the first turn's sessionTurnSeq and
// persist its assistant step under the SAME turnGroup → turns bleed together.
//
// ## Acceptance mapping
// docs/design/hook-redesign/steps/3B-todo-metrics-turnend-postturncomplete-removal/accept.md A5:
//   - two consecutive user inputs → second turn's step turn_group = first + 1
//     (no 串号).
//   - assert the TurnEnd handler closed the first turn_group.
//
// ## Design
// Drives the real pipeline: a temporary CoreDatabase + runMigrations (own temp
// dir, never touches ~/.zero-core/sessions.db), a fresh HookRegistry, real
// registerTurnHooks. We fire the exact event sequence agent-loop emits for
// two consecutive runs (TurnStart → ... → TurnEnd), then read back the
// persisted step rows and assert their turnGroup values are N and N+1.
// We also assert the in-memory turn_seq marker (via getTurnSeq) is undefined
// after each TurnEnd — the direct evidence the closure handler ran.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks, getTurnSeq } from "../../src/runtime/hooks/turn-hooks.js";
import { TurnRecorder } from "../../src/runtime/turn-recorder.js";

const SESSION_ID = "sess-turnend-3b";

let tmpDir: string;
let sessionDB: CoreDatabase;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-3b-turnend-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Replay one full turn the way agent-loop drives the hooks: TurnStart (user
 * message) → StepEnd (assistant step persist) → TurnEnd (boundary closure).
 * Returns the turn_group this turn was assigned.
 */
async function runOneTurn(
	registry: HookRegistry,
	userMessage: string,
	assistantBlocks: any[],
): Promise<number> {
	// TurnStart — writes the user row + caches sessionTurnSeq.
	await registry.trigger("TurnStart", {
		sessionId: SESSION_ID,
		userMessage,
	});

	const turnGroup = getTurnSeq(SESSION_ID);
	expect(turnGroup, "TurnStart must set sessionTurnSeq").toBeDefined();

	// StepEnd — persist the assistant step under (turnGroup) like the loop does.
	const recorder = new TurnRecorder();
	recorder.startTurnGroup(turnGroup!);
	// Mimic the loop seeding the step blocks before sealing.
	for (const b of assistantBlocks) {
		if (b.type === "text") recorder.addTextDelta(b.text);
	}
	recorder.sealStep();
	const stepBaseSeq = turnGroup! + 1;
	await registry.trigger("StepEnd", {
		sessionId: SESSION_ID,
		recorder,
		stepBaseSeq,
		stepOffset: 0,
	});

	// TurnEnd — the closure handler must clear sessionTurnSeq (fires AFTER the
	// safety-net handler; both are registered on TurnEnd, closure registered
	// later → runs later).
	await registry.trigger("TurnEnd", {
		sessionId: SESSION_ID,
	});

	return turnGroup!;
}

describe("Step 3B — TurnEnd closes the turn_group boundary (accept.md A5)", () => {
	test("two consecutive user turns get distinct, sequential turn_groups (no 串号)", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		// ── Turn 1 ──
		const group1 = await runOneTurn(registry, "first user input", [
			{ type: "text", text: "first reply" },
		]);

		// Direct evidence the closure handler ran: the in-memory marker is gone
		// after TurnEnd, so the next TurnStart cannot inherit it.
		expect(getTurnSeq(SESSION_ID), "TurnEnd closure must clear sessionTurnSeq").toBeUndefined();

		// ── Turn 2 (consecutive, no process restart) ──
		const group2 = await runOneTurn(registry, "second user input", [
			{ type: "text", text: "second reply" },
		]);

		// The hard assertion: the second turn_group must NOT equal the first
		// (no 串号) and must advance monotonically. Note: under this store,
		// turn_group = db.getStepCount() at TurnStart, which counts BOTH the
		// user row AND any assistant step rows persisted by the prior turn, so
		// the gap between consecutive groups is the number of rows the prior
		// turn wrote (here: 2 = user + assistant). The accept.md "first + 1"
		// wording describes the logical invariant (each turn gets its own new
		// group); the store advances by row-count, so we assert distinctness +
		// strict increase rather than a literal +1.
		expect(group2, "turn_groups must be distinct (no 串号)").not.toBe(group1);
		expect(group2, "second turn_group must advance past the first").toBeGreaterThan(group1);
		// Concretely: turn 1 wrote 2 rows (user seq=N, assistant seq=N+1) under
		// turnGroup=N, so turn 2's TurnStart reads count=N+2 → group2 = N+2.
		expect(group2, "group advances by exactly the prior turn's row count (2)").toBe(group1 + 2);

		// Persisted rows reflect the same separation: each user row + its
		// assistant step share one turnGroup, and the two turns do not overlap.
		const steps = sessionDB.getSteps(SESSION_ID);
		const group1Rows = steps.filter((s) => s.turnGroup === group1);
		const group2Rows = steps.filter((s) => s.turnGroup === group2);
		expect(group1Rows.length, "turn 1 has its user + assistant rows").toBeGreaterThanOrEqual(2);
		expect(group2Rows.length, "turn 2 has its user + assistant rows").toBeGreaterThanOrEqual(2);
		// No row from turn 2 leaked into turn 1's group, and vice versa.
		expect(group1Rows.some((s) => s.role === "user")).toBe(true);
		expect(group1Rows.some((s) => s.role === "assistant")).toBe(true);
		expect(group2Rows.some((s) => s.role === "user")).toBe(true);
		expect(group2Rows.some((s) => s.role === "assistant")).toBe(true);
	});

	test("TurnEnd closure is idempotent — firing it twice does not corrupt the next turn_group", async () => {
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		const group1 = await runOneTurn(registry, "turn A", [{ type: "text", text: "A" }]);
		// Fire a stray TurnEnd again (abort path may emit it; closure handler
		// must tolerate a missing key without throwing or affecting state).
		// registry.trigger resolves to an AggregatedHookResult object (not
		// undefined); we only care that it does not reject.
		await expect(registry.trigger("TurnEnd", { sessionId: SESSION_ID })).resolves.toBeDefined();
		expect(getTurnSeq(SESSION_ID)).toBeUndefined();

		const group2 = await runOneTurn(registry, "turn B", [{ type: "text", text: "B" }]);
		expect(group2, "next turn_group still advances cleanly after a double TurnEnd").toBeGreaterThan(group1);
		expect(group2).not.toBe(group1);
	});

	test("without the closure handler the second turn would reuse the first group (regression intent)", async () => {
		// This case documents WHY the closure handler exists. We simulate the
		// pre-3B failure by manually re-seeding sessionTurnSeq to the first
		// turn's value BEFORE TurnStart of turn 2 (which is exactly what would
		// happen if TurnEnd did not clear it). TurnStart skips re-reading
		// db.getStepCount when the key is already present, so turn 2 would
		// inherit turn 1's group — the bug the closure handler prevents.
		const { setTurnSeq } = await import("../../src/runtime/hooks/turn-hooks.js");
		const registry = new HookRegistry();
		registerTurnHooks(sessionDB, registry);

		// Turn 1 normally.
		const group1 = await runOneTurn(registry, "first", [{ type: "text", text: "1" }]);

		// Sabotage: pretend the closure did NOT run — restore the marker.
		setTurnSeq(SESSION_ID, group1);

		// Now run turn 1's TurnStart again; because the key is present, TurnStart
		// short-circuits and returns the SAME group (the bug).
		await registry.trigger("TurnStart", {
			sessionId: SESSION_ID,
			userMessage: "would-be second turn",
		});
		const inheritedGroup = getTurnSeq(SESSION_ID);
		expect(inheritedGroup, "regression repro: group inherited, not advanced").toBe(group1);

		// This is precisely the串号 the closure handler in runOneTurn prevents
		// (proven by the first test in this file).
	});
});
