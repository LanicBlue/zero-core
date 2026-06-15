// 扫描外部工具(Claude Desktop / Cursor / VSCode 等)的 MCP 配置并合并入库
//
// # 文件说明书
//
// ## 核心功能
// 枚举本机上各 IDE / AI 工具的 MCP 配置文件路径(按平台区分 Windows / Unix),解析其中的 mcpServers / servers 配置,推断 transport(stdio / sse / streamable-http),并对 stdio 用 which/where、对 sse 用 fetch 探测 running 状态;mergeDetectedServers 负责把扫描结果去重后写回 McpStore。
//
// ## 输入
// - scanExternalMcpConfigs(workspaceDir): 当前工作区目录,用于发现 .vscode/mcp.json 等 workspace 级配置
// - mergeDetectedServers 接收 existing 已入库列表、create 入库函数与 detected 扫描结果
//
// ## 输出
// - DetectedMcpServer[]: 含 running 状态的扫描结果
// - mergeDetectedServers 返回本次新增入库的 McpServerConfig[]
//
// ## 定位
// src/server/ 服务层,在服务启动(index.ts)时被调用一次,把外部工具已声明的 MCP 自动并入 zero-core 的 McpStore。
//
// ## 依赖
// - node:fs、node:path、node:os、node:child_process、全局 fetch
// - ../shared/types(McpServerConfig)
//
// ## 维护规则
// - 新增支持的 IDE / 工具时,在 getConfigSources 添加文件路径(注意 Windows APPDATA 与 Unix ~/.config 区分)。
// - 探测 running 的超时(2s for SSE、3s for which/where)应保持短,避免拖慢启动。
// - 配置文件解析失败应静默跳过,不要让单个坏文件中断整个扫描。
//

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import type { McpServerConfig } from "../shared/types.js";

export interface DetectedMcpServer extends McpServerConfig {
	running: boolean;
}

interface RawMcpEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	transport?: string;
}

interface McpConfigSource {
	app: string;
	path: string;
	key: "mcpServers" | "servers";
	prefix: string;
}

function getConfigSources(workspaceDir: string): McpConfigSource[] {
	const home = homedir();
	const isWin = platform() === "win32";
	const sources: McpConfigSource[] = [
		{ app: "claude-desktop", path: join(home, ".claude", "claude_desktop_config.json"), key: "mcpServers", prefix: "Claude" },
		{ app: "cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers", prefix: "Cursor" },
		{ app: "marscode", path: join(home, ".marscode", "vscode.mcp.config.json"), key: "mcpServers", prefix: "MarsCode" },
		{ app: "fitten", path: join(home, ".fitten", "mcp_settings.json"), key: "mcpServers", prefix: "Fitten" },
		{ app: "vscode-workspace", path: join(workspaceDir, ".vscode", "mcp.json"), key: "servers", prefix: "VSCode" },
	];

	if (isWin) {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		sources.push(
			{ app: "claude-desktop", path: join(appData, "Claude", "claude_desktop_config.json"), key: "mcpServers", prefix: "Claude" },
		);
	}

	// VS Code global settings.json may contain mcp.servers
	if (isWin) {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		sources.push(
			{ app: "vscode-global", path: join(appData, "Code", "User", "settings.json"), key: "mcpServers" as any, prefix: "VSCode" },
		);
	} else {
		sources.push(
			{ app: "vscode-global", path: join(home, ".config", "Code", "User", "settings.json"), key: "mcpServers" as any, prefix: "VSCode" },
		);
	}

	// VS Code extensions may ship .mcp.json files
	const vscodeExtDir = join(home, ".vscode", "extensions");
	if (existsSync(vscodeExtDir)) {
		try {
			for (const entry of readdirSync(vscodeExtDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const mcpFile = join(vscodeExtDir, entry.name, ".mcp.json");
				if (existsSync(mcpFile)) {
					const extName = entry.name.split("-").slice(0, -1).join("-") || entry.name;
					sources.push({
						app: `vscode-ext-${extName}`,
						path: mcpFile,
						key: "mcpServers",
						prefix: extName,
					});
				}
			}
		} catch { /* ignore */ }
	}

	return sources;
}

function detectTransport(entry: RawMcpEntry): "stdio" | "sse" | "streamable-http" {
	if (entry.transport === "sse" || entry.transport === "streamable-http") return entry.transport;
	if (entry.url) return "sse";
	return "stdio";
}

async function probeSseServer(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000);
		await fetch(url, { method: "GET", signal: controller.signal });
		clearTimeout(timer);
		return true;
	} catch {
		return false;
	}
}

async function probeStdioCommand(command: string): Promise<boolean> {
	const { execSync } = await import("node:child_process");
	const cmd = process.platform === "win32" ? `where ${command}` : `which ${command}`;
	try {
		execSync(cmd, { timeout: 3000, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function parseConfigFile(filePath: string, key: string): Record<string, RawMcpEntry> | null {
	if (!existsSync(filePath)) return null;

	let raw: any;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}

	// For VS Code settings.json, MCP servers might be nested under "mcp"
	if (key === "mcpServers" && raw.mcp?.servers && !raw.mcpServers) {
		return raw.mcp.servers;
	}

	const servers = raw[key] as Record<string, RawMcpEntry> | undefined;
	if (!servers || typeof servers !== "object") return null;
	return servers;
}

export async function scanExternalMcpConfigs(workspaceDir: string): Promise<DetectedMcpServer[]> {
	const sources = getConfigSources(workspaceDir);
	const results: DetectedMcpServer[] = [];
	const seen = new Set<string>();

	for (const source of sources) {
		const servers = parseConfigFile(source.path, source.key);
		if (!servers) continue;

		for (const [name, entry] of Object.entries(servers)) {
			const transport = detectTransport(entry);
			const dedupeKey = `${source.app}:${name}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);

			const id = `${source.app}-${name}`;

			const config: McpServerConfig = {
				id,
				name: `[${source.prefix}] ${name}`,
				transport,
				command: entry.command,
				args: entry.args,
				env: entry.env,
				url: entry.url,
				headers: entry.headers,
				enabled: true,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				sourceApp: source.app,
			};

			let running = false;
			if (transport === "sse" && entry.url) {
				running = await probeSseServer(entry.url);
			} else if (transport === "stdio" && entry.command) {
				running = await probeStdioCommand(entry.command);
			}

			results.push({ ...config, running });
		}
	}

	return results;
}

export function mergeDetectedServers(
	existing: McpServerConfig[],
	create: (input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">) => McpServerConfig,
	detected: DetectedMcpServer[],
): McpServerConfig[] {
	const existingKeys = new Set(existing.map((s) => `${s.sourceApp ?? ""}:${s.name}`));
	const added: McpServerConfig[] = [];

	for (const d of detected) {
		const key = `${d.sourceApp ?? ""}:${d.name}`;
		if (existingKeys.has(key)) continue;

		const { running: _r, ...config } = d;
		const record = create(config as any);
		added.push(record);
	}

	return added;
}
