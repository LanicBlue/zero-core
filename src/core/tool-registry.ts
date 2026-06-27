// 工具注册中心
//
// # 文件说明书
//
// ## 核心功能
// 管理工具的注册、查询和分类，支持运行时工具和自定义工具的统一管理
//
// ## 输入
// IKVStore 实例、工具定义（ToolCategory 和元数据）
//
// ## 输出
// 工具查询结果、已注册工具列表
//
// ## 定位
// src/core/ — 核心层，为 runtime/tools 提供工具发现能力
//
// ## 依赖
// kv-store-interface.ts
//
// ## 维护规则
// 新增工具类别时需更新 ToolCategory 联合类型
//
import type { IKVStore } from "./kv-store-interface.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCategory =
	| "runtime"
	| "task"
	| "web"
	| "memory"
	| "thinking"
	| "assistant"
	| "interaction"
	| "mcp"
	| "agent"
	| "management"
	| "workflow";

export interface ToolConfigField {
	key: string;
	type: "string" | "number" | "boolean" | "select";
	label: string;
	description?: string;
	default?: any;
	options?: string[];
	required?: boolean;
}

export interface ToolDescriptor {
	name: string;
	description: string;
	prompt?: string;
	category: ToolCategory;
	source: "runtime" | "builtin" | "mcp" | "agent";
	mcpServerId?: string;
	mcpServerName?: string;
	agentId?: string;
	agentToolId?: string;
	configSchema?: ToolConfigField[];
	meta: {
		isReadOnly: boolean;
		isDestructive: boolean;
		isConcurrencySafe: boolean;
	};
}

type ChangeCallback = () => void;

const KV_KEY = "tool_config";

// Legacy lowercase tool name → PascalCase mapping
export const RENAMED_TOOLS: Record<string, string> = {
	bash: "Shell", shell: "Shell", read: "Read", write: "Write", edit: "Edit",
	grep: "Grep", glob: "Glob", find: "Glob", agent: "Agent",
	task_status: "TaskStatus", task_list: "TaskList", task_stop: "TaskStop",
	wait: "Wait", web_search: "WebSearch", ask_user: "AskUser", todo_write: "TodoWrite",
	subagent: "Agent", assistant: "Platform", "Assistant": "Platform",
	web_fetch: "WebFetch", memory_read: "MemoryRecall", memory_write: "MemoryNote",
	memory_recall: "MemoryRecall", memory_note: "MemoryNote",
	sequentialthinking: "SequentialThinking",
};

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
	private tools = new Map<string, ToolDescriptor>();
	private config: Record<string, Record<string, any>> = {};
	private changeListeners: ChangeCallback[] = [];
	private kv: IKVStore | null;

	constructor(kv?: IKVStore) {
		this.kv = kv ?? null;
		if (this.kv) this.loadConfig();
	}

	// ─── Registration ───────────────────────────

	register(descriptor: ToolDescriptor): void {
		this.tools.set(descriptor.name, descriptor);
	}

	unregister(source: ToolDescriptor["source"], mcpServerId?: string): void {
		for (const [name, desc] of this.tools) {
			if (desc.source === source && (!mcpServerId || desc.mcpServerId === mcpServerId)) {
				this.tools.delete(name);
			}
		}
		this.notifyChange();
	}

	// ─── Query ──────────────────────────────────

	getAll(): ToolDescriptor[] {
		const config = this.getToolConfig();
		return [...this.tools.values()].map(desc => ({
			...desc,
			description: desc.description,
			prompt: this.buildEffectivePrompt(desc, config),
		}));
	}

	getByCategory(): Record<string, ToolDescriptor[]> {
		const groups: Record<string, ToolDescriptor[]> = {};
		for (const desc of this.tools.values()) {
			(groups[desc.category] ??= []).push(desc);
		}
		return groups;
	}

	getByName(name: string): ToolDescriptor | undefined {
		return this.tools.get(name);
	}

	// ─── Tool Config Persistence ────────────────

getToolConfig(): Record<string, Record<string, any>> {
	const result: Record<string, Record<string, any>> = {};

	// 1. Start with defaults from registered tools configSchema
	for (const [name, desc] of this.tools) {
		if (desc.configSchema?.length) {
			const defaults: Record<string, any> = {};
			for (const field of desc.configSchema) {
				if (field.default !== undefined) defaults[field.key] = field.default;
			}
			if (Object.keys(defaults).length > 0) result[name] = defaults;
		}
	}

	// 2. Overlay stored user config (with legacy key migration)
	for (const [key, val] of Object.entries(this.config)) {
		const mapped = RENAMED_TOOLS[key] ?? key;
		result[mapped] = { ...(result[mapped] ?? {}), ...val };
	}

	return result;
}

getToolConfigFor(name: string): Record<string, any> {
	return this.getToolConfig()[name] ?? {};
}

	saveToolConfig(config: Record<string, Record<string, any>>): void {
		this.config = config;
		if (this.kv) {
			this.kv.setJson(KV_KEY, config);
		}
	}

	private loadConfig(): void {
		if (this.kv) {
			const stored = this.kv.getJson<Record<string, Record<string, any>>>(KV_KEY);
			this.config = stored ?? {};
		}
	}

	// ─── Change Notification ────────────────────

	onChange(cb: ChangeCallback): () => void {
		this.changeListeners.push(cb);
		return () => {
			this.changeListeners = this.changeListeners.filter((c) => c !== cb);
		};
	}

	private buildEffectivePrompt(desc: ToolDescriptor, config: Record<string, Record<string, any>>): string {
		const base = desc.prompt ?? desc.description;
		const toolConfig = config[desc.name];
		if (!toolConfig || !desc.configSchema?.length) return base;
		const entries = desc.configSchema
			.map(f => {
				const v = toolConfig[f.key] ?? f.default;
				if (v === undefined || v === "") return null;
				return `${f.label || f.key}=${JSON.stringify(v)}`;
			})
			.filter(Boolean);
		if (entries.length === 0) return base;
		const configHint = "\n\nCurrent config: " + entries.join(", ");
		return base + configHint;
	}

	notifyChange(): void {
		for (const cb of this.changeListeners) {
			try { cb(); } catch { /* ignore */ }
		}
	}
}
