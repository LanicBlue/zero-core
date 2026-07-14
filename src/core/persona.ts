// 角色定义（Persona）模块
//
// # 文件说明书
//
// ## 核心功能
// 定义 AI 角色的完整配置接口，包括通信风格、专业领域和行为特征
//
// ## 输入
// ZeroCoreConfig 中的 persona 配置
//
// ## 输出
// PersonaDefinition 接口，描述角色名称、风格、专业领域等属性
//
// ## 定位
// src/core/ — 核心层，为 system-prompt 提供角色定制能力
//
// ## 依赖
// config.ts
//
// ## 维护规则
// 新增角色属性时需同步更新 UI 角色编辑器组件
//
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Persona Definition
// ---------------------------------------------------------------------------

export type CommunicationStyle = "professional" | "casual" | "technical" | "friendly";

export interface PersonaDefinition {
	name: string;
	role: string;
	traits?: string[];
	expertise?: string[];
	communicationStyle: CommunicationStyle;
	customInstructions?: string;
	// Persona-scoped module overrides
	toolPolicy?: {
		blockedTools?: string[];
		autoApprove?: string[];
	};
	compaction?: {
		customInstructions?: string;
	};
	// compression-archive-simplify sub-3b (D2): persona-scoped override for the
	// stage-3 compression system prompt. When present, applied over
	// config.compression.summarySystemPrompt in applyPersonaToConfig. Mirrors
	// the compaction.customInstructions merge precedent.
	compression?: {
		summarySystemPrompt?: string;
	};
	systemPrompt?: {
		guidelines?: string[];
		append?: string;
	};
}

// ---------------------------------------------------------------------------
// Predefined Templates
// ---------------------------------------------------------------------------

export const PERSONA_TEMPLATES: Record<string, PersonaDefinition> = {
	zero: {
		name: "Zero",
		role: "Expert coding assistant with deep system design knowledge",
		traits: ["concise", "thorough", "pragmatic"],
		expertise: ["TypeScript", "system-design", "DevOps"],
		communicationStyle: "professional",
	},
	coder: {
		name: "Coder",
		role: "Senior software engineer focused on implementation",
		traits: ["precise", "efficient", "detail-oriented"],
		expertise: ["algorithms", "design-patterns", "testing"],
		communicationStyle: "technical",
	},
	reviewer: {
		name: "Reviewer",
		role: "Code review specialist focused on quality and correctness",
		traits: ["thorough", "constructive", "analytical"],
		expertise: ["code-quality", "security", "performance"],
		communicationStyle: "professional",
		toolPolicy: {
			blockedTools: ["Bash"],
		},
	},
	architect: {
		name: "Architect",
		role: "System design consultant for high-level architecture decisions",
		traits: ["strategic", "pragmatic", "forward-thinking"],
		expertise: ["distributed-systems", "API-design", "scalability"],
		communicationStyle: "professional",
	},
	writer: {
		name: "Writer",
		role: "Technical writer specializing in documentation",
		traits: ["clear", "structured", "audience-aware"],
		expertise: ["documentation", "tutorials", "API-reference"],
		communicationStyle: "friendly",
		systemPrompt: {
			guidelines: [
				"Always use clear, well-structured markdown",
				"Include code examples where appropriate",
				"Explain concepts from first principles",
			],
		},
	},
};

// ---------------------------------------------------------------------------
// Persona → System Prompt
// ---------------------------------------------------------------------------

export function buildPersonaPrompt(persona: PersonaDefinition): string {
	const sections: string[] = [];

	// Identity
	sections.push(`Your name is ${persona.name}. ${persona.role}`);

	// Traits
	if (persona.traits?.length) {
		sections.push(`Personality traits: ${persona.traits.join(", ")}`);
	}

	// Expertise
	if (persona.expertise?.length) {
		sections.push(`Areas of expertise: ${persona.expertise.join(", ")}`);
	}

	// Communication style
	sections.push(`Communication style: ${persona.communicationStyle}`);

	// Persona-specific guidelines
	if (persona.systemPrompt?.guidelines?.length) {
		sections.push("Guidelines:\n" + persona.systemPrompt.guidelines.map((g) => `- ${g}`).join("\n"));
	}

	// Persona-specific append
	if (persona.systemPrompt?.append) {
		sections.push(persona.systemPrompt.append);
	}

	// Custom instructions (always last)
	if (persona.customInstructions) {
		sections.push(persona.customInstructions);
	}

	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Persona + Config Merge
// ---------------------------------------------------------------------------

export function applyPersonaToConfig(
	config: ZeroCoreConfig,
	persona: PersonaDefinition,
): ZeroCoreConfig {
	const merged = structuredClone(config);

	// Merge toolPolicy
	if (persona.toolPolicy) {
		if (persona.toolPolicy.blockedTools) {
			merged.toolPolicy.blockedTools = [
				...(merged.toolPolicy.blockedTools ?? []),
				...persona.toolPolicy.blockedTools,
			];
		}
		if (persona.toolPolicy.autoApprove) {
			merged.toolPolicy.autoApprove = [
				...(merged.toolPolicy.autoApprove ?? []),
				...persona.toolPolicy.autoApprove,
			];
		}
	}

	// Merge compaction
	if (persona.compaction?.customInstructions) {
		merged.compaction.customInstructions = persona.compaction.customInstructions;
	}

	// sub-3b (D2): merge persona-scoped compression summary system prompt. The
	// default (undefined here) means "use config.compression.summarySystemPrompt
	// or the in-file SUMMARY_SYSTEM literal" — only override when the persona
	// sets one. Output sections contract is fixed; bad prompt → fallbackSections.
	if (persona.compression?.summarySystemPrompt) {
		merged.compression.summarySystemPrompt = persona.compression.summarySystemPrompt;
	}

	// Merge systemPrompt
	if (persona.systemPrompt?.guidelines) {
		merged.systemPrompt.guidelines = [
			...(merged.systemPrompt.guidelines ?? []),
			...persona.systemPrompt.guidelines,
		];
	}
	if (persona.systemPrompt?.append) {
		merged.systemPrompt.append = [
			merged.systemPrompt.append ?? "",
			persona.systemPrompt.append,
		].filter(Boolean).join("\n");
	}

	return merged;
}
