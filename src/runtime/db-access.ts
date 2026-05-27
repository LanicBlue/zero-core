import type { SessionDB } from "../server/session-db.js";

let _db: SessionDB | null = null;

export function setSessionDB(db: SessionDB): void {
	_db = db;
}

export function getSessionDB(): SessionDB | null {
	return _db;
}
