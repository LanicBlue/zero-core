#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { main } from "@mariozechner/pi-coding-agent";
import extension from "./extension/index.js";
import { DEFAULT_CONFIG, getGlobalConfigPath, ZERO_CORE_DIR as CORE_DIR } from "./core/config.js";

// ---------------------------------------------------------------------------
// zero-core independent directories
// ---------------------------------------------------------------------------

const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? CORE_DIR;
const ZERO_CORE_SESSION_DIR = process.env.ZERO_CORE_SESSION_DIR ?? join(ZERO_CORE_DIR, "sessions");

// Ensure directories exist
for (const dir of [ZERO_CORE_DIR, ZERO_CORE_SESSION_DIR]) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Pi agent dir env vars (must be set before importing Pi internals)
// ---------------------------------------------------------------------------

if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = ZERO_CORE_DIR;
}

if (!process.env.PI_CODING_AGENT_SESSION_DIR) {
	process.env.PI_CODING_AGENT_SESSION_DIR = ZERO_CORE_SESSION_DIR;
}

// ---------------------------------------------------------------------------
// Bootstrap default files if they don't exist
// ---------------------------------------------------------------------------

// models.json — required by Pi Agent
const modelsPath = join(ZERO_CORE_DIR, "models.json");
if (!existsSync(modelsPath)) {
	writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");
}

// zero-core.json — default config with all options documented
const configPath = getGlobalConfigPath();
if (!existsSync(configPath)) {
	const defaultConfig = {
		// _comment: "See ROADMAP.md for full documentation of each section",
		persona: DEFAULT_CONFIG.persona,
		systemPrompt: {
			// base: "Override the default system prompt entirely",
			// append: "Additional instructions appended to the end",
			// guidelines: ["Be concise", "Use TypeScript"],
			injectProjectContext: true,
		},
		context: DEFAULT_CONFIG.context,
		toolPolicy: {
			// blockedTools: ["bash"],
			// allowedTools: ["read_file", "write_file", "bash"],
			// autoApprove: ["read_file"],
			// resultMaxTokens: 8000,
			autoApprove: [],
			executionMode: "parallel",
		},
		compaction: DEFAULT_CONFIG.compaction,
		defaults: DEFAULT_CONFIG.defaults,
		providerAdapter: DEFAULT_CONFIG.providerAdapter,
		inputHandler: DEFAULT_CONFIG.inputHandler,
	};
	writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
	console.log(`[zero-core] Created default config at ${configPath}`);
}

// ---------------------------------------------------------------------------
// Launch Pi with zero-core extension
// ---------------------------------------------------------------------------

await main(process.argv.slice(2), {
	extensionFactories: [extension],
});
