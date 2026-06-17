// 配置管理
//
// # 文件说明书
//
// ## 核心功能
// 定义和管理 zero-core 的配置 schema，提供配置加载和验证功能。
//
// ## 输入
// - 配置文件路径（默认 ~/.zero-core/config.yaml）
//
// ## 输出
// - ZeroCoreConfigSchema - 配置 schema
// - loadConfig() - 加载配置的函数
// - DEFAULT_CONFIG - 默认配置值
//
// ## 定位
// 核心配置模块，被整个项目使用。
//
// ## 依赖
// - typebox - Schema 定义
// - node:fs - 文件系统操作
// - ./kv-store-interface - KV 存储
//
// ## 维护规则
// - 新增配置项时需更新 schema
// - 保持默认值与 schema 一致
//
import { Type, type Static } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IKVStore } from "./kv-store-interface.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ZeroCoreConfigSchema = Type.Object({
	// ─── zero-core 独有 ─────────────────────────────────────────

	persona: Type.Object({
		defaultTemplate: Type.Optional(Type.String()),
	}),

	toolPolicy: Type.Object({
		blockedTools: Type.Optional(Type.Array(Type.String())),
		allowedTools: Type.Optional(Type.Array(Type.String())),
		autoApprove: Type.Optional(Type.Array(Type.String())),
		tools: Type.Optional(Type.Record(Type.String(), Type.Object({ enabled: Type.Boolean() }))),
		resultMaxTokens: Type.Optional(Type.Number()),
		toolCategories: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object({
					blocked: Type.Optional(Type.Boolean()),
					requireApproval: Type.Optional(Type.Boolean()),
				}),
			),
		),
		executionMode: Type.Optional(
			Type.Union([Type.Literal("sequential"), Type.Literal("parallel")]),
		),
	}),

	context: Type.Object({
		maxTokens: Type.Optional(Type.Number()),
		reserveTokens: Type.Optional(Type.Number()),
		keepRecentTokens: Type.Optional(Type.Number()),
		pruningStrategy: Type.Optional(
			Type.Union([
				Type.Literal("tail"),
				Type.Literal("turn-boundary"),
				Type.Literal("smart"),
			]),
		),
		preserveToolResults: Type.Optional(Type.Boolean()),
		importanceScoring: Type.Optional(Type.Boolean()),
	}),

	providerAdapter: Type.Object({
		compatibility: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object({
					systemPromptAppend: Type.Optional(Type.String()),
					maxSystemPromptTokens: Type.Optional(Type.Number()),
					stripThinkingTags: Type.Optional(Type.Boolean()),
				}),
			),
		),
	}),

	inputHandler: Type.Object({
		commands: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object({
					template: Type.String(),
					description: Type.Optional(Type.String()),
				}),
			),
		),
	}),

	// ─── System Prompt ────────────────────────────────────────────

	systemPrompt: Type.Object({
		base: Type.Optional(Type.String()),
		append: Type.Optional(Type.String()),
		guidelines: Type.Optional(Type.Array(Type.String())),
		injectProjectContext: Type.Optional(Type.Boolean()),
		toolSnippets: Type.Optional(Type.Record(Type.String(), Type.String())),
	}),

	// ─── Compaction ──────────────────────────────────────────────

	compaction: Type.Object({
		strategy: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("custom")]),
		),
		customInstructions: Type.Optional(Type.String()),
		enabled: Type.Optional(Type.Boolean()),
		reserveTokens: Type.Optional(Type.Number()),
		keepRecentTokens: Type.Optional(Type.Number()),
	}),

	// ─── Compression (L1/L2 progressive)

	compression: Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		keepRecentTurns: Type.Optional(Type.Number()),
		l1Threshold: Type.Optional(Type.Number()),
		l2Threshold: Type.Optional(Type.Number()),
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
	}),

	// ─── Memory (wiki nodes)

	memory: Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		autoExtract: Type.Optional(Type.Boolean()),
		autoRecall: Type.Optional(Type.Boolean()),
		recallLimit: Type.Optional(Type.Number()),
	}),

	// ─── Extractors (v0.8 M5 — archive extractor A + tool telemetry extractor B)
	//
	// Two independent post-hoc agents that run async after each turn / on
	// session close. Each has its own enable flag (decision 44).
	//   - A: content memory extractor — writes global wiki `type=memory` nodes
	//        (decision 46 N2). Used both for low-checkpoint incremental
	//        extraction (mechanism 2) and terminal flush (mechanism 3).
	//   - B: tool telemetry extractor — writes to an independent telemetry
	//        store (NOT the wiki tree; platform-improvement data, not project
	//        knowledge — decision 49).
	// checkpointThresholds = token-budget ratios at which the low-checkpoint
	// incremental extraction hook fires extractor A on the delta since the
	// last cursor (decision 53). Default ~20% / 45% / 70% (RFC §2.18).
	extractors: Type.Object({
		A: Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			provider: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
		}),
		B: Type.Object({
			enabled: Type.Optional(Type.Boolean()),
			provider: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
		}),
		checkpointThresholds: Type.Optional(Type.Array(Type.Number())),
	}),

	// ─── Runtime defaults ──────────────────────────────────────────

	defaults: Type.Object({
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(Type.String()),
	}),

	retry: Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		maxRetries: Type.Optional(Type.Number()),
		baseDelayMs: Type.Optional(Type.Number()),
	}),

	shell: Type.Object({
		path: Type.Optional(Type.String()),
		commandPrefix: Type.Optional(Type.String()),
	}),

	terminal: Type.Object({
		showImages: Type.Optional(Type.Boolean()),
		imageWidthCells: Type.Optional(Type.Number()),
	}),

	// ─── Harness ────────────────────────────────────────

	harness: Type.Object({
		id: Type.Optional(Type.String()),
		priority: Type.Optional(Type.Number()),
		supportedProviders: Type.Optional(Type.Array(Type.String())),
	}),
});

