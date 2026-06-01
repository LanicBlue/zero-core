// ---------------------------------------------------------------------------
// Typed IPC registration helpers.
// Provides type-safe handler registration with automatic module readiness.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import type { IpcChannelDefs, Params, Result } from "../../shared/ipc-api.js";
import type { IpcContext } from "./types.js";
import type { ModuleName } from "./module-readiness.js";

// ── typedHandle ─────────────────────────────────────────────────────────────

/**
 * Register a type-safe IPC handler with automatic module readiness.
 * The handler receives the IpcContext and typed params, and must return the typed result.
 */
export function typedHandle<K extends string & keyof IpcChannelDefs>(
	channel: K,
	modules: ModuleName | ModuleName[],
	handler: (ctx: IpcContext, ...args: Params<K>) => Promise<Result<K>> | Result<K>,
): void {
	ipcMain.handle(channel, async (_e, ...args: Params<K>) => {
		const ctx = getCtx();
		const mods = Array.isArray(modules) ? modules : [modules];
		await Promise.all(mods.map((m) => ctx.whenReady(m)));
		return handler(ctx, ...args);
	});
}

// ── registerCrud ────────────────────────────────────────────────────────────

/**
 * Interface for stores that follow the standard CRUD pattern.
 */
export interface CrudStore<T extends { id: string }, Create, Update> {
	list(): T[];
	get(id: string): T | undefined;
	create(input: Create): T;
	update(id: string, input: Update): T;
	delete(id: string): void;
}

/**
 * Auto-register 5 CRUD channels: {prefix}:list, :get, :create, :update, :delete
 */
export function registerCrud<
	T extends { id: string },
	Create,
	Update,
>(opts: {
	channel: string;
	store: () => CrudStore<T, Create, Update>;
	module: ModuleName;
	afterMutation?: () => void;
}): void {
	const { channel, store, module, afterMutation } = opts;

	const ready = () => getCtx().whenReady(module);

	ipcMain.handle(`${channel}:list`, async () => {
		await ready();
		return store().list();
	});

	ipcMain.handle(`${channel}:get`, async (_e, id: string) => {
		await ready();
		return store().get(id);
	});

	ipcMain.handle(`${channel}:create`, async (_e, input: Create) => {
		await ready();
		const result = store().create(input);
		afterMutation?.();
		return result;
	});

	ipcMain.handle(`${channel}:update`, async (_e, id: string, input: Update) => {
		await ready();
		try {
			const result = store().update(id, input);
			afterMutation?.();
			return result;
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	ipcMain.handle(`${channel}:delete`, async (_e, id: string) => {
		await ready();
		store().delete(id);
		afterMutation?.();
		return { success: true as const };
	});
}

// ── Lazy IpcContext access ──────────────────────────────────────────────────
// Handlers are registered before loadCoreModules populates the context,
// so we resolve the context lazily through the shared singleton.

let _getContext: (() => IpcContext) | null = null;

export function setContextGetter(getter: () => IpcContext): void {
	_getContext = getter;
}

function getCtx(): IpcContext {
	if (!_getContext) throw new Error("typed-ipc: context getter not initialized");
	return _getContext();
}
