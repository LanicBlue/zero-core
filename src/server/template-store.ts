import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Prompt Template
// ---------------------------------------------------------------------------

export interface PromptTemplate {
	id: string;
	name: string;
	description: string;
	icon?: string;
	systemPrompt: string;
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	toolPolicy?: {
		autoApprove?: string[];
		blockedTools?: string[];
		executionMode?: "sequential" | "parallel";
		resultMaxTokens?: number;
		readScope?: "filesystem" | "workspace";
	};
	tags: string[];
	isBuiltIn: boolean;
	createdAt: string;
	updatedAt: string;
}

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
// Storage
// ---------------------------------------------------------------------------

interface TemplateStoreData {
	templates: PromptTemplate[];
}

export class TemplateStore {
	private filePath: string;
	private data: TemplateStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "templates.json");
		this.data = this.load();
	}

	private load(): TemplateStoreData {
		if (existsSync(this.filePath)) {
			try {
				const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
				// Merge in new built-in templates that may have been added
				const existingBuiltInNames = new Set(
					data.templates.filter((t: PromptTemplate) => t.isBuiltIn).map((t: PromptTemplate) => t.name),
				);
				let dirty = false;
				for (const builtin of BUILT_IN_TEMPLATES) {
					if (!existingBuiltInNames.has(builtin.name)) {
						data.templates.push(this.createRecord(builtin));
						dirty = true;
					}
				}
				if (dirty) this.save(data);
				return data;
			} catch {
				// fall through
			}
		}

		const templates = BUILT_IN_TEMPLATES.map((t) => this.createRecord(t));
		const data: TemplateStoreData = { templates };
		this.save(data);
		return data;
	}

	private save(data: TemplateStoreData): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	private createRecord(
		input: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">,
	): PromptTemplate {
		const now = new Date().toISOString();
		return {
			id: uuidv4(),
			...input,
			createdAt: now,
			updatedAt: now,
		};
	}

	list(): PromptTemplate[] {
		return this.data.templates;
	}

	get(id: string): PromptTemplate | undefined {
		return this.data.templates.find((t) => t.id === id);
	}

	create(input: Omit<PromptTemplate, "id" | "createdAt" | "updatedAt">): PromptTemplate {
		const record = this.createRecord({ ...input, isBuiltIn: false });
		this.data.templates.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<PromptTemplate, "id" | "createdAt">>): PromptTemplate {
		const index = this.data.templates.findIndex((t) => t.id === id);
		if (index === -1) throw new Error(`Template not found: ${id}`);
		this.data.templates[index] = {
			...this.data.templates[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.templates[index];
	}

	delete(id: string): void {
		const t = this.data.templates.find((t) => t.id === id);
		if (t?.isBuiltIn) throw new Error("Cannot delete built-in template");
		this.data.templates = this.data.templates.filter((t) => t.id !== id);
		this.save(this.data);
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
		// Assign a new ID to avoid conflicts
		const record = this.createRecord({
			name: parsed.name,
			description: parsed.description ?? "",
			icon: parsed.icon,
			systemPrompt: parsed.systemPrompt,
			model: parsed.model,
			provider: parsed.provider,
			thinkingLevel: parsed.thinkingLevel,
			toolPolicy: parsed.toolPolicy,
			tags: parsed.tags ?? [],
			isBuiltIn: false,
		});
		this.data.templates.push(record);
		this.save(this.data);
		return record;
	}
}
