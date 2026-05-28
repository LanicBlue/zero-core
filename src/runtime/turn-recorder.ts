import type { ISessionStore } from "./session-store-interface.js";
import { parseThinkingTags } from "./agent-utils.js";

// ---------------------------------------------------------------------------
// TurnRecorder — collects streaming blocks and persists turns to the DB
// ---------------------------------------------------------------------------

/**
 * Manages the turnBlocks array during a streaming run and provides methods
 * to persist user / assistant turns to the session store.
 */
export class TurnRecorder {
	/** Collected blocks for the current assistant turn (text, thinking, tool). */
	blocks: any[] = [];

	// Internal accumulators for the current step (between tool calls)
	private currentStepThinking = "";
	private currentStepText = "";

	// -----------------------------------------------------------------------
	// Block accumulation
	// -----------------------------------------------------------------------

	/** Record that a text-delta was received. */
	addTextDelta(delta: string): void {
		this.currentStepText += delta;
	}

	/** Record that a reasoning-delta was received. */
	addThinkingDelta(delta: string): void {
		this.currentStepThinking += delta;
	}

	/** Record a tool-call start. Seals any pending text/thinking first. */
	addToolStart(name: string, args: any): void {
		this.sealStep();
		this.blocks.push({ type: "tool", name, status: "running", args });
	}

	/** Record a successful tool result. */
	addToolResult(name: string, output: any): void {
		const tb = this.findRunningTool(name);
		if (tb) {
			tb.status = "done";
			tb.result = output;
		}
	}

	/** Record a tool error. */
	addToolError(name: string, errorText: string, output?: any): void {
		const tb = this.findRunningTool(name);
		if (tb) {
			tb.status = "error";
			tb.result = errorText ?? String(output);
		}
	}

	/** Flush any pending text/thinking into blocks (called before tool calls and at end). */
	sealStep(): void {
		if (this.currentStepThinking) {
			let t = this.currentStepThinking;
			while (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
			if (t) this.blocks.push({ type: "thinking", text: t });
			this.currentStepThinking = "";
		}
		if (this.currentStepText) {
			for (const b of parseThinkingTags(this.currentStepText)) this.blocks.push(b);
			this.currentStepText = "";
		}
	}

	// -----------------------------------------------------------------------
	// Persistence
	// -----------------------------------------------------------------------

	/** Append a user turn to the turns table. */
	saveUserTurn(db: ISessionStore, sessionId: string, text: string): void {
		if (!db || !sessionId) return;
		const seq = db.getTurnCount(sessionId);
		db.appendTurn(sessionId, seq, "user", text);
	}

	/** Append an assistant turn (the collected blocks) to the turns table. */
	saveAssistantTurn(db: ISessionStore, sessionId: string): void {
		if (!db || !sessionId) return;
		if (this.blocks.length === 0) return;
		const seq = db.getTurnCount(sessionId);
		db.appendTurn(sessionId, seq, "assistant", JSON.stringify(this.blocks));
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Reset state for a new run. */
	reset(): void {
		this.blocks = [];
		this.currentStepThinking = "";
		this.currentStepText = "";
	}

	/** Get a snapshot of tool-call blocks (for getState). */
	getToolCalls(): { name: string; status: string }[] {
		return this.blocks
			.filter((b: any) => b.type === "tool")
			.map((b: any) => ({ name: b.name, status: b.status }));
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Find the most recent running tool block with the given name. */
	private findRunningTool(name: string): any | undefined {
		return [...this.blocks].reverse().find(
			(b: any) => b.type === "tool" && b.name === name && b.status === "running",
		);
	}
}
