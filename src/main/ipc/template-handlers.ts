import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerTemplateHandlers(_ctx: IpcContext): void {
	// Template delete can throw (built-in templates), so all handlers are manual.
	typedHandle("templates:list", "templateStore",
		(ctx) => (ctx.templateStore as any).list(),
	);

	typedHandle("templates:get", "templateStore",
		(ctx, id) => (ctx.templateStore as any).get(id),
	);

	typedHandle("templates:create", "templateStore",
		(ctx, input) => (ctx.templateStore as any).create(input),
	);

	typedHandle("templates:update", "templateStore",
		(ctx, id, input) => {
			try { return (ctx.templateStore as any).update(id, input); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:delete", "templateStore",
		(ctx, id) => {
			try { (ctx.templateStore as any).delete(id); return { success: true as const }; }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:export", "templateStore",
		(ctx, id) => {
			try { return (ctx.templateStore as any).exportTemplate(id); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);

	typedHandle("templates:import", "templateStore",
		(ctx, json) => {
			try { return (ctx.templateStore as any).importTemplate(json); }
			catch (e) { return { error: (e as Error).message }; }
		},
	);
}
