import type { IKVStore } from "../core/kv-store-interface.js";

/**
 * Interface for session/message persistence.
 * Runtime layer uses this instead of depending on server/SessionDB.
 */
export interface ISessionStore {
	getMessages(sessionId: string): any[];
	saveTurn(sessionId: string, messages: any[]): void;
	getTurns(sessionId: string): Array<{ seq: number; role: string; content: string | null }>;
	appendTurn(sessionId: string, seq: number, role: string, content: string | null): void;
	getTurnCount(sessionId: string): number;
	getMainSession(agentId: string): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string } | undefined;
	createSession(agentId: string, title?: string): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string };
	setMainSession(agentId: string, sessionId: string): void;
	listSessions(agentId: string): Array<{ id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string }>;
	deleteSession(sessionId: string): void;
	updateTurnContent(sessionId: string, seq: number, content: string): void;
	getKVStore(): IKVStore;
	getMemoryStore(): any;
}
