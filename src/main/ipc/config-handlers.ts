// 配置 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// 配置相关的 IPC 处理器，处理配置获取和更新。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - 配置数据
//
// ## 定位
// IPC 处理器，被 core.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - node:fs - 文件系统
//
// ## 维护规则
// - 配置结构变更时需同步更新
// - 保持与前端 API 一致
//
import { resolve, join } from "path";
import { existsSync, mkdirSync } from "node:fs";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerConfigHandlers(ctx: IpcContext): void {
	typedHandle("config:get", "workspaceConfig",
		(_ctx) => ({ ..._ctx.workspaceConfig, defaultPrompt: _ctx.buildDefaultPrompt("Agent") }),
	);

	typedHandle("config:update", ["workspaceConfig", "sessionDb"],
		(_ctx, data) => {
			if (typeof data.workspaceDir === "string") {
				const abs = resolve(data.workspaceDir);
				if (!existsSync(abs)) {
					try { mkdirSync(abs, { recursive: true }); } catch {
						return _ctx.workspaceConfig;
					}
				}
				_ctx.workspaceConfig = _ctx.saveWorkspaceConfig({ workspaceDir: abs }, _ctx.sessionDb);
			}
			if (data.defaultModel !== undefined || data.defaultProvider !== undefined) {
				_ctx.workspaceConfig = _ctx.saveWorkspaceConfig({ defaultModel: data.defaultModel, defaultProvider: data.defaultProvider }, _ctx.sessionDb);
			}
			if (data.proxy !== undefined) {
				_ctx.workspaceConfig = _ctx.saveWorkspaceConfig({ proxy: data.proxy }, _ctx.sessionDb);
				import(_ctx.toFileURL(join(_ctx.distServer, "../runtime/proxy-manager.js"))).then((m) => m.applyProxy(data.proxy));
			}
			return _ctx.workspaceConfig;
		},
	);

	typedHandle("device-context:get", "sessionDb",
		async (_ctx) => {
			const { loadDeviceContext } = await import(_ctx.toFileURL(join(_ctx.distCore, "device-context.js")));
			return { content: loadDeviceContext(_ctx.sessionDb.getKVStore()) };
		},
	);

	typedHandle("device-context:generate", "sessionDb",
		async (_ctx) => {
			const { generateAndSaveDeviceContext } = await import(_ctx.toFileURL(join(_ctx.distCore, "device-context.js")));
			try {
				const content = generateAndSaveDeviceContext(_ctx.sessionDb.getKVStore());
				return { content };
			} catch (err: any) {
				return { content: "", error: err.message };
			}
		},
	);

	typedHandle("device-context:save", "sessionDb",
		async (_ctx, content) => {
			const { saveDeviceContext } = await import(_ctx.toFileURL(join(_ctx.distCore, "device-context.js")));
			try {
				saveDeviceContext(content, _ctx.sessionDb.getKVStore());
				return { success: true as const };
			} catch (err: any) {
				return { error: err.message };
			}
		},
	);

	typedHandle("guidelines:get", ["agentService", "sessionDb"],
		async (_ctx) => {
			const { loadConfig, DEFAULT_GUIDELINES } = await import(_ctx.toFileURL(join(_ctx.distCore, "config.js")));
			const config = loadConfig(process.cwd(), undefined, _ctx.sessionDb.getKVStore());
			const guidelines = config.systemPrompt?.guidelines;
			return { guidelines: guidelines ?? DEFAULT_GUIDELINES, defaults: DEFAULT_GUIDELINES, isDefault: !guidelines };
		},
	);

	typedHandle("guidelines:save", "sessionDb",
		(_ctx, guidelines) => {
			try {
				const kv = _ctx.sessionDb?.getKVStore();
				if (!kv) return { error: "db not available" };
				let configData: any = kv.getJson("global_config") ?? {};
				if (!configData.systemPrompt) configData.systemPrompt = {};
				configData.systemPrompt.guidelines = guidelines;
				kv.setJson("global_config", configData);
				return { success: true as const };
			} catch {
				return { error: "failed to save guidelines" };
			}
		},
	);

	typedHandle("config:get-theme", ["sessionDb"],
		(_ctx) => {
			try {
				const stored = _ctx.sessionDb?.getKVStore().getJson<{ mode: string; customPrimaryColor?: string }>("theme");
				if (!stored) return { mode: "dark", customPrimaryColor: null };
				return { mode: stored.mode, customPrimaryColor: stored.customPrimaryColor ?? null };
			} catch {
				return { mode: "dark", customPrimaryColor: null };
			}
		},
	);

	typedHandle("config:set-theme", ["sessionDb"],
		(_ctx, data) => {
			try {
				_ctx.sessionDb?.getKVStore().setJson("theme", data);
				return { success: true as const };
			} catch {
				return { error: "failed to save theme" };
			}
		},
	);
}
