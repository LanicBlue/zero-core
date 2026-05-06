import { createZeroCoreHarness } from "./harness.js";

/**
 * OpenClaw plugin entry point for Zero Core.
 *
 * Usage in OpenClaw config:
 *   OPENCLAW_AGENT_RUNTIME=zero-core
 *
 * Or in agent config:
 *   { "agents": { "defaults": { "agentRuntime": { "id": "zero-core" } } } }
 */
function definePluginEntry(definition: {
	id: string;
	name: string;
	description?: string;
	register: (api: { registerAgentHarness: (harness: unknown) => void; pluginConfig?: unknown }) => void;
}) {
	return definition;
}

export default definePluginEntry({
	id: "zero-core",
	name: "Zero Core Agent",
	description: "Custom agent core based on Pi Agent with configurable context management, tool policy, and compaction",
	register(api) {
		api.registerAgentHarness(createZeroCoreHarness());
	},
});
