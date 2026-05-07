import {
	createAgentSession,
	type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import extension from "../extension/index.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { PersonaRecord } from "./persona-store.js";

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
	personaId: string;
}

class AgentService {
	private sessions = new Map<string, SessionEntry>();
	private activeSession: SessionEntry | null = null;
	private subscribers = new Set<StreamCallback>();
	private config = loadConfig(process.cwd());
	private workspaceDir: string;
	// Track current streaming state for reconnecting clients
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

	/** Get current state for reconnecting clients */
	getState(): { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[] } {
		return {
			isBusy: this.isAgentBusy,
			streamingText: this.currentStreamText,
			toolCalls: [...this.currentToolCalls],
		};
	}

	private async getOrCreateSession(persona?: PersonaRecord): Promise<SessionEntry> {
		const personaId = persona?.id ?? "__default__";

		let entry = this.sessions.get(personaId);
		if (entry) {
			this.activeSession = entry;
			return entry;
		}

		console.log("[agent] Creating session for persona:", personaId, "cwd:", this.workspaceDir);

		const sessionOptions: Record<string, unknown> = {
			cwd: this.workspaceDir,
		};

		const extensionPath = join(import.meta.dirname ?? __dirname, "../extension/index.js");

		const result = await createAgentSession(sessionOptions) as CreateAgentSessionResult;

		console.log("[agent] Session created, loading extension...");

		try {
			const { default: extensionFactory } = await import(extensionPath);
			if (typeof extensionFactory === "function") {
				console.log("[agent] Extension loaded (factory mode)");
			}
		} catch (err) {
			console.log("[agent] Extension import skipped:", (err as Error).message);
		}

		const systemPrompt = buildSystemPrompt(this.config, {
			cwd: this.workspaceDir,
			activeTools: [],
			originalPrompt: "",
			extraSections: persona
				? [{ key: "Persona", content: formatPersona(persona) }]
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

		entry = { result, personaId };
		capturedEntry = entry;
		this.sessions.set(personaId, entry);
		this.activeSession = entry;

		console.log("[agent] Session ready for:", personaId);
		return entry;
	}

	async sendPrompt(text: string, persona?: PersonaRecord): Promise<void> {
		const entry = await this.getOrCreateSession(persona);

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

function formatPersona(p: PersonaRecord): string {
	const lines = [`Your name is ${p.name}. ${p.role}`];
	if (p.traits.length) lines.push(`Traits: ${p.traits.join(", ")}`);
	if (p.expertise.length) lines.push(`Expertise: ${p.expertise.join(", ")}`);
	lines.push(`Communication style: ${p.communicationStyle}`);
	if (p.customInstructions) lines.push(`Custom instructions: ${p.customInstructions}`);
	return lines.join("\n");
}

export function createAgentService(workspaceDir: string): AgentService {
	return new AgentService(workspaceDir);
}
