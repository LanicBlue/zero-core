import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type AnyAgentTool = AgentTool;

export function bridgeTools(tools: AnyAgentTool[]): ToolDefinition[] {
	return tools.map((tool) => ({
		name: tool.name,
		label: tool.label ?? tool.name,
		description: tool.description ?? "",
		parameters: tool.parameters,
		async execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			_ctx: unknown,
		): Promise<AgentToolResult<unknown>> {
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	}));
}
