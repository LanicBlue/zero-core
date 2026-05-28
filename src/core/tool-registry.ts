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
	| "agent";

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
	userDescription?: string;
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
		requiresConfirmation: boolean;
	};
}

type ChangeCallback = () => void;

const KV_KEY = "tool_config";

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
		return [...this.tools.values()];
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
		return { ...this.config };
	}

	getToolConfigFor(name: string): Record<string, any> {
		return this.config[name] ?? {};
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

	notifyChange(): void {
		for (const cb of this.changeListeners) {
			try { cb(); } catch { /* ignore */ }
		}
	}
}
