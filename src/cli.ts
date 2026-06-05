// CLI 入口
//
// # 文件说明书
//
// ## 核心功能
// 命令行接口入口，提供终端交互模式。
//
// ## 输入
// - 命令行参数
// - stdin 输入
//
// ## 输出
// - stdout 输出
// - Agent 响应
//
// ## 定位
// CLI 入口，通过 zero-core 命令调用。
//
// ## 依赖
// - ./runtime/agent-loop - Agent 循环
// - ./runtime/terminal-adapter - 终端适配
// - ./core/config - 配置
//
// ## 维护规则
// - CLI 参数变更时需更新
// - 保持终端交互逻辑正确
//
#!/usr/bin/env node
import * as readline from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { AgentLoop } from "./runtime/agent-loop.js";
import { TerminalAdapter } from "./runtime/terminal-adapter.js";
import { loadConfig } from "./core/config.js";
import { buildSystemPrompt } from "./core/system-prompt.js";
import { loadDeviceContext } from "./core/device-context.js";
import { SessionDB } from "./server/session-db.js";
import { ProviderStore } from "./server/provider-store.js";
import { runMigrations } from "./server/db-migration.js";
import { ToolRegistry } from "./core/tool-registry.js";
import { MCPManager } from "./server/mcp-manager.js";
import type { RuntimeProviderConfig, SessionConfig } from "./runtime/types.js";
import type { Provider } from "./shared/types.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--") && i + 1 < argv.length) {
			args[argv[i].slice(2)] = argv[++i];
		}
	}
	return args;
}

function printUsage(): void {
	console.log(`zero-core — AI agent CLI

Usage: zero-core [options]

Options:
  --model <id>           Model ID (e.g. claude-sonnet-4-20250514, gpt-4o)
  --provider <name>      Provider name (e.g. Anthropic, OpenAI)
  --workspace <dir>      Working directory (default: cwd)
  --thinking <level>     Thinking level: none, low, medium, high
  --help                 Show this help

Commands (during session):
  /reset                 Clear conversation history
  /exit, /quit           Exit the session

Environment variables:
  OPENAI_API_KEY         Auto-configure OpenAI provider
  ANTHROPIC_API_KEY      Auto-configure Anthropic provider
  GOOGLE_API_KEY         Auto-configure Google Gemini provider
`);
}

// ---------------------------------------------------------------------------
// Auto-configure providers from environment variables
// ---------------------------------------------------------------------------

function autoConfigureFromEnv(store: ProviderStore): void {
	const envMap: Array<{ key: string; name: string }> = [
		{ key: "OPENAI_API_KEY", name: "OpenAI" },
		{ key: "ANTHROPIC_API_KEY", name: "Anthropic" },
		{ key: "GOOGLE_API_KEY", name: "Google Gemini" },
	];

	for (const { key, name } of envMap) {
		const apiKey = process.env[key];
		if (!apiKey) continue;

		const existing = store.list().find((p) => p.name === name);
		if (existing && !existing.apiKey) {
			store.update(existing.id, { apiKey, enabled: true } as any);
		} else if (!existing) {
			// Won't happen for system providers, but just in case
		}
	}
}

// ---------------------------------------------------------------------------
// Provider config conversion
// ---------------------------------------------------------------------------

