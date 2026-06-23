// P3 单元测试:工具重组 — 4 action 工具 + verify + tool_usage
//
// # 文件说明书
//
// ## 核心功能
// 验证 P3 核心交付 (acceptance-P3.md):
//   - 四个判别联合 action 工具各 action 的 schema + 行为 (每个 action 一个用例)
//       * Project (create/update/delete/get/list)
//       * AgentRegistry (create/update/delete/get/list/listTemplates/getTemplate)
//       * Cron (create/update/delete/get/list/trigger)
//       * Wiki (expand/search/create/update/delete + docRead/docWrite/docEdit)
//   - Agent delete zero role agent 被 reject (§7.3 protected)
//   - verify 工具 end-to-end (lead 提交 → PM 判 APPROVED → verdict 返回;
//                              lead 提交 → PM 判 REJECTED → 意见返回,mock delegateTask)
//   - tool_usage 记录写入 (tool-factory recordToolUsage 经 ctx.toolUsageStore)
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores + mock delegateTask。
//
// ## 输出
// Vitest 用例。
//
// ## 边界
// - Cron 三模式调度触发 → P4 (本测试只验 store CRUD + trigger 入口)
// - verify→PM→archivist 端到端闭环 → P7 (本测试 mock delegateTask,不验 archivist)
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { ManagementService } from "../../src/server/management-service.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { ProjectWikiStore } from "../../src/server/project-wiki-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { ToolUsageStore } from "../../src/server/tool-usage-store.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
import { projectTool } from "../../src/runtime/tools/project-tool.js";
import { agentTool } from "../../src/runtime/tools/agent-tool.js";
import { cronTool } from "../../src/runtime/tools/cron-tool.js";
import { wikiTool } from "../../src/runtime/tools/wiki-tool.js";
import { verifyTool } from "../../src/runtime/tools/verify-tool.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";
import type { CronSchedule } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let cronStore: CronStore;
let management: ManagementService;
let wikiStoreGlobal: WikiStore;
let wikiStore: ProjectWikiStore;
let requirementStore: RequirementStore;
let toolUsageStore: ToolUsageStore;

// Get the inner execute (bypasses AI SDK wrapper + hooks/rate-limit, so the
// test drives the action switch directly and asserts on its return string).
const execProject = getToolExecute(projectTool)!;
const execAgent = getToolExecute(agentTool)!;
const execCron = getToolExecute(cronTool)!;
const execWiki = getToolExecute(wikiTool)!;
const execVerify = getToolExecute(verifyTool)!;

const SCHED_DAILY: CronSchedule = { mode: "interval", everyMs: 86_400_000 };

function parse(s: unknown): any {
	return typeof s === "string" ? JSON.parse(s) : s;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p3-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	wikiStoreGlobal = new WikiStore(sessionDB);
	wikiStore = new ProjectWikiStore(wikiStoreGlobal);
	requirementStore = new RequirementStore(sessionDB);
	toolUsageStore = new ToolUsageStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, cronStore });
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Project tool — 5 actions (§8.2)
// ---------------------------------------------------------------------------

