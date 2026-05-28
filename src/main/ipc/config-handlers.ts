import { ipcMain } from "electron";
import { resolve, join } from "path";
import { existsSync, mkdirSync } from "node:fs";
import type { IpcContext } from "./types.js";

export function registerConfigHandlers(ctx: IpcContext): void {
	ipcMain.handle("config:get", () => {
		if (!ctx.modulesReady) return { workspaceDir: "", defaultPrompt: "", loading: true };
		return { ...ctx.workspaceConfig, defaultPrompt: ctx.buildDefaultPrompt("Agent") };
	});

	ipcMain.handle("config:update", (_e, data: { workspaceDir?: string; defaultModel?: string; defaultProvider?: string }) => {
		if (!ctx.modulesReady) return { error: "loading" };
		if (typeof data.workspaceDir === "string") {
			const abs = resolve(data.workspaceDir);
			if (!existsSync(abs)) {
				try { mkdirSync(abs, { recursive: true }); } catch {
					return { error: "Cannot create directory" };
				}
			}
			ctx.workspaceConfig = ctx.saveWorkspaceConfig({ workspaceDir: abs }, ctx.sessionDb);
		}
		if (data.defaultModel !== undefined || data.defaultProvider !== undefined) {
			ctx.workspaceConfig = ctx.saveWorkspaceConfig({ defaultModel: data.defaultModel, defaultProvider: data.defaultProvider }, ctx.sessionDb);
		}
		return ctx.workspaceConfig;
	});

	// ─── Device Context ─────────────────────────────
	ipcMain.handle("device-context:get", async () => {
		if (!ctx.modulesReady) return { content: "", loading: true };
		const { loadDeviceContext } = await import(ctx.toFileURL(join(ctx.distCore, "device-context.js")));
		return { content: loadDeviceContext(ctx.sessionDb.getKVStore()) };
	});

	ipcMain.handle("device-context:generate", async () => {
		if (!ctx.modulesReady) return { content: "", error: "loading" };
		const { generateAndSaveDeviceContext } = await import(ctx.toFileURL(join(ctx.distCore, "device-context.js")));
		try {
			const content = generateAndSaveDeviceContext(ctx.sessionDb.getKVStore());
			return { content };
		} catch (err: any) {
			return { content: "", error: err.message };
		}
	});

	ipcMain.handle("device-context:save", async (_e, content: string) => {
		if (!ctx.modulesReady) return { error: "loading" };
		const { saveDeviceContext } = await import(ctx.toFileURL(join(ctx.distCore, "device-context.js")));
		try {
			saveDeviceContext(content, ctx.sessionDb.getKVStore());
			return { success: true };
		} catch (err: any) {
			return { error: err.message };
		}
	});

	// ─── Guidelines ─────────────────────────────────
	ipcMain.handle("guidelines:get", async () => {
		if (!ctx.modulesReady || !ctx.agentService) return { guidelines: [], defaults: [] };
		const { loadConfig, DEFAULT_GUIDELINES } = await import(ctx.toFileURL(join(ctx.distCore, "config.js")));
		const config = loadConfig(process.cwd(), undefined, ctx.sessionDb.getKVStore());
		const guidelines = config.systemPrompt?.guidelines;
		return { guidelines: guidelines ?? DEFAULT_GUIDELINES, defaults: DEFAULT_GUIDELINES, isDefault: !guidelines };
	});

	ipcMain.handle("guidelines:save", async (_e, guidelines: string[]) => {
		if (!ctx.modulesReady) return { error: "loading" };
		try {
			const kv = ctx.sessionDb?.getKVStore();
			if (!kv) return { error: "db not available" };
			let configData: any = kv.getJson("global_config") ?? {};
			if (!configData.systemPrompt) configData.systemPrompt = {};
			configData.systemPrompt.guidelines = guidelines;
			kv.setJson("global_config", configData);
			return { success: true };
		} catch {
			return { error: "failed to save guidelines" };
		}
	});

	// ─── Theme ────────────────────────────────────
	ipcMain.handle("config:get-theme", () => {
		try {
			const stored = ctx.sessionDb?.getKVStore().getJson<{ mode: string; customPrimaryColor?: string }>("theme");
			return stored ?? { mode: "dark", customPrimaryColor: null };
		} catch {
			return { mode: "dark", customPrimaryColor: null };
		}
	});
	ipcMain.handle("config:set-theme", (_e, data) => {
		try {
			ctx.sessionDb?.getKVStore().setJson("theme", data);
			return { success: true };
		} catch {
			return { error: "failed to save theme" };
		}
	});
}
