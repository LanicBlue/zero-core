import { Type, type Static } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ZeroCoreConfigSchema = Type.Object({
	systemPrompt: Type.Object({
		base: Type.Optional(Type.String()),
		append: Type.Optional(Type.String()),
		guidelines: Type.Optional(Type.Array(Type.String())),
		injectProjectContext: Type.Optional(Type.Boolean({ default: true })),
		toolSnippets: Type.Optional(Type.Record(Type.String(), Type.String())),
	}),


	context: Type.Object({
		maxTokens: Type.Optional(Type.Number()),
		reserveTokens: Type.Optional(Type.Number({ default: 16384 })),
		keepRecentTokens: Type.Optional(Type.Number({ default: 20000 })),
		pruningStrategy: Type.Optional(Type.Union([
			Type.Literal("tail"),
			Type.Literal("turn-boundary"),
		])),
	}),


	toolPolicy: Type.Object({
		blockedTools: Type.Optional(Type.Array(Type.String())),
		requireApproval: Type.Optional(Type.Array(Type.String())),
		executionMode: Type.Optional(Type.Union([
			Type.Literal("sequential"),
			Type.Literal("parallel"),
		])),
	}),


	compaction: Type.Object({
		strategy: Type.Optional(Type.Union([
			Type.Literal("pi-default"),
			Type.Literal("custom"),
		])),
		customInstructions: Type.Optional(Type.String()),
		reserveTokens: Type.Optional(Type.Number()),
	}),


	harness: Type.Object({
		id: Type.Optional(Type.String({ default: "zero-core" })),
		priority: Type.Optional(Type.Number({ default: 50 })),
		supportedProviders: Type.Optional(Type.Array(Type.String())),
	}),
});

export type ZeroCoreConfig = Static<typeof ZeroCoreConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ZeroCoreConfig = {
	systemPrompt: {
		injectProjectContext: true,
	},
	context: {
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		pruningStrategy: "turn-boundary",
	},
	toolPolicy: {
		executionMode: "parallel",
	},
	compaction: {
		strategy: "pi-default",
	},
	harness: {
		id: "zero-core",
		priority: 50,
	},
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const CONFIG_FILENAMES = ["zero-core.json", ".zero-core.json"];

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
	const result = { ...base } as Record<string, unknown>;
	for (const [key, value] of Object.entries(override)) {
		if (
			value !== null &&
			value !== undefined &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof (base as Record<string, unknown>)[key] === "object" &&
			!Array.isArray((base as Record<string, unknown>)[key])
		) {
			result[key] = deepMerge(
				(base as Record<string, unknown>)[key] as Record<string, unknown>,
				value as Record<string, unknown>,
			);
		} else if (value !== undefined) {
			result[key] = value;
		}
	}
	return result as T;
}

export function loadConfig(cwd?: string, overrides?: Partial<ZeroCoreConfig>): ZeroCoreConfig {
	let fileConfig: Partial<ZeroCoreConfig> = {};

	if (cwd) {
		for (const filename of CONFIG_FILENAMES) {
			const filepath = join(cwd, filename);
			if (existsSync(filepath)) {
				try {
					fileConfig = JSON.parse(readFileSync(filepath, "utf-8"));
					break;
				} catch {
					// Ignore malformed config files
				}
			}
		}
	}

	if (overrides) {
		fileConfig = deepMerge(fileConfig, overrides);
	}

	return deepMerge(DEFAULT_CONFIG, fileConfig);
}
