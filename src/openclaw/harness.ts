import { loadConfig, type ZeroCoreConfig } from "../core/config.js";
import { runZeroCoreAttempt } from "./run-attempt.js";

export interface AgentHarness {
	id: string;
	label: string;
	pluginId?: string;
	supports(ctx: { provider: string; modelId?: string; requestedRuntime: unknown }): {
		supported: boolean;
		priority?: number;
		reason?: string;
	};
	runAttempt(params: unknown): Promise<unknown>;
	compact?(params: unknown): Promise<unknown>;
	reset?(params: { sessionId?: string; sessionKey?: string; sessionFile?: string; reason?: string }): Promise<void>;
	dispose?(): Promise<void>;
}

export interface HarnessResult {
	ok: boolean;
	compacted: boolean;
	reason?: string;
	result?: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		tokensAfter?: number;
	};
}

export function createZeroCoreHarness(config?: Partial<ZeroCoreConfig>): AgentHarness {
	const resolvedConfig = loadConfig(process.cwd(), config);

	return {
		id: resolvedConfig.harness.id ?? "zero-core",
		label: "Zero Core Agent",
		pluginId: "zero-core",

		supports(ctx) {
			const providers = resolvedConfig.harness.supportedProviders;
			if (providers?.length) {
				return providers.includes(ctx.provider)
					? { supported: true, priority: resolvedConfig.harness.priority }
					: { supported: false, reason: `Provider "${ctx.provider}" not in supported list` };
			}
			return { supported: true, priority: resolvedConfig.harness.priority };
		},

		async runAttempt(params) {
			return runZeroCoreAttempt(params, resolvedConfig);
		},

		async compact(params: unknown) {
			// Delegate to Pi's built-in compaction by default
			return { ok: true, compacted: false, reason: "delegated-to-pi" };
		},

		async reset(params) {
			// Clear any session-specific state
		},

		async dispose() {
			// Clean up resources
		},
	};
}
