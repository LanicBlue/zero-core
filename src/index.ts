// Zero Core - Custom Agent Core based on Pi Agent
//
// Two usage modes:
//
// 1. Standalone (Pi CLI):
//    pi --extension ./dist/extension/index.js
//
// 2. OpenClaw Harness Plugin:
//    OPENCLAW_AGENT_RUNTIME=zero-core openclaw gateway run

// Core configuration
export { loadConfig, DEFAULT_CONFIG, ZeroCoreConfigSchema } from "./core/config.js";
export type { ZeroCoreConfig } from "./core/config.js";

// Core logic
export { buildSystemPrompt } from "./core/system-prompt.js";
export { shouldPrune, pruneMessages } from "./core/context-manager.js";
export { evaluateToolCall, requiresApproval, transformToolResult } from "./core/tool-policy.js";
export { shouldCompact, buildCompactionInstructions } from "./core/compaction.js";

// OpenClaw harness
export { createZeroCoreHarness } from "./openclaw/harness.js";
