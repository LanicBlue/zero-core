import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// User input preprocessing — custom command expansion
// ---------------------------------------------------------------------------

export interface InputTransform {
	text: string;
	matched?: boolean;
}

/**
 * Process user input through custom command templates.
 * Commands are defined in config.inputHandler.commands as { pattern: { template, description } }.
 * If the input starts with a command prefix (e.g. "/review"), expand it using the template.
 */
export function processInput(config: ZeroCoreConfig, input: string): InputTransform {
	const commands = config.inputHandler.commands;
	if (!commands) return { text: input };

	// Match against command prefixes (keys in commands)
	for (const [prefix, def] of Object.entries(commands)) {
		if (input === prefix || input.startsWith(prefix + " ")) {
			const args = input.slice(prefix.length).trim();
			const text = def.template.replace(/\{args\}/g, args);
			return { text, matched: true };
		}
	}

	return { text: input };
}
