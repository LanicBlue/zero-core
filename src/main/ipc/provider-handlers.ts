// LLM Provider IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理 LLM Provider 的 CRUD 和模型列表查询 IPC 请求
//
// ## 输入
// Provider、CreateProviderInput、UpdateProviderInput
//
// ## 输出
// Provider 列表、模型列表、CRUD 操作结果
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，管理 AI 提供商配置
//
// ## 依赖
// typed-ipc.ts、providerStore、shared/types.ts
//
// ## 维护规则
// Provider 配置字段变更需同步更新 shared/types.ts
//
import { registerCrud, typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { Provider, CreateProviderInput, UpdateProviderInput, ProviderModel } from "../../shared/types.js";

export function registerProviderHandlers(ctx: IpcContext): void {
	registerCrud<Provider, CreateProviderInput, UpdateProviderInput>({
		channel: "providers",
		store: () => ctx.providerStore as any,
		module: "providerStore",
	});

	typedHandle("providers:add-model", "providerStore",
		(_ctx, providerId: string, model: ProviderModel) => {
			try { return (_ctx.providerStore as any).addModel(providerId, model); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("providers:remove-model", "providerStore",
		(_ctx, providerId: string, modelId: string) => {
			try { return (_ctx.providerStore as any).removeModel(providerId, modelId); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("providers:fetch-models", "providerStore",
		async (_ctx, providerId: string) => {
			const provider = (_ctx.providerStore as any).get(providerId) as Provider | undefined;
			if (!provider || !provider.apiKey) return [];
			try {
				const baseUrl = provider.baseUrl.replace(/\/+$/, "");
				const url = provider.type === "anthropic"
					? `${baseUrl}/v1/models`
					: `${baseUrl}/models`;
				const headers: Record<string, string> = {};
				if (provider.type === "anthropic") {
					headers["x-api-key"] = provider.apiKey;
					headers["anthropic-version"] = "2023-06-01";
				} else {
					headers["Authorization"] = `Bearer ${provider.apiKey}`;
				}
				const resp = await fetch(url, { headers });
				if (!resp.ok) return [];
				const json = await resp.json() as any;
				const rawModels = json.data || json.models || [];
				return rawModels.map((m: any) => ({
					id: m.id || m.name,
					name: m.name || m.id || m.display_name,
					group: m.owned_by || undefined,
				}));
			} catch {
				return [];
			}
		},
	);

	typedHandle("models:list", "providerStore",
		(_ctx) => {
			const providers = (_ctx.providerStore as any).list() as Provider[];
			const models: { provider: string; id: string; name: string; contextWindow?: number; maxTokens?: number }[] = [];
			for (const p of providers) {
				if (!p.enabled) continue;
				for (const m of p.models) {
					models.push({
						provider: p.name,
						id: m.id,
						name: m.name || m.id,
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
					});
				}
			}
			return models;
		},
	);
}
