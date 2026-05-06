import {
	createAgentSession,
	type ToolDefinition,
	type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ZeroCoreConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { createEventBridge } from "./event-bridge.js";
import type { AttemptCallbacks } from "./types.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = resolve(__dirname, "..", "extension", "index.js");

export interface AttemptParams {
	prompt: string;
	images?: unknown[];
	sessionId?: string;
	sessionFile?: string;
	workspaceDir?: string;
	agentDir?: string;
	model?: unknown;
	authStorage?: unknown;
	modelRegistry?: unknown;
	sessionManager?: unknown;
	tools?: unknown[];
	timeoutMs?: number;
	abortSignal?: AbortSignal;
	callbacks?: AttemptCallbacks;
	systemPromptAppend?: string;
}

export interface AttemptResult {
	aborted: boolean;
	externalAbort: boolean;
	timedOut: boolean;
	promptError: unknown;
	sessionIdUsed: string;
	assistantTexts: string[];
	messagesSnapshot: AgentMessage[];
	lastAssistant: unknown;
	compactionCount: number;
}

export async function runZeroCoreAttempt(
	rawParams: unknown,
	config: ZeroCoreConfig,
): Promise<AttemptResult> {
	const params = rawParams as AttemptParams;
	const callbacks = params.callbacks ?? {};

	// 1. Build system prompt
	const systemPrompt = buildSystemPrompt(config, {
		cwd: params.workspaceDir ?? process.cwd(),
		activeTools: [],
		originalPrompt: "",
		extraSections: params.systemPromptAppend
			? [{ key: "Additional Instructions", content: params.systemPromptAppend }]
			: undefined,
	});

	// 2. Create agent session
	const sessionOptions: Record<string, unknown> = {
		cwd: params.workspaceDir ?? process.cwd(),
	};

	if (params.agentDir) sessionOptions.agentDir = params.agentDir;
	if (params.model) sessionOptions.model = params.model;
	if (params.authStorage) sessionOptions.authStorage = params.authStorage;
	if (params.modelRegistry) sessionOptions.modelRegistry = params.modelRegistry;
	if (params.sessionManager) sessionOptions.sessionManager = params.sessionManager;
	if (params.tools) sessionOptions.customTools = params.tools as ToolDefinition[];

	const { session } = await createAgentSession(sessionOptions) as CreateAgentSessionResult;

	// 3. Override system prompt
	session.agent.state.systemPrompt = systemPrompt;

	// 4. Subscribe to events
	session.subscribe((event) => {
		if ("type" in event) {
			createEventBridge(callbacks)(event as never, new AbortController().signal);
		}
	});

	// 5. Run the prompt
	const aborted = params.abortSignal?.aborted ?? false;
	let timedOut = false;
	let promptError: unknown = undefined;

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	if (params.timeoutMs) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			session.agent.abort();
		}, params.timeoutMs);
	}

	params.abortSignal?.addEventListener("abort", () => {
		session.agent.abort();
	});

	try {
		await session.prompt(params.prompt, { images: params.images as never[] });
	} catch (err) {
		if (!aborted && !timedOut) {
			promptError = err;
		}
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}

	// 6. Extract results
	const messages = session.agent.state.messages;
	const assistantTexts = messages
		.filter((m): m is typeof m & { role: "assistant" } => m.role === "assistant")
		.flatMap((m) => {
			if ("content" in m && Array.isArray(m.content)) {
				return m.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c && !!c.text)
					.map((c) => c.text);
			}
			return [];
		});

	const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

	return {
		aborted,
		externalAbort: aborted,
		timedOut,
		promptError,
		sessionIdUsed: params.sessionId ?? "",
		assistantTexts,
		messagesSnapshot: [...messages],
		lastAssistant,
		compactionCount: 0,
	};
}
