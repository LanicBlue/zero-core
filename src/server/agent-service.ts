import {
	createAgentSession,
	type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { buildPersonaPrompt, applyPersonaToConfig, type PersonaDefinition } from "../core/persona.js";
import { loadProjectContext, formatProjectContext } from "../core/project-context.js";
import type { AgentRecord } from "./agent-store.js";

// ---------------------------------------------------------------------------
// Ensure zero-core dirs
// ---------------------------------------------------------------------------

const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");
const ZERO_CORE_SESSION_DIR = process.env.ZERO_CORE_SESSION_DIR ?? join(ZERO_CORE_DIR, "sessions");

if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = ZERO_CORE_DIR;
}
if (!process.env.PI_CODING_AGENT_SESSION_DIR) {
	process.env.PI_CODING_AGENT_SESSION_DIR = ZERO_CORE_SESSION_DIR;
}
for (const dir of [ZERO_CORE_DIR, ZERO_CORE_SESSION_DIR]) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Agent Service — long-lived, survives UI disconnects
// ---------------------------------------------------------------------------

type StreamCallback = (event: { type: string; [key: string]: unknown }) => void;

interface SessionEntry {
	result: CreateAgentSessionResult;
	agentId: string;
}

class AgentService {
	private sessions = new Map<string, SessionEntry>();
	private activeSession: SessionEntry | null = null;
	private subscribers = new Set<StreamCallback>();
	private config = loadConfig(process.cwd());
	private workspaceDir: string;
	private isAgentBusy = false;
	private currentStreamText = "";
	private currentToolCalls: { name: string; status: "running" | "done" | "error" }[] = [];

	constructor(workspaceDir: string) {
		this.workspaceDir = workspaceDir;
	}

	setWorkspaceDir(dir: string): void {
		if (dir !== this.workspaceDir) {
			this.workspaceDir = dir;
			this.dispose();
		}
	}

	subscribe(cb: StreamCallback): () => void {
		this.subscribers.add(cb);
		return () => { this.subscribers.delete(cb); };
	}

	getState(): { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[] } {
		return {
			isBusy: this.isAgentBusy,
			streamingText: this.currentStreamText,
			toolCalls: [...this.currentToolCalls],
		};
	}

	private async getOrCreateSession(agent?: AgentRecord): Promise<SessionEntry> {
		const agentId = agent?.id ?? "__default__";

		let entry = this.sessions.get(agentId);
		if (entry) {
			this.activeSession = entry;
			return entry;
		}

		const cwd = agent?.workspaceDir || this.workspaceDir;
		console.log("[agent] Creating session for agent:", agentId, "cwd:", cwd);

		const sessionOptions: Record<string, unknown> = {
			cwd,
		};

		const result = await createAgentSession(sessionOptions) as CreateAgentSessionResult;

		console.log("[agent] Session created, loading extension...");

		const extensionPath = join(import.meta.dirname ?? __dirname, "../extension/index.js");
		try {
			const { default: extensionFactory } = await import(extensionPath);
			if (typeof extensionFactory === "function") {
				console.log("[agent] Extension loaded (factory mode)");
			}
		} catch (err) {
			console.log("[agent] Extension import skipped:", (err as Error).message);
		}

		const definition = agent ? agentToDefinition(agent) : undefined;

		// Merge persona overrides into config
		const effectiveConfig = definition
			? applyPersonaToConfig(this.config, definition)
			: this.config;

		const projectCtx = loadProjectContext(cwd, agent?.contextConfig);

		const systemPrompt = buildSystemPrompt(effectiveConfig, {
			cwd,
			activeTools: [],
			originalPrompt: "",
			projectContext: projectCtx ? formatProjectContext(projectCtx) : undefined,
			extraSections: definition
				? [{ key: "Persona", content: buildPersonaPrompt(definition) }]
				: undefined,
		});

		result.session.agent.state.systemPrompt = systemPrompt;

		let capturedEntry: SessionEntry | null = null;

		result.session.subscribe((event: unknown) => {
			const e = event as Record<string, unknown>;
			if (this.activeSession === capturedEntry && e && "type" in e) {
				this.handleEvent(e);
			}
		});

		entry = { result, agentId };
		capturedEntry = entry;
		this.sessions.set(agentId, entry);
		this.activeSession = entry;

		console.log("[agent] Session ready for:", agentId);
		return entry;
	}

	async sendPrompt(text: string, agent?: AgentRecord): Promise<void> {
		const entry = await this.getOrCreateSession(agent);

		console.log("[agent] Sending prompt:", text.substring(0, 50));
		this.isAgentBusy = true;
		this.currentStreamText = "";
		this.currentToolCalls = [];

		try {
			await entry.result.session.prompt(text);
			console.log("[agent] Prompt completed");
		} catch (err) {
			console.error("[agent] Prompt error:", (err as Error).message);
			this.emit({ type: "error", error: (err as Error).message });
		}
	}

	async abort(): Promise<void> {
		this.activeSession?.result.session.agent.abort();
	}

	dispose(): void {
		for (const entry of this.sessions.values()) {
			try {
				entry.result.session.agent.abort();
			} catch { /* ignore */ }
		}
		this.sessions.clear();
		this.activeSession = null;
		this.subscribers.clear();
		this.isAgentBusy = false;
	}

	private handleEvent(e: Record<string, unknown>): void {
		switch (e.type) {
			case "message_update": {
				const msg = e.message as Record<string, unknown> | undefined;
				if (!msg || typeof msg !== "object" || msg.role === "user") break;
				if ("content" in msg && Array.isArray(msg.content)) {
					for (const block of msg.content as Record<string, unknown>[]) {
						if (block.type === "text" && typeof block.text === "string" && block.text) {
							this.currentStreamText = block.text;
							this.emit({ type: "text_delta", text: block.text });
						}
					}
				}
				break;
			}

			case "message_end": {
				const endMsg = e.message as Record<string, unknown> | undefined;
				if (!endMsg || typeof endMsg !== "object" || endMsg.role === "user") break;
				let fullText = "";
				if ("content" in endMsg && Array.isArray(endMsg.content)) {
					for (const block of endMsg.content as Record<string, unknown>[]) {
						if (block.type === "text" && typeof block.text === "string") {
							fullText += block.text;
						}
					}
				}
				this.currentStreamText = fullText;
				this.emit({ type: "message_end", text: fullText });
				break;
			}

			case "tool_execution_start": {
				this.currentToolCalls.push({ name: e.toolName as string, status: "running" });
				this.emit({ type: "tool_start", toolName: e.toolName });
				break;
			}

			case "tool_execution_end": {
				const tc = this.currentToolCalls.find(t => t.name === e.toolName && t.status === "running");
				if (tc) tc.status = e.isError ? "error" : "done";
				this.emit({ type: "tool_end", toolName: e.toolName, isError: e.isError });
				break;
			}

			case "agent_end": {
				this.isAgentBusy = false;
				this.currentStreamText = "";
				this.currentToolCalls = [];
				this.emit({ type: "agent_end" });
				break;
			}
		}
	}

	private emit(event: { type: string; [key: string]: unknown }): void {
		for (const cb of this.subscribers) {
			try { cb(event); } catch { /* ignore */ }
		}
	}
}

function agentToDefinition(a: AgentRecord): PersonaDefinition {
	return {
		name: a.name,
		role: a.role,
		traits: a.traits,
		expertise: a.expertise,
		communicationStyle: a.communicationStyle as "professional" | "casual" | "technical" | "friendly",
		customInstructions: a.customInstructions,
	};
}

export function createAgentService(workspaceDir: string): AgentService {
	return new AgentService(workspaceDir);
}