describe("Project action tool", () => {
	function ctx(): any {
		return { management };
	}

	test("create", async () => {
		const r = parse(await execProject(
			{ action: "create", name: "P1", workspaceDir: join(tmpDir, "ws1") },
			ctx(),
		));
		expect(r.name).toBe("P1");
		expect(r.id).toBeTruthy();
	});

	test("update (rename)", async () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const r = parse(await execProject({ action: "update", id: p.id, name: "P2" }, ctx()));
		expect(r.name).toBe("P2");
	});

	test("delete", async () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const r = parse(await execProject({ action: "delete", id: p.id }, ctx()));
		expect(r.success).toBe(true);
		expect(management.listProjects().length).toBe(0);
	});

	test("get", async () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const r = parse(await execProject({ action: "get", id: p.id }, ctx()));
		expect(r.id).toBe(p.id);
		// v0.8 (P5 §8.4): includeContext=true now returns the container view
		// (was metadata-only in P3). The container view's `project.id` matches.
		const r2 = parse(await execProject({ action: "get", id: p.id, includeContext: true }, ctx()));
		expect(r2.project.id).toBe(p.id);
		expect(r2.requirementsByStatus).toBeDefined();
		expect(r2.wikiSummary).toBeDefined();
	});

	test("list", async () => {
		management.createProject({ name: "A", workspaceDir: join(tmpDir, "a") });
		management.createProject({ name: "B", workspaceDir: join(tmpDir, "b") });
		const r = parse(await execProject({ action: "list" }, ctx()));
		expect(r.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AgentRegistry tool — 7 actions (§7.3), incl. create-with-template
// ---------------------------------------------------------------------------

describe("AgentRegistry action tool", () => {
	function ctx(): any {
		return { management };
	}

	test("create", async () => {
		const r = parse(await execAgent({ action: "create", name: "MyRole" }, ctx()));
		expect(r.name).toBe("MyRole");
	});

	test("create with template copies identity from preset (replaces InstantiatePreset)", async () => {
		// Template path = the new shape of InstantiatePreset. Requires callee
		// role agents for whitelisted tags to be exposed — seed a few.
		for (const [name, tag] of [["A1", "analyzer"], ["P1", "planner"], ["D1", "developer"], ["R1", "reviewer"], ["Q1", "qa"]] as const) {
			const a = management.createAgent({ name } as any);
			seedAgentWithRoleTag(sessionDB, a.id, tag);
		}
		const r = parse(await execAgent(
			{ action: "create", name: "MyLead", template: "lead" },
			ctx(),
		));
		expect(r.name).toBe("MyLead");
		// Template brings the lead system prompt (copied identity).
		expect(r.systemPrompt).toBeTruthy();
	});

	test("update merges toolPolicy/subagents/wikiAnchors (replaces SetToolPolicy/SetToolEnabled)", async () => {
		const a = management.createAgent({ name: "A" } as any);
		const r = parse(await execAgent({
			action: "update",
			id: a.id,
			toolPolicy: { executionMode: "parallel", tools: { Read: { enabled: true } } },
			subagents: [{ agentId: "other-agent", name: "Helper" }],
			wikiAnchors: [{ nodeId: "n1", inject: "system" }],
		}, ctx()));
		expect(r.toolPolicy.executionMode).toBe("parallel");
		expect(r.toolPolicy.tools.Read.enabled).toBe(true);
		expect(r.subagents.length).toBe(1);
		expect(r.wikiAnchors.length).toBe(1);
	});

	test("delete zero role agent is rejected (§7.3 protected)", async () => {
		const zero = management.createAgent({ name: "zero" } as any);
		seedAgentWithRoleTag(sessionDB, zero.id, "zero");
		const r = await execAgent({ action: "delete", id: zero.id }, ctx());
		// safe() wraps thrown errors as "Error: …" string (does not reject).
		expect(String(r)).toMatch(/protected.*zero/i);
		expect(management.getAgent(zero.id)).toBeDefined();
	});

	test("get", async () => {
		const a = management.createAgent({ name: "A" } as any);
		const r = parse(await execAgent({ action: "get", id: a.id }, ctx()));
		expect(r.id).toBe(a.id);
	});

	test("list", async () => {
		const a = management.createAgent({ name: "A-list-target" } as any);
		const r = parse(await execAgent({ action: "list" }, ctx()));
		expect(r.map((x: any) => x.id)).toContain(a.id);
	});

	test("listTemplates + getTemplate", async () => {
		const list = parse(await execAgent({ action: "listTemplates" }, ctx()));
		expect(list.find((p: any) => p.roleTag === "lead")).toBeTruthy();
		const one = parse(await execAgent({ action: "getTemplate", templateId: "lead" }, ctx()));
		expect(one.roleTag).toBe("lead");
	});
});

// ---------------------------------------------------------------------------
// Cron tool — 6 actions (§9.4); trigger is a P3 stub (P4 lands the run)
// ---------------------------------------------------------------------------

describe("Cron action tool", () => {
	function ctx(): any {
		return { management };
	}

	function mkAgent(): string {
		const a = management.createAgent({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, a.id, "pm");
		return a.id;
	}
	function mkScope(projectId?: string) {
		return { projectId, workspaceDir: join(tmpDir, "ws"), wikiRootNodeId: "wiki-root:test" };
	}

	test("create", async () => {
		const agentId = mkAgent();
		const r = parse(await execCron({
			action: "create", agentId, workingScope: mkScope(), schedule: SCHED_DAILY,
		}, ctx()));
		expect(r.agentId).toBe(agentId);
		expect(r.enabled).toBe(true);
	});

	test("update", async () => {
		const agentId = mkAgent();
		const c = management.createCron({ agentId, workingScope: mkScope(), schedule: SCHED_DAILY });
		const r = parse(await execCron({
			action: "update", id: c.id, enabled: false,
		}, ctx()));
		expect(r.enabled).toBe(false);
	});

	test("delete (unbind, agent stays)", async () => {
		const agentId = mkAgent();
		const c = management.createCron({ agentId, workingScope: mkScope(), schedule: SCHED_DAILY });
		const r = parse(await execCron({ action: "delete", id: c.id }, ctx()));
		expect(r.success).toBe(true);
		expect(management.listCrons().length).toBe(0);
		expect(management.getAgent(agentId)).toBeDefined();
	});

	test("get", async () => {
		const agentId = mkAgent();
		const c = management.createCron({ agentId, workingScope: mkScope(), schedule: SCHED_DAILY });
		const r = parse(await execCron({ action: "get", id: c.id }, ctx()));
		expect(r.id).toBe(c.id);
	});

	test("list (with agentId filter)", async () => {
		const a1 = mkAgent();
		const a2 = mkAgent();
		management.createCron({ agentId: a1, workingScope: mkScope(), schedule: SCHED_DAILY });
		management.createCron({ agentId: a2, workingScope: mkScope(), schedule: SCHED_DAILY });
		expect(parse(await execCron({ action: "list" }, ctx())).length).toBe(2);
		expect(parse(await execCron({ action: "list", agentId: a1 }, ctx())).length).toBe(1);
	});

	test("trigger resolves the cron (P4: tool capability backend just surfaces the row; the real run goes through CronAnalysisManager.triggerCron)", async () => {
		const agentId = mkAgent();
		const c = management.createCron({ agentId, workingScope: mkScope(), schedule: SCHED_DAILY });
		// v0.8 P4: ManagementService.triggerCron no longer owns the run path —
		// it resolves the cron row and surfaces it so the tool/IPC/REST layer
		// can hand off to CronAnalysisManager.triggerCron (which writes
		// cron_runs + leaves next_run untouched per §9.4).
		const r = parse(await execCron({ action: "trigger", id: c.id }, ctx()));
		expect(r.cron).toBeDefined();
		expect(r.cron.id).toBe(c.id);
	});
});

// ---------------------------------------------------------------------------
// Wiki tool — structure ops (expand/search/create/update/delete) + doc ops
// (docRead/docWrite/docEdit). Identity by nodeId; type inherited from parent;
// titles unique per parent. scope = caller anchor union.
// ---------------------------------------------------------------------------

describe("Wiki action tool", () => {
	let projWs: string;
	let projectId: string;

	beforeEach(() => {
		projWs = join(tmpDir, "ws");
		mkdirSync(projWs, { recursive: true });
		const proj = management.createProject({ name: "P", workspaceDir: projWs });
		projectId = proj.id;
		// Lazily create the project subtree root so wiki create has a valid
		// parent scope (the tool's wiki scope = this subtree).
		wikiStoreGlobal.ensureProjectSubtree(projectId, "P");
	});

	function ctx(): any {
		return {
			wikiStore,
			projectId,
			// v0.8 (读写同界): the Wiki tool now reads/writes against the session's
			// resolved anchor set. Scope this project-role ctx to its own subtree
			// root (= the legacy wikiRootNodeId).
			wikiAnchorNodeIds: [`wiki-root:${projectId}`],
			agentRole: "lead",
			workingDir: projWs,
			contextBundle: { workspaceDir: projWs, wikiRootNodeId: `wiki-root:${projectId}` },
		};
	}
	const root = () => `wiki-root:${projectId}`;

	// Parse "Wiki node created: <id> | <title>" → id
	const createdId = (r: string) => r.split("created:")[1].split("|")[0].trim();

	test("create creates a node under the project subtree root", async () => {
		const r = await execWiki({
			action: "create",
			parentId: root(),
			title: "Feature X",
			summary: "Why we built it",
		}, ctx());
		expect(r).toMatch(/created/i);
		// discoverable via search
		const searched = await execWiki({ action: "search", query: "Feature X" }, ctx());
		expect(searched).toMatch(/Feature X/);
	});

	test("create rejects a duplicate title under the same parent", async () => {
		await execWiki({ action: "create", parentId: root(), title: "Same" }, ctx());
		const r = await execWiki({ action: "create", parentId: root(), title: "Same" }, ctx());
		expect(r).toMatch(/unique|sibling/i);
	});

	test("create inherits type from the parent's position (intent parent → intent child)", async () => {
		// Seed an intent-prefixed parent directly via the store (the tool would
		// produce structure under the bare-root path; this isolates inheritance).
		const parent = wikiStoreGlobal.upsertProjectNode(projectId, {
			parentId: root(),
			type: "intent",
			path: "intent:bucket",
			title: "Bucket",
			lastUpdatedBy: "test",
		});
		const r = await execWiki({ action: "create", parentId: parent.id, title: "Child" }, ctx());
		const childId = createdId(r);
		const child = wikiStoreGlobal.get(childId);
		expect(child?.type).toBe("intent");
	});

	test("expand returns node metadata + children for a visible node", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Y", summary: "sum-y" }, ctx());
		const nodeId = createdId(r);
		const expanded = await execWiki({ action: "expand", nodeId }, ctx());
		expect(expanded).toMatch(/Y/);
		expect(expanded).toMatch(/sum-y/);
	});

	test("search substring match across visible nodes", async () => {
		await execWiki({ action: "create", parentId: root(), title: "Alpha", summary: "alpha-beta-gamma" }, ctx());
		const r = await execWiki({ action: "search", query: "alpha-beta" }, ctx());
		expect(r).toMatch(/Alpha/);
	});

	test("update changes metadata without touching the body", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Orig", content: "body-v1" }, ctx());
		const nodeId = createdId(r);
		const upd = await execWiki({ action: "update", nodeId, title: "Renamed", summary: "new-sum" }, ctx());
		expect(upd).toMatch(/updated/i);
		// body untouched
		const body = await execWiki({ action: "docRead", nodeId }, ctx());
		expect(body).toContain("body-v1");
	});

	test("update rejects a duplicate sibling title on rename", async () => {
		const a = await execWiki({ action: "create", parentId: root(), title: "A" }, ctx());
		await execWiki({ action: "create", parentId: root(), title: "B" }, ctx());
		const r = await execWiki({ action: "update", nodeId: createdId(a), title: "B" }, ctx());
		expect(r).toMatch(/unique|sibling/i);
	});

	test("delete removes a node", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Gone" }, ctx());
		const nodeId = createdId(r);
		const del = await execWiki({ action: "delete", nodeId }, ctx());
		expect(del).toMatch(/deleted/i);
		expect(wikiStoreGlobal.get(nodeId)).toBeUndefined();
	});

	test("docWrite + docRead round-trip by nodeId", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Doc" }, ctx());
		const nodeId = createdId(r);
		await execWiki({ action: "docWrite", nodeId, content: "# Title\nhello world" }, ctx());
		const body = await execWiki({ action: "docRead", nodeId }, ctx());
		expect(body).toContain("hello world");
	});

	test("docEdit replaces a unique substring (Edit semantics)", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Ed" }, ctx());
		const nodeId = createdId(r);
		await execWiki({ action: "docWrite", nodeId, content: "version is v0.7 final" }, ctx());
		const edit = await execWiki({ action: "docEdit", nodeId, oldString: "v0.7", newString: "v0.8" }, ctx());
		expect(edit).toMatch(/edited/i);
		const body = await execWiki({ action: "docRead", nodeId }, ctx());
		expect(body).toContain("v0.8");
		expect(body).not.toContain("v0.7");
	});

	test("docEdit rejects a missing oldString", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Miss" }, ctx());
		const nodeId = createdId(r);
		await execWiki({ action: "docWrite", nodeId, content: "nothing here" }, ctx());
		const edit = await execWiki({ action: "docEdit", nodeId, oldString: "absent", newString: "x" }, ctx());
		expect(edit).toMatch(/not found|no edit/i);
	});

	test("docEdit rejects a non-unique oldString without replaceAll, and replaces all with replaceAll", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Dup" }, ctx());
		const nodeId = createdId(r);
		await execWiki({ action: "docWrite", nodeId, content: "foo bar foo bar" }, ctx());
		const reject = await execWiki({ action: "docEdit", nodeId, oldString: "foo", newString: "baz" }, ctx());
		expect(reject).toMatch(/unique|not unique/i);
		const all = await execWiki({ action: "docEdit", nodeId, oldString: "foo", newString: "baz", replaceAll: true }, ctx());
		expect(all).toMatch(/edited/i);
		const body = await execWiki({ action: "docRead", nodeId }, ctx());
		expect(body).toBe("baz bar baz bar");
	});

	test("doc ops resolve by hierarchical title path", async () => {
		const parentId = createdId(await execWiki({ action: "create", parentId: root(), title: "Parent" }, ctx()));
		await execWiki({ action: "create", parentId, title: "Child" }, ctx());
		await execWiki({ action: "docWrite", path: "Parent/Child", content: "via-path" }, ctx());
		const body = await execWiki({ action: "docRead", path: "Parent/Child" }, ctx());
		expect(body).toContain("via-path");
	});
});

