// Shared subagent → display-name resolution for the task views.
//
//  - Real named delegation (Subagent tool with a target) → that agent's name.
//  - Synthetic `<parent>:sub` (Subagent tool WITHOUT a target) → the PARENT
//    agent's name (a default sub-agent runs under the parent's identity, so
//    showing the parent's name is the least-surprise default).
//  - `role:<name>` (Orchestrate dispatch) → `<name>` (prefix "role" isn't an
//    agent id, so the suffix — the role name — is what's meaningful).
//  - genuinely absent (legacy / transient) → "subagent" last resort.
//
// Used by TaskTreePanel (middle column) and TaskDetailView (right info bar)
// so both agree on the label.

export function resolveAgentLabel(
	targetAgentId: string | undefined,
	agentNameById: Map<string, string>,
): string {
	if (!targetAgentId) return "subagent";
	const exact = agentNameById.get(targetAgentId);
	if (exact) return exact;
	const i = targetAgentId.lastIndexOf(":");
	if (i >= 0) {
		const prefix = targetAgentId.slice(0, i);
		const parentName = agentNameById.get(prefix);
		if (parentName) return parentName;
		return targetAgentId.slice(i + 1);
	}
	return targetAgentId;
}
