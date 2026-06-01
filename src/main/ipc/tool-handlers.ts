import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

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
			meta: d.meta,
		})),
	);

	typedHandle("tool-config:get", "toolRegistry",
		(_ctx) => (_ctx.toolRegistry as any).getToolConfig(),
	);

	typedHandle("tool-config:save", "toolRegistry",
		(_ctx, config) => { (_ctx.toolRegistry as any).saveToolConfig(config); },
	);
}
