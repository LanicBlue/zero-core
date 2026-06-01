export type SessionLifecycleState = "created" | "idle" | "busy" | "disposed";

export const VALID_TRANSITIONS: Record<SessionLifecycleState, SessionLifecycleState[]> = {
	created:  ["idle", "disposed"],
	idle:     ["busy", "disposed"],
	busy:     ["idle", "disposed"],
	disposed: [],
};

export function isValidTransition(from: SessionLifecycleState, to: SessionLifecycleState): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
