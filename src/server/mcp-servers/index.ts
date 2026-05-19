import { createFetchTools } from "./fetch-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createSequentialThinkingTools } from "./sequential-thinking-tools.js";
import { createAssistantTools } from "./assistant-tools.js";

// ---------------------------------------------------------------------------
// Built-in MCP server tools — aggregated export
// Note: runtime tools (read/write/edit/grep/find/bash) cover filesystem ops,
// so no separate Filesystem MCP server is needed.
// ---------------------------------------------------------------------------

export interface BuiltInToolsOptions {
	workspaceDir: string;
	appVersion?: string;
}

export function createAllBuiltInTools(options: BuiltInToolsOptions): Record<string, any> {
	const fetchTools = createFetchTools();
	const memoryTools = createMemoryTools();
	const thinkingTools = createSequentialThinkingTools();
	const assistantTools = createAssistantTools(options.appVersion ? () => options.appVersion! : undefined);

	return {
		...fetchTools,
		...memoryTools,
		...thinkingTools,
		...assistantTools,
	};
}

export {
	createFetchTools,
	createMemoryTools,
	createSequentialThinkingTools,
	createAssistantTools,
};
