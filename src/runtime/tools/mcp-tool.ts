import { tool } from "ai";
import { z } from "zod";

/**
 * Creates a Vercel AI SDK tool from an MCP tool definition.
 * The tool delegates execution to the MCP manager at runtime.
 */
export function createMcpTool(
	qualifiedName: string,
	description: string | undefined,
	inputSchema: unknown,
	serverId: string,
	serverName: string,
	callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<{ result: unknown; error?: string }>,
) {
	// Extract the original tool name from qualified name (mcp__serverName__toolName)
	const toolName = qualifiedName.split("__").slice(2).join("__");

	// Parse the input schema to build a Zod schema
	const zodSchema = inputSchemaToZod(inputSchema);

	return tool({
		description: description ?? `MCP tool from ${serverName}: ${toolName}`,
		parameters: zodSchema,
		execute: async (params) => {
			const { result, error } = await callTool(serverId, toolName, params as Record<string, unknown>);
			if (error) {
				return `Error calling MCP tool ${qualifiedName}: ${error}`;
			}
			if (typeof result === "string") return result;
			return JSON.stringify(result, null, 2);
		},
	});
}

/**
 * Converts an MCP JSON Schema input schema to a Zod schema for Vercel AI SDK.
 * Falls back to an empty object schema if parsing fails.
 */
function inputSchemaToZod(schema: unknown): z.ZodTypeAny {
	if (!schema || typeof schema !== "object") {
		return z.object({});
	}

	const s = schema as Record<string, unknown>;
	const properties = s.properties as Record<string, Record<string, unknown>> | undefined;
	const required = new Set(s.required as string[] ?? []);

	if (!properties || Object.keys(properties).length === 0) {
		return z.object({});
	}

	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(properties)) {
		const z = propToZod(prop);
		shape[key] = required.has(key) ? z : z.optional();
	}

	return z.object(shape);
}

function propToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	switch (prop.type) {
		case "string":
			return z.string().describe((prop.description as string) ?? "");
		case "number":
		case "integer":
			return z.number().describe((prop.description as string) ?? "");
		case "boolean":
			return z.boolean().describe((prop.description as string) ?? "");
		case "array":
			return z.array(z.any()).describe((prop.description as string) ?? "");
		case "object":
			return z.record(z.any()).describe((prop.description as string) ?? "");
		default:
			return z.any().describe((prop.description as string) ?? "");
	}
}

/**
 * Build a map of MCP tools for use in agent-loop.
 * Returns Record<string, Tool> suitable for passing to streamText().
 */
export function buildMcpTools(
	mcpTools: Map<string, { name: string; description?: string; inputSchema: unknown; serverId: string; serverName: string }>,
	callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<{ result: unknown; error?: string }>,
): Record<string, any> {
	const tools: Record<string, any> = {};
	for (const [qualifiedName, info] of mcpTools) {
		tools[qualifiedName] = createMcpTool(
			qualifiedName,
			info.description,
			info.inputSchema,
			info.serverId,
			info.serverName,
			callTool,
		);
	}
	return tools;
}
