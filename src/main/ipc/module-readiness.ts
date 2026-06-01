// ---------------------------------------------------------------------------
// Per-module readiness tracker
// IPC handlers await individual modules instead of a global boolean.
// ---------------------------------------------------------------------------

export type ModuleName =
	| "sessionDb"
	| "agentStore"
	| "providerStore"
	| "templateStore"
	| "mcpStore"
	| "kbStore"
	| "kbDb"
	| "agentToolStore"
	| "workspaceConfig"
	| "registry"
	| "toolRegistry"
	| "agentService"
	| "mcpManager"
	| "recovery";

interface ModuleEntry {
	promise: Promise<void>;
	resolve: () => void;
	resolved: boolean;
}

const entries = new Map<ModuleName, ModuleEntry>();

function createSlot(name: ModuleName): void {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	entries.set(name, { promise, resolve, resolved: false });
}

export const moduleReadiness = {
	initAllSlots(names: ModuleName[]): void {
		for (const name of names) createSlot(name);
	},

	resolveModule(name: ModuleName): void {
		const entry = entries.get(name);
		if (entry && !entry.resolved) {
			entry.resolved = true;
			entry.resolve();
		}
	},

	resolveModules(names: ModuleName[]): void {
		for (const name of names) moduleReadiness.resolveModule(name);
	},

	async whenReady(name: ModuleName): Promise<void> {
		const entry = entries.get(name);
		if (!entry || entry.resolved) return;
		await entry.promise;
	},

	isReady(name: ModuleName): boolean {
		return entries.get(name)?.resolved ?? false;
	},

	async whenAllReady(): Promise<void> {
		for (const entry of entries.values()) {
			if (!entry.resolved) await entry.promise;
		}
	},
};
