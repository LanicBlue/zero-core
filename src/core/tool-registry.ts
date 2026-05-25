import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCategory =
	| "runtime"
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

// ---------------------------------------------------------------------------
// ToolRegistry — singleton
// ---------------------------------------------------------------------------

class ToolRegistry {
	private tools = new Map<string, ToolDescriptor>();
	private configPath: string;
	private config: Record<string, Record<string, any>> = {};
	private changeListeners: ChangeCallback[] = [];

	constructor() {
		this.configPath = join(homedir(), ".zero-core", "tool-config.json");
		this.loadConfig();
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
		const dir = join(this.configPath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
	}

	private loadConfig(): void {
		if (!existsSync(this.configPath)) {
			this.config = {};
			return;
		}
		try {
			this.config = JSON.parse(readFileSync(this.configPath, "utf-8"));
		} catch {
			this.config = {};
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

// Singleton
export const toolRegistry = new ToolRegistry();
