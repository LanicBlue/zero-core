import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CONFIG_PATH = join(homedir(), ".zero-core", "workspace.json");

export interface WorkspaceConfig {
	workspaceDir: string;
	defaultModel?: string;
	defaultProvider?: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = {
	workspaceDir: join(homedir(), ".zero-core", "workspace"),
};

function ensureDir(): void {
	const dir = join(homedir(), ".zero-core");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadWorkspaceConfig(): WorkspaceConfig {
	ensureDir();
	if (!existsSync(CONFIG_PATH)) {
		writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
		return { ...DEFAULT_CONFIG };
	}
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveWorkspaceConfig(config: Partial<WorkspaceConfig>): WorkspaceConfig {
	const current = loadWorkspaceConfig();
	const updated = { ...current, ...config };
	writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
	return updated;
}
