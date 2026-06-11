const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");

const db = new Database(path.join(os.homedir(), ".zero-core/sessions.db"));
const architectSessionId = "7cdbc653-358c-4314-9a28-30f138bdab42";

const turns = db.prepare("SELECT seq, role, substr(content, 1, 300) as content_preview FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT 20").all(architectSessionId);
console.log("=== Architect turns (last 20) ===");
turns.forEach(t => console.log(`seq=${t.seq} role=${t.role} content=${t.content_preview}`));

// Check for tool call IDs
console.log("\n=== Looking for toolCallId patterns ===");
const allTurns = db.prepare("SELECT seq, role, content FROM turns WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 5").all(architectSessionId);
for (const t of allTurns) {
	try {
		const blocks = JSON.parse(t.content);
		for (const b of blocks) {
			if (b.type === "tool") {
				console.log(`seq=${t.seq} tool=${b.name} toolCallId=${b.toolCallId} status=${b.status}`);
			}
		}
	} catch {}
}

db.close();
