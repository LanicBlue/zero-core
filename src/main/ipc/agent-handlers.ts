import { registerCrud } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";
import type { AgentRecord, CreateAgentInput, UpdateAgentInput } from "../../shared/types.js";

export function registerAgentHandlers(ctx: IpcContext): void {
	registerCrud<AgentRecord, CreateAgentInput, UpdateAgentInput>({
		channel: "agents",
		store: () => ctx.agentStore as any,
		module: "agentStore",
		afterMutation: refreshAgentTools,
	});
}
