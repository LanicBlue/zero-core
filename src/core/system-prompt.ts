import type { ZeroCoreConfig } from "./config.js";

export interface SystemPromptContext {
	cwd: string;
	activeTools: string[];
	originalPrompt: string;
	skills?: Array<{ name: string; description: string }>;
	toolSnippets?: Record<string, string>;
	extraSections?: Array<{ key: string; content: string }>;
}

export function buildSystemPrompt(config: ZeroCoreConfig, ctx: SystemPromptContext): string {
	const sections: string[] = [];

	// Base prompt: use config override or fall back to original
	if (config.systemPrompt.base) {
		sections.push(config.systemPrompt.base);
	} else {
		sections.push(ctx.originalPrompt);
	}

	// Guidelines
	if (config.systemPrompt.guidelines?.length) {
		sections.push("## Guidelines\n\n" + config.systemPrompt.guidelines.map((g) => `- ${g}`).join("\n"));
	}

	// Tool snippets
	const snippets = { ...ctx.toolSnippets, ...config.systemPrompt.toolSnippets };
	if (Object.keys(snippets).length > 0) {
		const activeSnippets = ctx.activeTools
			.filter((t) => snippets[t])
			.map((t) => `### ${t}\n${snippets[t]}`)
			.join("\n\n");
		if (activeSnippets) {
			sections.push("## Tool Reference\n\n" + activeSnippets);
		}
	}

	// Skills
	if (ctx.skills?.length) {
		const skillList = ctx.skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
		sections.push("## Available Skills\n\n" + skillList);
	}

	// Extra sections
	if (ctx.extraSections?.length) {
		for (const section of ctx.extraSections) {
			sections.push(`## ${section.key}\n\n${section.content}`);
		}
	}

	// Append prompt
	if (config.systemPrompt.append) {
		sections.push(config.systemPrompt.append);
	}

	return sections.join("\n\n");
}
