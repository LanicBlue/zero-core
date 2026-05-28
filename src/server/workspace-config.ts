import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionDB } from "../server/session-db.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// Workspace configuration — backed by SQLite kv_store
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
	workspaceDir: string;
	defaultModel?: string;
	defaultProvider?: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
	workspaceDir: join(ZERO_CORE_DIR, "workspace"),
};

const KV_KEY = "workspace";

export function loadWorkspaceConfig(db?: SessionDB): WorkspaceConfig {
	if (!db) return { ...DEFAULT_CONFIG };

	const kv = db.getKVStore();
	const stored = kv.getJson<WorkspaceConfig>(KV_KEY);
	return stored ? { ...DEFAULT_CONFIG, ...stored } : { ...DEFAULT_CONFIG };
}

export function saveWorkspaceConfig(config: Partial<WorkspaceConfig>, db: SessionDB): WorkspaceConfig {
	const current = loadWorkspaceConfig(db);
	const updated = { ...current, ...config };

	db.getKVStore().setJson(KV_KEY, updated);
	return updated;
}
