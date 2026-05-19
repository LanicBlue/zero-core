import type { ModelMessage } from "ai";
import { loadConfig } from "../core/config.js";
import { shouldPrune, pruneMessages } from "../core/context-manager.js";
import { evaluateToolCall, transformToolResult } from "../core/tool-policy.js";

// ---------------------------------------------------------------------------
// Extension hooks — lightweight hook system for agent lifecycle events
// Replaces the pi-coding-agent ExtensionAPI with simple functions called by
// the runtime (agent-loop / agent-service).
// ---------------------------------------------------------------------------

export interface ExtensionHooks {
	beforeStart?(systemPrompt: string, cwd: string): Promise<string | undefined>;
	shouldPruneContext?(messages: ModelMessage[]): Promise<ModelMessage[] | undefined>;
	evaluateTool?(toolName: string): Promise<{ block: boolean; reason?: string } | undefined>;
	transformResult?(toolName: string, content: unknown, details?: unknown, isError?: boolean): Promise<unknown>;
}

export function createExtensionHooks(): ExtensionHooks {
	const config = loadConfig(process.cwd());

	return {
		async beforeStart(systemPrompt, _cwd) {
			// Future: persona template, project context injection
			return undefined;
		},

		async shouldPruneContext(messages) {
			if (!shouldPrune(config, messages)) return undefined;
			return pruneMessages(config, messages);
		},

		async evaluateTool(toolName) {
			const decision = evaluateToolCall(config, toolName);
			if (decision.block) {
				return { block: true, reason: decision.reason };
			}
			return undefined;
		},

		async transformResult(toolName, content, details, isError) {
			const result = transformToolResult(config, toolName, content, details, isError);
			return result ?? content;
		},
	};
}

export default createExtensionHooks;
