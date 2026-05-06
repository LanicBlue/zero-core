#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { main } from "@mariozechner/pi-coding-agent";
import extension from "./extension/index.js";

// ---------------------------------------------------------------------------
// zero-core independent directories
// ---------------------------------------------------------------------------

const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");
const ZERO_CORE_SESSION_DIR = process.env.ZERO_CORE_SESSION_DIR ?? join(ZERO_CORE_DIR, "sessions");

// Ensure directories exist
for (const dir of [ZERO_CORE_DIR, ZERO_CORE_SESSION_DIR]) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Pi agent dir env vars (must be set before importing Pi internals)
// ---------------------------------------------------------------------------

// PI_CODING_AGENT_DIR controls: models.json, settings.json, auth.json, etc.
if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = ZERO_CORE_DIR;
}

// PI_CODING_AGENT_SESSION_DIR controls session file storage
if (!process.env.PI_CODING_AGENT_SESSION_DIR) {
	process.env.PI_CODING_AGENT_SESSION_DIR = ZERO_CORE_SESSION_DIR;
}

// ---------------------------------------------------------------------------
// Bootstrap models.json if it doesn't exist
// ---------------------------------------------------------------------------

const modelsPath = join(ZERO_CORE_DIR, "models.json");
if (!existsSync(modelsPath)) {
	const { writeFileSync } = await import("node:fs");
	writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Launch Pi with zero-core extension
// ---------------------------------------------------------------------------

await main(process.argv.slice(2), {
	extensionFactories: [extension],
});