// ---------------------------------------------------------------------------
// verify tool (§4.5 / §11.4) — blocking; PM verdict via delegateTask
// ---------------------------------------------------------------------------

describe("verify tool (lead submit → PM verdict)", () => {
	let pmAgentId: string;
	let requirementId: string;
	let projectId: string;

	beforeEach(() => {
		pmAgentId = management.createAgent({ name: "PM" } as any).id;
		seedAgentWithRoleTag(sessionDB, pmAgentId, "pm");
		// Create a real Project so RequirementStore.create's projectId FK holds.
		const proj = management.createProject({ name: "VerifyProj", workspaceDir: join(tmpDir, "vws") });
		projectId = proj.id;
		const req = requirementStore.create({
			projectId,
			title: "Test Req",
			description: "intent",
			status: "ready" as any,
			source: "user" as any,
			priority: "p1" as any,
			reviewer: "analyst",
			reviewerAgentId: pmAgentId,
		} as any);
		requirementId = req.id;
	});

	function ctx(delegateTask: (task: string, opts?: any) => Promise<string>): any {
		return {
			requirementStore,
			delegateTask,
			management,
			projectId,
		};
	}

	test("PM APPROVED → verdict returned; requirement status='verify'", async () => {
		const delegateTask = vi.fn(async (_task: string, _opts?: any) =>
			"VERDICT: APPROVED — change covers the intent");
		const r = await execVerify({ requirementId }, ctx(delegateTask));
		expect(r).toMatch(/APPROVED/i);
		expect(delegateTask).toHaveBeenCalled();
		// verify set status to "verify" + added an audit message.
		const updated = requirementStore.get(requirementId) as any;
		expect(updated?.status).toBe("verify");
	});

	test("PM REJECTED → gap reason returned (mock PM)", async () => {
		const delegateTask = vi.fn(async (_task: string, _opts?: any) =>
			"VERDICT: REJECTED — missing test coverage for the error path");
		const r = await execVerify({ requirementId }, ctx(delegateTask));
		expect(r).toMatch(/REJECTED/i);
		expect(r).toMatch(/error path/);
	});

	test("delegateTask targets PM agent (targetAgentId passed)", async () => {
		const delegateTask = vi.fn(async (_task: string, _opts?: any) =>
			"VERDICT: APPROVED — ok");
		await execVerify({ requirementId }, ctx(delegateTask));
		const opts = delegateTask.mock.calls[0]?.[1];
		expect(opts?.targetAgentId).toBe(pmAgentId);
	});
});

