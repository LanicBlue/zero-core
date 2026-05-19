// Zero Core - Custom Agent Runtime
//
// Usage:
//   import { createAgentService } from "zero-core/server/agent-service.js";

// Core configuration
export { loadConfig, DEFAULT_CONFIG, ZeroCoreConfigSchema, ZERO_CORE_DIR, getGlobalConfigPath, resolveEffective } from "./core/config.js";
export type { ZeroCoreConfig } from "./core/config.js";

// Core logic
export { buildSystemPrompt } from "./core/system-prompt.js";
export { shouldPrune, pruneMessages } from "./core/context-manager.js";
export { evaluateToolCall, requiresApproval, transformToolResult } from "./core/tool-policy.js";

// Runtime
export { AgentLoop } from "./runtime/agent-loop.js";
export type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	RuntimeCallbacks,
	AgentRuntime,
	RuntimeState,
	ToolExecutionContext,
	ModelMessage,
} from "./runtime/types.js";
export { resolveModel, clearProviderCache } from "./runtime/provider-factory.js";
