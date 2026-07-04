// Flow action tool (project-flow F1) — requirement → code-merge unified flow
//
// # File spec
//
// ## Core
// F1 cornerstone of the project-flow redesign (see
// docs/design/project-flow/project-flow.md §2/§4). One action-switched tool
// `Flow` that, for this stage, exposes only `create` / `list` / `get`. Later
// stages (F2/F3) add the transition actions (pick/ready/plan/startBuild/
// finishBuild/verify) plus the explicit named-hook signal mechanism.
//
// Stage F1 scope:
//   - create  → write RequirementRecord at status="found" AND write the
//               requirement document's Intent section to
//               `{workspace}/docs/requirements/{id}.md` (server-side fs; the
//               doc is a FILE, never enters the DB). The natural
//               `requirements.create` op (emitted by SqliteStore → hub on every
//               store.create) doubles as the `created` signal — no extra emit.
//   - list    → filter by projectId / status / priority.
//   - get     → return a single record (record only; messages excluded).
//
// Old CreateRequirement / CreateRequirementWithDoc / verify stay registered in
// parallel — F1 does NOT replace them.
//
// ## Naming
// `Flow` covers the requirement→code-merge flow as one action tool. Capability
// lives in the tool; whether an action is exposed to an agent vs. only to a
// user is a toolPolicy concern, not a structural one.
//
// ## Inputs
// - ctx.requirementStore (RequirementStore — required; tool stays gated off
//   otherwise via CONDITIONAL_TOOLS).
// - ctx.contextBundle.workspaceDir OR ctx.workingDir (resolved workspace for
//   the docs/requirements/{id}.md write).
//
// ## Output
// - export const flowTool (buildTool result).
//

import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTool } from "./tool-factory.js";
import type { RequirementRecord } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Flat action schema — one tool, multiple actions
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object (NOT z.discriminatedUnion), matching the
// project-tool.ts / agent-registry.ts pattern. LLM tool-calling protocols
// (OpenAI/GLM/Anthropic function-calling) require the top-level parameters
// schema to be `type: object`; a top-level `oneOf`/discriminated union is
// dropped or mis-parsed by most providers, so the model calls the tool with
// `{}` and zod then rejects it. The action enum validates the discriminator;
// per-action required fields are checked at runtime inside execute.

export const flowActionSchema = z.object({
	action: z.enum(["create", "list", "get"]),
	// create
	projectId: z.string().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	priority: z.enum(["low", "normal", "high", "critical"]).optional(),
	impactScope: z.string().optional(),
	// list / get
	status: z.string().optional(),
	id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the workspace dir for the docs/requirements write. */
function resolveWorkspaceDir(ctx: any): string | undefined {
	const bundle = ctx?.contextBundle;
	if (bundle && typeof bundle.workspaceDir === "string" && bundle.workspaceDir) {
		return bundle.workspaceDir;
	}
	const wd = ctx?.workingDir;
	return typeof wd === "string" && wd ? wd : undefined;
}

/** Build the absolute path of a requirement doc (file, lives under docs/). */
function requirementDocPath(workspaceDir: string, id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

/** Write the Intent section to the requirement doc (create action side effect). */
function writeIntentDoc(workspaceDir: string, req: RequirementRecord): void {
	const absPath = requirementDocPath(workspaceDir, req.id);
	mkdirSync(dirname(absPath), { recursive: true });
	const title = req.title ?? "(untitled)";
	const intent = req.description?.trim() ?? "";
	const body =
		`# ${title}\n\n` +
		`> Requirement: ${req.id} · status: ${req.status}${req.priority ? ` · priority: ${req.priority}` : ""}\n\n` +
		`## Intent\n\n${intent || "(no description provided)"}\n`;
	writeFileSync(absPath, body, "utf-8");
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const flowTool = buildTool({
	name: "Flow",
	description:
		"Requirement → code-merge unified flow tool. F1 scope: create/list/get.",
	prompt:
		"Manage the project requirement flow via a single action-switched tool (project-flow).\n\n" +
		"F1 actions:\n" +
		"- { action:'create', projectId, title, description?, priority?, impactScope? } — log a new requirement at status='found' AND write its Intent section to `{workspace}/docs/requirements/{id}.md` (the doc is a file, never the DB). Emitting the natural `requirements.create` (the `created` signal).\n" +
		"- { action:'list', projectId?, status?, priority? } — list requirements (filterable by project/status/priority).\n" +
		"- { action:'get', id } — read one requirement record (record only; messages excluded).\n\n" +
		"Later stages add pick/ready/plan/startBuild/finishBuild/verify transitions.",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},

	inputSchema: flowActionSchema,

	execute: async (input, ctx) => {
		const store = (ctx as any)?.requirementStore;
		if (!store) {
			return "Error: Flow tool requires ctx.requirementStore";
		}

		switch (input.action) {
			case "create": {
				const projectId =
					(ctx as any)?.contextBundle?.projectId ?? (ctx as any)?.projectId ?? input.projectId;
				if (!projectId) {
					return "Error: projectId is required for action:create (provide it on the call or via the session context bundle)";
				}
				if (!input.title) {
					return "Error: title is required for action:create";
				}
				const priority = input.priority ?? "normal";
				// RequirementSource is typed "analyst" | "user"; the project-flow
				// plan suggests source:"agent" but that fails type gates and the
				// status-machine history derivation rule in RequirementStore
				// (input.source === "user" ? "user" : "analyst"). Use "analyst"
				// for now; the agent-vs-analyst collapse is deferred to F3.
				const source = "analyst" as const;
				const reviewer = "analyst" as const;

				const req = store.create({
					projectId,
					title: input.title,
					description: input.description,
					status: "found",
					source,
					priority,
					impactScope: input.impactScope,
					reviewer,
				}) as RequirementRecord;

				// Write the Intent section of the requirement doc to the workspace
				// (server-side fs; the doc is a FILE and never enters the DB).
				const ws = resolveWorkspaceDir(ctx);
				if (ws) {
					try {
						writeIntentDoc(ws, req);
					} catch (err) {
						// Best-effort: record creation must succeed even if the doc
						// write fails (workspace unresolvable / disk error).
						return `Requirement created: ${req.id} (doc write failed: ${(err as Error).message})\nTitle: ${req.title}\nStatus: ${req.status}`;
					}
				}

				return `Requirement created: ${req.id}\nTitle: ${req.title}\nStatus: ${req.status}`;
			}

			case "list": {
				const result = store.list({
					projectId: input.projectId,
					status: input.status,
					priority: input.priority,
				}) as RequirementRecord[];
				return JSON.stringify(result);
			}

			case "get": {
				if (!input.id) {
					return "Error: id is required for action:get";
				}
				const result = store.get(input.id) as RequirementRecord | undefined;
				if (!result) {
					return `Error: Requirement not found: ${input.id}`;
				}
				return JSON.stringify(result);
			}

			default:
				return `Error: unknown action: ${(input as any).action}`;
		}
	},
});
