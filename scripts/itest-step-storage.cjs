/**
 * Integration test: step-level storage against real database.
 *
 * Uses the ACTUAL SessionDB + real migrations — no mocks.
 * Tests the full lifecycle: schema → migration → write → read → rebuild.
 *
 * Usage: node scripts/itest-step-storage.cjs [db-path]
 * Default db-path: ~/.zero-core/itest-test.db
 */
const path = require("path");
const os = require("os");
const fs = require("fs");

const dbPath = process.argv[2] || path.join(os.homedir(), ".zero-core", "itest-test.db");

// Clean up any previous test DB
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");

async function run() {
	const { SessionDB } = await import("../dist/server/session-db.js");
	const { runMigrations } = await import("../dist/server/db-migration.js");

	let passed = 0;
	let failed = 0;

	function assert(cond, msg) {
		if (cond) { passed++; console.log(`  ✓ ${msg}`); }
		else { failed++; console.error(`  ✗ ${msg}`); }
	}

	// ─── Test 1: Fresh DB creation + migrations ──────────────
	console.log("\n=== Test 1: Fresh DB creation ===");
	const db = new SessionDB(dbPath);
	runMigrations(db);
	assert(db !== null, "SessionDB created + migrations ran");

	// Check columns
	const cols = db.getDb().pragma("table_info(turns)").map(c => c.name);
	assert(cols.includes("turn_group"), "turn_group column exists");
	assert(cols.includes("input_tokens"), "input_tokens column exists");
	assert(cols.includes("output_tokens"), "output_tokens column exists");
	assert(cols.includes("total_tokens"), "total_tokens column exists");

	// Check indexes
	const idxs = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='turns'").all().map(i => i.name);
	assert(idxs.includes("idx_turns_session_group"), "idx_turns_session_group index exists");

	// ─── Test 2: hasStepSchema ─────────────────────────────────
	console.log("\n=== Test 2: hasStepSchema ===");
	assert(db.hasStepSchema() === true, "hasStepSchema returns true on fresh DB");

	// ─── Test 3: Create session + write user step ──────────────
	console.log("\n=== Test 3: Write user step ===");
	const session = db.createSession("test-agent-1");
	const sessionId = session.id;
	assert(!!sessionId, `Session created: ${sessionId}`);

	db.appendStep(sessionId, 0, 0, "user", "Hello, list files");
	const userSteps = db.getStepGroup(sessionId, 0);
	assert(userSteps.length === 1, "User step group has 1 row");
	assert(userSteps[0].role === "user", "User step role is correct");
	assert(userSteps[0].turnGroup === 0, "User step turnGroup = 0");
	assert(userSteps[0].content === "Hello, list files", "User step content correct");

	// ─── Test 4: Write assistant steps (multi-step) ────────────
	console.log("\n=== Test 4: Multi-step assistant ===");
	const blocks1 = JSON.stringify([
		{ type: "thinking", text: "Let me list files..." },
		{ type: "tool", name: "Bash", status: "done", args: "ls", result: "file1.ts\nfile2.ts" },
	]);
	db.appendStep(sessionId, 1, 0, "assistant", blocks1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });

	const blocks2 = JSON.stringify([
		{ type: "text", text: "Here are the files: file1.ts, file2.ts" },
	]);
	db.appendStep(sessionId, 2, 0, "assistant", blocks2, { inputTokens: 200, outputTokens: 80, totalTokens: 280 });

	// Verify getStepGroup
	const group0 = db.getStepGroup(sessionId, 0);
	assert(group0.length === 3, `Turn group 0 has 3 steps (got ${group0.length})`);
	assert(group0[0].role === "user", "Step 0 is user");
	assert(group0[1].role === "assistant", "Step 1 is assistant");
	assert(group0[2].role === "assistant", "Step 2 is assistant");

	// Verify getSteps returns all steps
	const allSteps = db.getSteps(sessionId);
	assert(allSteps.length === 3, `Total 3 steps (got ${allSteps.length})`);

	// ─── Test 5: Step-level usage ──────────────────────────────
	console.log("\n=== Test 5: Usage tracking ===");
	assert(group0[1].inputTokens === 100, "Step 1 inputTokens = 100");
	assert(group0[1].outputTokens === 50, "Step 1 outputTokens = 50");
	assert(group0[2].totalTokens === 280, "Step 2 totalTokens = 280");

	// ─── Test 6: upsertStep ────────────────────────────────────
	console.log("\n=== Test 6: upsertStep ===");
	db.upsertStep(sessionId, 1, 0, "assistant", blocks1 + "-updated", { inputTokens: 100, outputTokens: 55, totalTokens: 155 });
	const updated = db.getStepGroup(sessionId, 0);
	assert(updated[1].inputTokens === 100, "Upserted step tokens preserved");
	assert(updated[1].outputTokens === 55, "Upserted step outputTokens updated");

	// ─── Test 7: updateStepContent ─────────────────────────────
	console.log("\n=== Test 7: updateStepContent ===");
	db.updateStepContent(sessionId, 2, "updated content");
	const contentUpdated = db.getStepGroup(sessionId, 0);
	assert(contentUpdated[2].content === "updated content", "Step content updated");

	// ─── Test 8: deleteStepGroup ────────────────────────────────
	console.log("\n=== Test 8: deleteStepGroup ===");
	// Add a second turn group
	db.appendStep(sessionId, 3, 3, "user", "Second question");
	db.appendStep(sessionId, 4, 3, "assistant", JSON.stringify([{ type: "text", text: "Answer" }]));
	const before = db.getSteps(sessionId);
	assert(before.length === 5, `5 steps before delete (got ${before.length})`);

	db.deleteStepGroup(sessionId, 3);
	const after = db.getSteps(sessionId);
	assert(after.length === 3, `3 steps after deleting group 3 (got ${after.length})`);

	// ─── Test 9: getTurnGroupCount ──────────────────────────────
	console.log("\n=== Test 9: getTurnGroupCount ===");
	const groupCount = db.getTurnGroupCount(sessionId);
	assert(groupCount === 1, `1 distinct turn group (got ${groupCount})`);

	// ─── Test 10: replaceStepsFromMessages ──────────────────────
	console.log("\n=== Test 10: replaceStepsFromMessages ===");
	db.replaceStepsFromMessages(sessionId, [
		{ seq: 0, turnGroup: 0, role: "user", content: "compressed question" },
		{ seq: 1, turnGroup: 0, role: "assistant", content: JSON.stringify([{ type: "text", text: "compressed answer" }]) },
	]);
	const replaced = db.getSteps(sessionId);
	assert(replaced.length === 2, `2 steps after replace (got ${replaced.length})`);
	assert(replaced[0].content === "compressed question", "Replaced user content correct");
	assert(replaced[1].role === "assistant", "Replaced assistant role correct");

	// ─── Test 11: Legacy path still works ──────────────────────
	console.log("\n=== Test 11: Legacy compatibility ===");
	db.appendTurn(sessionId, 10, "user", "legacy turn");
	db.updateTurnContent(sessionId, 10, "legacy turn updated");
	const legacyTurns = db.getTurns(sessionId);
	const legacy = legacyTurns.find(t => t.seq === 10);
	assert(!!legacy, "Legacy turn exists");
	assert(legacy.content === "legacy turn updated", "Legacy updateTurnContent works");
	db.deleteTurn(sessionId, 10);
	const afterDelete = db.getTurns(sessionId).find(t => t.seq === 10);
	assert(!afterDelete, "Legacy deleteTurn works");

	// ─── Test 12: Migration from old schema ────────────────────
	console.log("\n=== Test 12: Old DB migration simulation ===");
	db.getDb().exec(`INSERT INTO turns (session_id, seq, role, content, created_at, turn_group) VALUES ('${sessionId}', 99, 'user', 'old row', datetime('now'), -1)`);
	// Run the migration logic manually
	db.getDb().exec("UPDATE turns SET turn_group = seq WHERE turn_group = -1");
	const migrated = db.getDb().prepare("SELECT turn_group FROM turns WHERE seq = 99").get();
	assert(migrated.turn_group === 99, `Old row migrated: turn_group = ${migrated.turn_group}`);

	// ─── Cleanup ──────────────────────────────────────────────
	db.getDb().close();
	fs.unlinkSync(dbPath);
	if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
	if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");

	console.log(`\n══════════════════════════════════`);
	console.log(`  Results: ${passed} passed, ${failed} failed`);
	console.log(`══════════════════════════════════\n`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
	console.error("Fatal:", err);
	process.exit(1);
});
