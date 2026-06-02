import { join } from "node:path";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { SearchProviderConfig } from "../../shared/types.js";

export function registerSearchProviderHandlers(ctx: IpcContext): void {
	typedHandle("search-provider:get", ["workspaceConfig"],
		(_ctx) => {
			return _ctx.workspaceConfig.searchProvider ?? { type: "duckduckgo" };
		},
	);

	typedHandle("search-provider:set", ["workspaceConfig", "sessionDb"],
		async (_ctx, config) => {
			_ctx.workspaceConfig = _ctx.saveWorkspaceConfig({ searchProvider: config }, _ctx.sessionDb);
			try {
				const runtimeToolsDir = join(_ctx.distServer, "..", "runtime", "tools");
				const { createSearchProvider, setSearchProvider } = await import(
					_ctx.toFileURL(join(runtimeToolsDir, "web-search.js"))
				);
				setSearchProvider(createSearchProvider(config));
				return { success: true as const };
			} catch (err) {
				return { error: (err as Error).message };
			}
		},
	);
}
