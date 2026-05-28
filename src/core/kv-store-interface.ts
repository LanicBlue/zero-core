/**
 * Minimal interface for key-value persistence.
 * Core layer uses this instead of depending on server/SessionDB.
 */
export interface IKVStore {
	getJson<T>(key: string): T | null;
	setJson(key: string, value: unknown): void;
	get(key: string): string | null;
	set(key: string, value: string): void;
	delete(key: string): void;
	list(): Array<{ key: string; value: string }>;
}
