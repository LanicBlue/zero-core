import { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";

type ToolPolicy = {
	autoApprove?: string[];
	blockedTools?: string[];
	tools?: Record<string, { enabled?: boolean }>;
};

type ToolMetaLike = {
	requiresConfirmation?: boolean;
	isDestructive?: boolean;
};

function isPreApprovedTool(toolName: string, policy?: ToolPolicy): boolean {
	if (!policy) return false;
	if (policy.blockedTools?.includes(toolName)) return false;
	if (policy.autoApprove?.includes("*") || policy.autoApprove?.includes(toolName)) return true;
	return policy.tools?.[toolName]?.enabled === true;
}

function needsExecutionApproval(meta?: ToolMetaLike): boolean {
	return !!(meta?.requiresConfirmation || meta?.isDestructive);
}

export function evaluateToolExecutionApproval(input: {
	toolName: string;
	toolMeta?: ToolMetaLike;
	toolPolicy?: ToolPolicy;
}): { approved: boolean; reason?: string } {
	const { toolName, toolMeta, toolPolicy } = input;
	if (toolPolicy?.blockedTools?.includes(toolName)) {
		return { approved: false, reason: `Tool "${toolName}" is blocked by agent policy` };
	}
	if (!needsExecutionApproval(toolMeta)) return { approved: true };
	if (isPreApprovedTool(toolName, toolPolicy)) return { approved: true };
	return {
		approved: false,
		reason: `Tool "${toolName}" requires pre-approval. Authorize it through the agent toolPolicy (autoApprove or tools.${toolName}.enabled) after the requirement/plan gate approves this direction.`,
	};
}

export function registerExecutionApprovalHooks(): void {
	HookRegistry.getInstance().register("PreToolUse", async (ctx) => {
		const toolMeta = ctx.toolMeta as ToolMetaLike | undefined;
		// AgentLoop also emits PreToolUse for UI/recording before the wrapper has
		// tool metadata. The approval hook only gates the wrapper-side event.
		if (!toolMeta) return;

		const decision = evaluateToolExecutionApproval({
			toolName: String(ctx.toolName ?? ""),
			toolMeta,
			toolPolicy: ctx.toolPolicy as ToolPolicy | undefined,
		});
		if (!decision.approved) {
			log.debug("tool-approval", decision.reason ?? "tool denied by execution policy");
			return { blocked: true, reason: decision.reason ?? "Tool denied by execution policy" };
		}
	});
}