export type ZeroCoreConfig = Static<typeof ZeroCoreConfigSchema>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_GUIDELINES = [
	"Confirm with the user before starting work if there are unresolved Open Questions",
	"Ask for confirmation before executing dangerous operations",
];

export const DEFAULT_CONFIG: ZeroCoreConfig = {
	persona: {},
	systemPrompt: {
		injectProjectContext: true,
		guidelines: DEFAULT_GUIDELINES,
	},
	context: {
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		pruningStrategy: "turn-boundary",
		preserveToolResults: true,
		importanceScoring: false,
	},
	toolPolicy: {
		autoApprove: [],
		executionMode: "parallel",
	},
	compaction: {
		strategy: "auto",
	},
	compression: {
		enabled: false,
	},
	memory: {
		enabled: false,
	},
	// v0.8 (M5): archive extractors. A is the unified content-memory writer
	// (incremental + close flush). B is the tool telemetry extractor. Both
	// off by default; flip extractors.A.enabled=true in config to turn on.
	extractors: {
		A: { enabled: false },
		B: { enabled: false },
		// RFC §2.18 / decision 53 — fire at low budget points so the delta
		// can be summarized while there's still headroom. NOT a "live
		// checkpoint" — it's just a token-budget threshold for invoking the
		// async extractor A on the delta since the last cursor.
		checkpointThresholds: [0.2, 0.45, 0.7],
	},
	defaults: {},
	retry: {},
	shell: {},
	terminal: {},
	providerAdapter: {},
	inputHandler: {},
	harness: {
		id: "zero-core",
		priority: 50,
	},
};

// ---------------------------------------------------------------------------
// Global config path
// ---------------------------------------------------------------------------

export const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");

export function getGlobalConfigPath(): string {
	return join(ZERO_CORE_DIR, "zero-core.json");
}

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const PROJECT_CONFIG_FILENAMES = ["zero-core.json", ".zero-core.json"];

function readJsonFile(filepath: string): Record<string, unknown> | null {
	if (!existsSync(filepath)) return null;
	try {
		return JSON.parse(readFileSync(filepath, "utf-8"));
	} catch {
		return null;
	}
}

export function loadConfig(cwd?: string, overrides?: Partial<ZeroCoreConfig>, kv?: IKVStore): ZeroCoreConfig {
	let fileConfig: Partial<ZeroCoreConfig> = {};

	// 1. Global config: from SQLite kv_store (migrated from zero-core.json)
	// db passed as parameter
	if (kv) {
		const globalData = kv.getJson<Partial<ZeroCoreConfig>>("global_config");
		if (globalData) fileConfig = deepMerge(fileConfig, globalData);
	} else {
		// Fallback for environments where DB is not yet initialized
		const globalData = readJsonFile(getGlobalConfigPath());
		if (globalData) fileConfig = deepMerge(fileConfig, globalData as Partial<ZeroCoreConfig>);
	}

	// 2. Project config: <cwd>/zero-core.json or <cwd>/.zero-core.json
	if (cwd) {
		for (const filename of PROJECT_CONFIG_FILENAMES) {
			const projectData = readJsonFile(join(cwd, filename));
			if (projectData) {
				fileConfig = deepMerge(fileConfig, projectData as Partial<ZeroCoreConfig>);
				break;
			}
		}
	}

	// 3. Runtime overrides
	if (overrides) {
		fileConfig = deepMerge(fileConfig, overrides);
	}

	return deepMerge(DEFAULT_CONFIG, fileConfig);
}

// ---------------------------------------------------------------------------
// Fallback helper
// ---------------------------------------------------------------------------

export function resolveEffective<T>(configValue: T | undefined, piDefault: T): T {
	return configValue !== undefined ? configValue : piDefault;
}

export function saveGlobalConfig(config: Partial<ZeroCoreConfig>, kv: IKVStore): void {
	kv.setJson("global_config", config);
}
