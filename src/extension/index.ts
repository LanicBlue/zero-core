import type {
	ExtensionAPI,
	ToolResultEvent,
	SessionBeforeCompactEvent,
} from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { shouldPrune, pruneMessages } from "../core/context-manager.js";
import { evaluateToolCall, transformToolResult } from "../core/tool-policy.js";
import { buildCompactionInstructions } from "../core/compaction.js";
import { buildPersonaPrompt, applyPersonaToConfig, PERSONA_TEMPLATES } from "../core/persona.js";

const extension = (pi: ExtensionAPI): void => {
	const config = loadConfig(process.cwd());

	// -------------------------------------------------------------------------
	// System prompt customization
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event) => {
		// Apply persona template if configured
		const templateName = config.persona.defaultTemplate;
		const persona = templateName ? PERSONA_TEMPLATES[templateName] : undefined;
		const effectiveConfig = persona ? applyPersonaToConfig(config, persona) : config;

		const systemPrompt = buildSystemPrompt(effectiveConfig, {
			cwd: process.cwd(),
			activeTools: [],
			originalPrompt: event.systemPrompt,
			extraSections: persona
				? [{ key: "Persona", content: buildPersonaPrompt(persona) }]
				: undefined,
		});
		return { systemPrompt };
	});

	// -------------------------------------------------------------------------
	// Context management (pruning)
	// -------------------------------------------------------------------------
	pi.on("context", async (event) => {
		if (!shouldPrune(config, event.messages)) return;
		const pruned = pruneMessages(config, event.messages);
		return { messages: pruned };
	});

	// -------------------------------------------------------------------------
	// Tool call policy
	// -------------------------------------------------------------------------
	pi.on("tool_call", async (event) => {
		const decision = evaluateToolCall(config, event.toolName);
		if (decision.block) {
			return { block: true, reason: decision.reason };
		}
	});

	// -------------------------------------------------------------------------
	// Tool result post-processing
	// -------------------------------------------------------------------------
	(pi as { on(event: "tool_result", handler: (event: ToolResultEvent) => Promise<{ content?: unknown; details?: unknown; isError?: boolean } | undefined | void>): void }).on(
		"tool_result",
		async (event) => {
			return transformToolResult(config, event.toolName, event.content, event.details, event.isError);
		},
	);

	// -------------------------------------------------------------------------
	// Custom compaction
	// -------------------------------------------------------------------------
	(pi as { on(event: "session_before_compact", handler: (event: SessionBeforeCompactEvent) => Promise<Record<string, unknown> | undefined | void>): void }).on(
		"session_before_compact",
		async (event) => {
			if (config.compaction.strategy !== "custom") return;

			const instructions = buildCompactionInstructions(config);
			if (instructions && event.preparation) {
				return {
					cancel: false as const,
					compaction: {
						...event.preparation,
						customInstructions: instructions,
					},
				};
			}
		},
	);
};

export default extension;
