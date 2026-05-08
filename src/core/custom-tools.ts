import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Custom tool definitions
// ---------------------------------------------------------------------------

export interface CustomToolDefinition {
	name: string;
	description: string;
	handler: (args: Record<string, unknown>) => Promise<string>;
}

// Registry for custom tools added at runtime
const registry = new Map<string, CustomToolDefinition>();

/**
 * Register a custom tool that can be invoked by the agent.
 */
export function registerCustomTool(tool: CustomToolDefinition): void {
	registry.set(tool.name, tool);
}

/**
 * Get all registered custom tools.
 */
export function getCustomTools(): CustomToolDefinition[] {
	return Array.from(registry.values());
}

/**
 * Execute a custom tool by name.
 */
export async function executeCustomTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string | null> {
	const tool = registry.get(name);
	if (!tool) return null;
	return tool.handler(args);
}
