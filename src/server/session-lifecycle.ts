export type SessionLifecycleState =
	| "created"
	| "idle"
	| "queued"
	| "streaming"
	| "executing_tools"
	| "error"
	| "disposed";

export const VALID_TRANSITIONS: Record<SessionLifecycleState, SessionLifecycleState[]> = {
	created:         ["idle", "disposed"],
	idle:            ["queued", "streaming", "disposed"],
	queued:          ["streaming", "error", "disposed"],
	streaming:       ["executing_tools", "idle", "error", "disposed"],
	executing_tools: ["streaming", "idle", "error", "disposed"],
	error:           ["idle", "disposed"],
	disposed:        [],
};

export function isValidTransition(from: SessionLifecycleState, to: SessionLifecycleState): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
