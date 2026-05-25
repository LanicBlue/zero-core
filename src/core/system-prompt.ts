import type { ZeroCoreConfig } from "./config.js";

export interface SystemPromptContext {
	cwd: string;
	activeTools: string[];
	originalPrompt: string;
	// ─── Global content ─────────────────────────
	deviceContext?: string;
	guidelines?: string[];
	skills?: Array<{ id: string; name: string; description: string }>;
	toolSnippets?: Record<string, string>;
	// ─── Section toggles (default true, false to disable) ──
	useDeviceContext?: boolean;
	useGuidelines?: boolean;
	useMemoryContext?: boolean;
	enabledSkills?: string[];
}

export function buildSystemPrompt(config: ZeroCoreConfig, ctx: SystemPromptContext): string {
	const sections: string[] = [];

	// 1. Device Context
	if (ctx.useDeviceContext !== false && ctx.deviceContext) {
		sections.push(ctx.deviceContext);
	}

	// 2. Base Prompt (always included)
	sections.push(ctx.originalPrompt);

	// 3. Guidelines
	if (ctx.useGuidelines !== false) {
		const guidelines = ctx.guidelines ?? config.systemPrompt?.guidelines;
		if (guidelines?.length) {
			sections.push("## Guidelines\n\n" + guidelines.map((g) => `- ${g}`).join("\n"));
		}
	}

	// 4. Tool Reference
	const snippets = { ...ctx.toolSnippets, ...config.systemPrompt?.toolSnippets };
	if (Object.keys(snippets).length > 0) {
		const activeSnippets = ctx.activeTools
			.filter((t) => snippets[t])
			.map((t) => `### ${t}\n${snippets[t]}`)
			.join("\n\n");
		if (activeSnippets) {
			sections.push("## Tool Reference\n\n" + activeSnippets);
		}
	}

	// 5. Skills
	if (ctx.skills?.length) {
		const enabled = ctx.enabledSkills;
		const filtered = enabled
			? ctx.skills.filter((s) => enabled.includes(s.id))
			: ctx.skills;
		if (filtered.length) {
			const skillList = filtered.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
			sections.push("## Available Skills\n\n" + skillList);
		}
	}

	// 6. Memory/Wiki (reserved)
	if (ctx.useMemoryContext === true) {
		sections.push("## Memory\n\n(Memory context will be injected here when available.)");
	}

	return sections.join("\n\n");
}
