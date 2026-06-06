import { BrowserWindow, session } from "electron";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { ToolExecutionContext } from "../../runtime/types.js";
import { ALL_TOOLS } from "../../runtime/tools/index.js";
import { getToolExecute, getToolInputFields } from "../../runtime/tools/tool-factory.js";
import { importCookies, getCookieCount, clearCookies } from "../../runtime/mcp-tools/fetch-tools.js";

export function registerToolHandlers(ctx: IpcContext): void {
	typedHandle("tools:list", "toolRegistry",
		(_ctx) => (_ctx.toolRegistry as any).getAll().map((d: any) => ({
			name: d.name,
			description: d.description,
			prompt: d.prompt,
			group: d.category,
			source: d.source,
			mcpServerName: d.mcpServerName,
			configSchema: d.configSchema,
			inputFields: getToolInputFields(ALL_TOOLS[d.name]),
			meta: d.meta,
		})),
	);

	typedHandle("tool-config:get", "toolRegistry",
		(_ctx) => (_ctx.toolRegistry as any).getToolConfig(),
	);

	typedHandle("tool-config:save", "toolRegistry",
		(_ctx, config) => { (_ctx.toolRegistry as any).saveToolConfig(config); },
	);

	typedHandle("tool:execute", ["toolRegistry", "workspaceConfig"],
		async (_ctx, { toolName, input }: { toolName: string; input: Record<string, any> }) => {
			const toolDef = ALL_TOOLS[toolName];
			if (!toolDef) return { ok: false as const, error: `Tool not found: ${toolName}`, elapsedMs: 0 };

			const execute = getToolExecute(toolDef);
			if (!execute) return { ok: false as const, error: `Tool not testable: ${toolName}`, elapsedMs: 0 };

			const config = (_ctx.toolRegistry as any).getToolConfig();
			const toolCtx: ToolExecutionContext = {
				workingDir: _ctx.workspaceConfig.workspaceDir,
				agentId: "__test__",
				emit: () => {},
				db: _ctx.sessionDb,
				readScope: _ctx.workspaceConfig.readScope ?? "filesystem",
				toolConfig: config,
			};

			const t0 = Date.now();
			try {
				const result = await execute(input, toolCtx);
				return { ok: true as const, result, elapsedMs: Date.now() - t0 };
			} catch (err: any) {
				return { ok: false as const, error: err.message, elapsedMs: Date.now() - t0 };
			}
		},
	);

	// ── WebFetch Cookie Login ──────────────────────────────────
	// Note: Some sites (like okjike.com) use localStorage instead of cookies for auth.
	// The login window still serves a purpose: the persist:webfetch session stores
	// localStorage data, which browser rendering mode uses automatically.
	// Cookie extraction is a bonus for sites that DO use cookies.
	typedHandle("webfetch:login", [], async (_ctx, url: string) => {
		try {
			const hostname = new URL(url).hostname;
			const win = new BrowserWindow({
				width: 1000,
				height: 700,
				title: "Login — " + hostname,
				webPreferences: {
					partition: "persist:webfetch",
					nodeIntegration: false,
					contextIsolation: true,
				},
			});
			await win.loadURL(url);

			// Capture cookies before window is destroyed
			let capturedCookies: Electron.Cookie[] = [];
			await new Promise<void>((resolve) => {
				win.on("close", (e) => {
					e.preventDefault();
					win.webContents.session.cookies.get({}).then((cookies) => {
						capturedCookies = cookies;
						win.destroy();
						resolve();
					}).catch(() => {
						win.destroy();
						resolve();
					});
				});
			});

			// Filter and import cookies for relevant domains
			const relevant = capturedCookies.filter((c) => {
				const d = c.domain.replace(/^\./, "");
				return d === hostname || hostname.endsWith("." + d);
			});

			let totalImported = 0;
			const byDomain = new Map<string, Electron.Cookie[]>();
			for (const c of relevant) {
				const d = c.domain.replace(/^\./, "");
				if (!byDomain.has(d)) byDomain.set(d, []);
				byDomain.get(d)!.push(c);
			}
			for (const [domain, cookies] of byDomain) {
				totalImported += importCookies(
					domain,
					cookies.map((c) => ({
						name: c.name,
						value: c.value,
						expires: c.expirationDate ? Math.floor(c.expirationDate * 1000) : 0,
						path: c.path ?? "/",
					})),
				);
			}
			return { ok: true, cookieCount: totalImported };
		} catch (err: any) {
			return { ok: false, cookieCount: 0, error: err.message };
		}
	});

	typedHandle("webfetch:cookies", [], () => {
		return getCookieCount();
	});

	typedHandle("webfetch:clear-cookies", [], (_ctx, domain?: string) => {
		clearCookies(domain);
	});
}
