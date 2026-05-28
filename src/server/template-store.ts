import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { PromptTemplate } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const BUILT_IN_TEMPLATES: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">[] = [
	{
		name: "Coder",
		description: "Software development assistant — writes, reviews, and debugs code with full tool access.",
		icon: "💻",
		systemPrompt: `You are an expert software developer. Write clean, efficient, and well-structured code. Follow best practices and design patterns. When debugging, reason step-by-step. Use tools proactively to read files, run commands, and verify your work.`,
		toolPolicy: {
			autoApprove: ["bash", "read", "edit", "write", "grep", "find", "ls"],
			readScope: "filesystem",
		},
		tags: ["coding", "development"],
		isBuiltIn: true,
	},
	{
		name: "Writer",
		description: "Content creation assistant — helps with articles, documentation, emails, and creative writing.",
		icon: "✍️",
		systemPrompt: `You are a skilled writer and editor. Help create clear, engaging, and well-structured content. Adapt your tone and style to the audience. For documentation, prioritize clarity and completeness. For creative writing, bring originality and vivid language.`,
		toolPolicy: {
			autoApprove: ["read", "write"],
			readScope: "workspace",
		},
		tags: ["writing", "content"],
		isBuiltIn: true,
	},
	{
		name: "Translator",
		description: "Multilingual translation assistant — translates text while preserving meaning and tone.",
		icon: "🌐",
		systemPrompt: `You are a professional translator. Translate text accurately while preserving the original meaning, tone, and style. Handle idioms and cultural references appropriately. When ambiguous, provide alternatives with brief explanations.`,
		toolPolicy: {
			autoApprove: ["read"],
			readScope: "workspace",
		},
		tags: ["translation", "language"],
		isBuiltIn: true,
	},
	{
		name: "Reviewer",
		description: "Code and text review assistant — provides detailed feedback and suggestions for improvement.",
		icon: "🔍",
		systemPrompt: `You are a thorough reviewer. Analyze code or text and provide specific, actionable feedback. For code reviews, check for bugs, security issues, performance problems, and style inconsistencies. For text, evaluate clarity, structure, grammar, and persuasiveness.`,
		toolPolicy: {
			autoApprove: ["read", "grep", "find", "ls"],
			readScope: "filesystem",
		},
		tags: ["review", "feedback"],
		isBuiltIn: true,
	},
	{
		name: "Analyst",
		description: "Data analysis assistant — helps analyze data, create reports, and extract insights.",
		icon: "📊",
		systemPrompt: `You are a data analyst expert. Help analyze data, identify patterns, and present insights clearly. Write scripts to process data when needed. Create clear visualizations and summaries. Always explain your methodology and assumptions.`,
		toolPolicy: {
			autoApprove: ["bash", "read", "write", "grep", "find", "ls"],
			readScope: "filesystem",
		},
		tags: ["data", "analysis"],
		isBuiltIn: true,
	},
	{
		name: "Tutor",
		description: "Teaching assistant — explains concepts clearly with examples and step-by-step guidance.",
		icon: "🎓",
		systemPrompt: `You are a patient and knowledgeable tutor. Explain concepts clearly using simple language and relatable examples. Break complex topics into digestible steps. Use analogies and practical demonstrations. Encourage questions and adapt your explanations to the learner's level.`,
		toolPolicy: {
			autoApprove: ["read"],
			readScope: "workspace",
		},
		tags: ["education", "learning"],
		isBuiltIn: true,
	},
	{
		name: "Creative",
		description: "Creative brainstorming assistant — generates ideas, stories, and innovative solutions.",
		icon: "💡",
		systemPrompt: `You are a creative thinker and brainstormer. Generate diverse, original ideas and explore them from multiple angles. Think outside conventional boundaries. Build on ideas collaboratively, combining concepts in unexpected ways. Present options with pros and cons.`,
		tags: ["creative", "brainstorm"],
		isBuiltIn: true,
	},
];

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "description" },
	{ key: "icon" },
	{ key: "systemPrompt", column: "system_prompt" },
	{ key: "model" },
	{ key: "provider" },
	{ key: "thinkingLevel", column: "thinking_level" },
	{ key: "toolPolicy", column: "tool_policy", json: true },
	{ key: "tags", json: true },
	{ key: "sourceUrl", column: "source_url" },
	{ key: "color" },
	{ key: "recommendedTools", column: "recommended_tools", json: true },
	{ key: "isBuiltIn", column: "is_built_in", bool: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// TemplateStore
// ---------------------------------------------------------------------------

export class TemplateStore {
	private store: SqliteStore<PromptTemplate>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<PromptTemplate>(sessionDB.getDb(), "templates", COLUMNS);

		// Merge built-in templates
		this.mergeBuiltInTemplates();
	}

	private mergeBuiltInTemplates(): void {
		const existing = this.store.list();
		const existingBuiltInNames = new Set(
			existing.filter((t) => t.isBuiltIn).map((t) => t.name),
		);
		for (const builtin of BUILT_IN_TEMPLATES) {
			if (!existingBuiltInNames.has(builtin.name)) {
				this.store.create({ ...builtin, isBuiltIn: true } as any);
			}
		}
	}

	list(): PromptTemplate[] {
		return this.store.list();
	}

	get(id: string): PromptTemplate | undefined {
		return this.store.get(id);
	}

	create(input: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">): PromptTemplate {
		return this.store.create({ ...input, isBuiltIn: false } as any);
	}

	update(id: string, input: Partial<Omit<PromptTemplate, "id" | "createdAt">>): PromptTemplate {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		const t = this.store.get(id);
		if (t?.isBuiltIn) throw new Error("Cannot delete built-in template");
		this.store.delete(id);
	}

	exportTemplate(id: string): string {
		const t = this.get(id);
		if (!t) throw new Error(`Template not found: ${id}`);
		return JSON.stringify(t, null, 2);
	}

	importTemplate(json: string): PromptTemplate {
		const parsed = JSON.parse(json);
		if (!parsed.name || !parsed.systemPrompt) {
			throw new Error("Invalid template: name and systemPrompt are required");
		}
		return this.store.create({
			name: parsed.name,
			description: parsed.description ?? "",
			icon: parsed.icon,
			systemPrompt: parsed.systemPrompt,
			model: parsed.model,
			provider: parsed.provider,
			thinkingLevel: parsed.thinkingLevel,
			toolPolicy: parsed.toolPolicy,
			tags: parsed.tags ?? [],
			sourceUrl: parsed.sourceUrl,
			isBuiltIn: false,
		} as any);
	}

	findByNameAndSource(name: string, sourceUrl: string): PromptTemplate | undefined {
		return this.store.list().find(
			(t) => t.name === name && t.sourceUrl === sourceUrl,
		);
	}
}
