import { createFetchTools } from "./fetch-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createSequentialThinkingTools } from "./sequential-thinking-tools.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createAssistantTools } from "./assistant-tools.js";

// ---------------------------------------------------------------------------
// Built-in MCP server tools — aggregated export
// ---------------------------------------------------------------------------

export interface BuiltInToolsOptions {
	workspaceDir: string;
	appVersion?: string;
}

export function createAllBuiltInTools(options: BuiltInToolsOptions): Record<string, any> {
	const fetchTools = createFetchTools();
	const memoryTools = createMemoryTools();
	const thinkingTools = createSequentialThinkingTools();
	const filesystemTools = createFilesystemTools({ baseDir: options.workspaceDir });
	const assistantTools = createAssistantTools(options.appVersion ? () => options.appVersion! : undefined);

	return {
		...fetchTools,
		...memoryTools,
		...thinkingTools,
		...filesystemTools,
		...assistantTools,
	};
}

export {
	createFetchTools,
	createMemoryTools,
	createSequentialThinkingTools,
	createFilesystemTools,
	createAssistantTools,
};