function toRuntimeProviders(providers: Provider[]): RuntimeProviderConfig[] {
	return providers.map((p) => ({
		name: p.name,
		type: p.type,
		apiKey: p.apiKey,
		baseUrl: p.baseUrl,
		models: p.models.map((m) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		enabled: p.enabled,
	}));
}

function resolveProviderAndModel(
	providers: Provider[],
	cliProvider?: string,
	cliModel?: string,
	configDefaults?: { provider?: string; model?: string },
): { providerName: string; modelId: string } {
	const enabled = providers.filter((p) => p.enabled && p.apiKey);
	if (enabled.length === 0) {
		console.error("No providers configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY.");
		console.error("Or configure providers through the desktop app first.");
		process.exit(1);
	}

	const providerName = cliProvider || configDefaults?.provider || enabled[0].name;
	const provider = enabled.find((p) => p.name.toLowerCase() === providerName.toLowerCase());
	if (!provider) {
		console.error(`Provider "${providerName}" not found or not configured.`);
		console.error("Available: " + enabled.map((p) => p.name).join(", "));
		process.exit(1);
	}

	const modelId = cliModel || configDefaults?.model || provider.models[0]?.id;
	if (!modelId) {
		console.error(`No models available for provider "${provider.name}".`);
		process.exit(1);
	}

	return { providerName: provider.name, modelId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printUsage();
		process.exit(0);
	}

	const cwd = args.workspace ? resolve(args.workspace) : process.cwd();
	console.log(`zero-core CLI — workspace: ${cwd}`);

	// Initialize DB
	const sessionDB = new SessionDB();
	runMigrations(sessionDB);
	const registry = new ToolRegistry(sessionDB.getKVStore());

	// Load config
	const config = loadConfig(cwd, undefined, sessionDB.getKVStore());

	// Providers
	const providerStore = new ProviderStore(sessionDB);
	autoConfigureFromEnv(providerStore);
	const providers = providerStore.list();

	// Resolve model
	const { providerName, modelId } = resolveProviderAndModel(
		providers,
		args.provider,
		args.model,
		config.defaults,
	);
	console.log(`Using: ${providerName} / ${modelId}`);

	// Build system prompt
	const deviceContext = loadDeviceContext(sessionDB.getKVStore()) || undefined;
	const systemPrompt = buildSystemPrompt(config, {
		cwd,
		activeTools: [],
		originalPrompt: "You are a helpful AI assistant with access to tools for file operations, code execution, and more.",
		deviceContext,
		useDeviceContext: true,
		useGuidelines: true,
	});

	// Session config
	const sessionConfig: SessionConfig = {
		agentId: "__cli__",
		workspaceDir: cwd,
		systemPrompt,
		modelId,
		providerName,
		thinkingLevel: args.thinking || config.defaults?.thinkingLevel,
		toolPolicy: {
			autoApprove: config.toolPolicy.autoApprove,
			blockedTools: config.toolPolicy.blockedTools,
			executionMode: config.toolPolicy.executionMode ?? "parallel",
			resultMaxTokens: config.toolPolicy.resultMaxTokens,
			readScope: "filesystem",
		},
	};

	const runtimeProviders = toRuntimeProviders(providers);

	// Readline
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "\x1b[1m>\x1b[0m ",
	});

	const adapter = new TerminalAdapter(rl);
	let loop = new AgentLoop(sessionConfig, runtimeProviders, {
		onEvent: (event) => adapter.handleEvent(event),
	});
	let busy = false;

	// SIGINT: abort if busy, exit if idle
	let sigintCount = 0;
	process.on("SIGINT", () => {
		if (busy) {
			sigintCount++;
			if (sigintCount >= 2) {
				console.log("\nForce exit.");
				process.exit(1);
			}
			console.log("\nAborting current task... (Ctrl+C again to force exit)");
			loop.abort();
		} else {
			console.log("\nBye!");
			process.exit(0);
		}
	});

	rl.prompt();

	rl.on("line", async (line) => {
		const text = line.trim();
		if (!text) {
			rl.prompt();
			return;
		}

		// Commands
		if (text === "/exit" || text === "/quit") {
			console.log("Bye!");
			process.exit(0);
		}
		if (text === "/reset") {
			loop.resetSession();
			console.log("Session reset.\n");
			rl.prompt();
			return;
		}
		if (text === "/help") {
			console.log("Commands: /reset, /exit, /help");
			rl.prompt();
			return;
		}

		// Run agent
		busy = true;
		sigintCount = 0;
		try {
			await loop.run(text);
		} catch (err: any) {
			console.error(`\nError: ${err.message}`);
		}
		busy = false;
		rl.prompt();
	});

	rl.on("close", () => {
		if (!busy) {
			console.log("Bye!");
			process.exit(0);
		}
	});
}

main().catch((err) => {
	console.error("Fatal:", err.message);
	process.exit(1);
});