// ---------------------------------------------------------------------------
// tool_usage logging (§7.7 #4) — one row per tool invocation via ctx.toolUsageStore
// ---------------------------------------------------------------------------

describe("tool_usage record", () => {
	// tool_usage is written by the AI SDK wrapper in tool-factory (not by the
	// inner options.execute). To exercise it, drive the wrapper directly:
	// toolDef.execute(input, { experimental_context: ctx }). The wrapper unwraps
	// opts.experimental_context into the inner execute's ctx and calls
	// recordToolUsage on completion.
	function callViaWrapper(toolDef: any, input: any, ctx: any): Promise<unknown> {
		return toolDef.execute(input, { experimental_context: ctx, toolCallId: "test-call" });
	}

	test("successful tool call writes a row with success=true", async () => {
		const ctx: any = {
			management,
			toolUsageStore,
			agentId: "agent-1",
			sessionId: "sess-1",
		};
		await callViaWrapper(projectTool, { action: "create", name: "P", workspaceDir: join(tmpDir, "ws") }, ctx);
		const rows = toolUsageStore.listByTool("Project");
		expect(rows.length).toBe(1);
		expect(rows[0].success).toBe(true);
		expect(rows[0].agentId).toBe("agent-1");
		expect(rows[0].sessionId).toBe("sess-1");
		// params summary present (action recorded, workspaceDir recorded).
		expect(rows[0].params).toBeTruthy();
	});

	test("failed tool call writes a row with success=false", async () => {
		// The management tools swallow service errors via safe() (return
		// "Error: …" string, never throw). The tool-factory wrapper only
		// records success=false when the tool execute() actually throws. So
		// to exercise the failure path we build a minimal throwing tool with
		// the same wrapper and drive it.
		const { buildTool } = await import("../../src/runtime/tools/tool-factory.js");
		const z = await import("zod");
		const throwingTool = buildTool({
			name: "ThrowingTool",
			description: "test-only tool that throws",
			meta: { category: "management" as const, isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
			inputSchema: z.object({}),
			execute: async () => { throw new Error("boom"); },
		});
		const ctx: any = { toolUsageStore, agentId: "agent-1", sessionId: "sess-1" };
		await expect(
			throwingTool.execute({}, { experimental_context: ctx, toolCallId: "c1" }),
		).rejects.toThrow(/boom/);
		const rows = toolUsageStore.listByTool("ThrowingTool");
		expect(rows.length).toBe(1);
		expect(rows[0].success).toBe(false);
	});

	test("params summary truncates long string inputs (≤200 + …)", async () => {
		const longName = "x".repeat(500);
		const ctx: any = { management, toolUsageStore, agentId: "a", sessionId: "s" };
		await callViaWrapper(projectTool, { action: "create", name: longName, workspaceDir: join(tmpDir, "ws") }, ctx);
		const row = toolUsageStore.listByTool("Project")[0];
		const params = row.params as Record<string, unknown>;
		// String reduced to ≤200 chars + truncation marker (per summarizeParams).
		expect((params.name as string).length).toBeLessThanOrEqual(220);
		expect(params.name as string).toMatch(/…\(truncated\)/);
	});
});
