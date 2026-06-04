// ---------------------------------------------------------------------------
// Per-module readiness tracker
// IPC handlers await individual modules instead of a global boolean.
// Supports both resolve (success) and reject (failure) paths.
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
	reject: (err: Error) => void;
	resolved: boolean;
	failed: boolean;
	error?: Error;
}

const entries = new Map<ModuleName, ModuleEntry>();

function createSlot(name: ModuleName): void {
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((r, j) => { resolve = r; reject = j; });
	entries.set(name, { promise, resolve, reject, resolved: false, failed: false });
}

export const moduleReadiness = {
	initAllSlots(names: ModuleName[]): void {
		for (const name of names) createSlot(name);
	},

	resolveModule(name: ModuleName): void {
		const entry = entries.get(name);
		if (entry && !entry.resolved && !entry.failed) {
			entry.resolved = true;
			entry.resolve();
		}
	},

	resolveModules(names: ModuleName[]): void {
		for (const name of names) moduleReadiness.resolveModule(name);
	},

	rejectModule(name: ModuleName, error: Error): void {
		const entry = entries.get(name);
		if (entry && !entry.resolved && !entry.failed) {
			entry.failed = true;
			entry.error = error;
			entry.reject(error);
		}
	},

	rejectModules(names: ModuleName[], error: Error): void {
		for (const name of names) moduleReadiness.rejectModule(name, error);
	},

	async whenReady(name: ModuleName): Promise<void> {
		const entry = entries.get(name);
		if (!entry || entry.resolved) return;
		if (entry.failed) throw entry.error;
		await entry.promise;
	},

	isReady(name: ModuleName): boolean {
		return entries.get(name)?.resolved ?? false;
	},

	isFailed(name: ModuleName): boolean {
		return entries.get(name)?.failed ?? false;
	},

	async whenAllReady(): Promise<void> {
		for (const entry of entries.values()) {
			if (entry.resolved) continue;
			if (entry.failed) throw entry.error;
			await entry.promise;
		}
	},

	getFailedModules(): Array<{ name: ModuleName; error: Error }> {
		const failed: Array<{ name: ModuleName; error: Error }> = [];
		for (const [name, entry] of entries) {
			if (entry.failed && entry.error) failed.push({ name, error: entry.error });
		}
		return failed;
	},
};
