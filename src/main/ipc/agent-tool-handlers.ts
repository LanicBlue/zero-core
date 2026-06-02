import { registerCrud, typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";
import type { AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput } from "../../shared/types.js";

export function registerAgentToolHandlers(ctx: IpcContext): void {
	registerCrud<AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput>({
		channel: "agent-tools",
		store: () => ctx.agentToolStore as any,
		module: "agentToolStore",
		afterMutation: refreshAgentTools,
	});

	typedHandle("agent-tools:get-by-agent", "agentToolStore",
		(_ctx, agentId: string) => _ctx.agentToolStore.getByAgentId(agentId),
	);
}
