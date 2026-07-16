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
// 临时 CoreDatabase (mkdtempSync) + 真实 stores + mock delegateTask。
//
// ## 输出
// Vitest 用例。
//
// ## 边界
// - Cron 三模式调度触发 → P4 (本测试只验 store CRUD + trigger 入口)
// - verify→PM→archivist 端到端闭环 → P7 (本测试 mock delegateTask,不验 archivist)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { ManagementService } from "../../src/server/management-service.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { WikiStore, getWikiStoreGlobal, setWikiStoreGlobal } from "../../src/server/wiki-node-store.js";
import { ProjectWikiStore } from "../../src/server/project-wiki-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { ToolUsageStore } from "../../src/server/tool-usage-store.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import { setManagementService } from "../../src/server/management-service.js";
import { projectTool } from "../../src/tools/project-tool.js";
import { agentRegistryTool } from "../../src/tools/agent-registry.js";
import { cronTool } from "../../src/tools/cron-tool.js";
import { wikiTool } from "../../src/tools/wiki-tool.js";
// project-flow F5: verify-tool.ts is deleted; Flow.verify (compound) is the
// replacement, exercised in tests/unit/f3-flow-verify.test.ts. This P3
// contract file no longer drives a verify path (it was a thin duplicate).
import { runMigrations } from "../../src/server/db-migration.js";
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";
import { runTool } from "./helpers/tool-decoupling-helpers.js";
import type { CronSchedule } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: CoreDatabase;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let cronStore: CronStore;
let management: ManagementService;
let wikiStoreGlobal: WikiStore;
let wikiStore: ProjectWikiStore;
let requirementStore: RequirementStore;
let toolUsageStore: ToolUsageStore;

// tool-decoupling sub-3:迁移后的工具(Project/Cron/Wiki)execute 返 ToolResult
// + format。runTool 同时拿 JSON + 文本,断言两边。agentRegistryTool 仍是 legacy
// (string 返值,sub-3 范围外),直调 execute 拿 string。
//
// 为最小化改动既有用例,exec<Project|Cron|Wiki> 返一个 thenable 字符串 ——
// `await execProject(...)` 解析成 format 后的文本(同 sub-3 前 agent 视角的
// string 返值),所以 `parse(await execProject(...))` 和
// `expect(await execWiki(...)).toMatch(...)` 都不需逐行改。
//
// 想断言 JSON 边(结构化 ToolResult)的用例用 execJSON,它返完整 {json, text}。
function makeExec(tool: any) {
	return (input: any, ctx: any) => {
		const p = runTool(tool, input, ctx);
		// thenable:await 拿 text(format 后)。同时暴露 .full(原 promise)给
		// 需要拿 JSON 的用例。
		const thenable = {
			then(onFulfilled: any, onRejected?: any) {
				return p.then((r) => onFulfilled ? onFulfilled(r.text) : r.text, onRejected);
			},
			full: p,
		};
		return thenable;
	};
}
const execProject = makeExec(projectTool);
const execCron = makeExec(cronTool);
const execWiki = makeExec(wikiTool);
// tool-decoupling sub-5:agentRegistryTool 已迁(migrated),与 Project/Cron/Wiki
// 同走 makeExec(runTool 同时拿 JSON + format 后文本)。
const execAgent = makeExec(agentRegistryTool);
// 拿完整 {json, text} 的 helper(少数用例断言 JSON 边用)。
const execJSON = {
	Project: (input: any, ctx: any) => runTool(projectTool, input, ctx),
	Cron: (input: any, ctx: any) => runTool(cronTool, input, ctx),
	Wiki: (input: any, ctx: any) => runTool(wikiTool, input, ctx),
};

const SCHED_DAILY: CronSchedule = { mode: "interval", everyMs: 86_400_000 };

// parse:string→JSON。迁移工具的文本(format 后)对 Project/Cron/Agent 是
// JSON.dump,对 Wiki 是渲染文本 —— 用例里 parse 仅对 Project/Cron/Agent 用。
function parse(s: unknown): any {
	return typeof s === "string" ? JSON.parse(s) : s;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p3-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	wikiStoreGlobal = new WikiStore(sessionDB);
	wikiStore = new ProjectWikiStore(wikiStoreGlobal);
	requirementStore = new RequirementStore(sessionDB);
	toolUsageStore = new ToolUsageStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, cronStore, templateStore: new TemplateStore(sessionDB) });
	// 决策 1:迁移工具直读单例。测试注册本用例的实例(每个 beforeEach 重建)。
	setManagementService(management);
	setWikiStoreGlobal(wikiStoreGlobal);
});

afterEach(() => {
	setManagementService(undefined);
	setWikiStoreGlobal(undefined);
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

	test("create with template copies identity, but name/model/provider override the template defaults", async () => {
		// v0.8 fix: user's `name` used to be silently dropped (agent got the
		// template's name "Coder"). Now name/model/provider are tunable overrides
		// so each instance is distinguishable; systemPrompt + toolPolicy still
		// come purely from the template.
		const coder = management.listTemplates().find((t) => t.name === "Coder")!;
		const r = parse(await execAgent(
			{ action: "create", template: coder.id, name: "tool-test-agent", model: "gpt-test", provider: "openai" },
			ctx(),
		));
		expect(r.name).toBe("tool-test-agent");
		expect(r.model).toBe("gpt-test");
		expect(r.provider).toBe("openai");
		// systemPrompt + toolPolicy are still the template's (not in the summary;
		// verify via get that identity was copied).
		expect(r).not.toHaveProperty("systemPrompt");
		const full = parse(await execAgent({ action: "get", id: r.id }, ctx()));
		expect(full.systemPrompt).toBe(coder.systemPrompt);
	});

	test("create with template accepts template NAME (case-insensitive), not just id", async () => {
		// v0.8 fix: `template: "coder"` used to fail with "Unknown template"
		// because only id lookup was supported. Now name (case-insensitive) also
		// resolves — discoverable alongside the id via listTemplates.
		const r = parse(await execAgent({ action: "create", template: "coder" }, ctx()));
		expect(r.name).toBe("Coder");
		const full = parse(await execAgent({ action: "get", id: r.id }, ctx()));
		expect(full.systemPrompt).toMatch(/senior software developer/i);
	});

	test("create with an unknown template returns a clear error", async () => {
		const r = await execAgent({ action: "create", template: "does-not-exist" }, ctx());
		expect(String(r)).toMatch(/^Error: Unknown template: does-not-exist/);
	});

	test("update returns compact summary + merges toolPolicy (toggling one tool keeps the rest)", async () => {
		// Seed an agent with several tools enabled.
		const a = management.createAgent({
			name: "A",
			toolPolicy: {
				executionMode: "sequential",
				tools: { Read: { enabled: true }, Shell: { enabled: true }, WebSearch: { enabled: true } },
			},
		} as any);
		// Update disables ONLY WebSearch.
		const upd = parse(await execAgent({
			action: "update",
			id: a.id,
			toolPolicy: { tools: { WebSearch: { enabled: false } } },
			subagents: [{ agentId: "other-agent", name: "Helper" }],
			wikiAnchors: [{ nodeId: "n1", inject: "system" }],
		}, ctx()));
		// update returns a compact summary — no systemPrompt/toolPolicy dump.
		expect(upd.id).toBe(a.id);
		expect(upd.subagents).toBe(1); // count, not the array
		expect(upd.wikiAnchors).toBe(1);
		expect(upd).not.toHaveProperty("systemPrompt");
		expect(upd).not.toHaveProperty("toolPolicy");
		// Verify the MERGE via get (full record): WebSearch disabled, others kept.
		const full = parse(await execAgent({ action: "get", id: a.id }, ctx()));
		expect(full.toolPolicy.tools.WebSearch.enabled).toBe(false);
		expect(full.toolPolicy.tools.Read.enabled).toBe(true);   // preserved
		expect(full.toolPolicy.tools.Shell.enabled).toBe(true);  // preserved
		expect(full.toolPolicy.executionMode).toBe("sequential"); // preserved (not in patch)
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

	test("listTemplates + getTemplate (capability gallery)", async () => {
		const list = parse(await execAgent({ action: "listTemplates" }, ctx()));
		// 能力画廊:按 name 找一条(模板用 uuid id,非固定)。
		const coder = list.find((p: any) => p.name === "Coder");
		expect(coder).toBeTruthy();
		// listTemplates returns a COMPACT summary — no systemPrompt dump.
		expect(coder).not.toHaveProperty("systemPrompt");
		expect(coder).not.toHaveProperty("toolPolicy");
		// getTemplate returns the full record (with systemPrompt).
		const one = parse(await execAgent({ action: "getTemplate", templateId: coder.id }, ctx()));
		expect(one.id).toBe(coder.id);
		expect(one.systemPrompt).toBeTruthy();
		// v0.8 fix: getTemplate also accepts the template NAME (case-insensitive).
		const byName = parse(await execAgent({ action: "getTemplate", templateId: "coder" }, ctx()));
		expect(byName.id).toBe(coder.id);
	});

	test("deleting an agent cascade-cleans stale subagent references on other agents", async () => {
		// v0.8 fix: subagents is a soft ref. Deleting an agent used to leave
		// dangling entries → "subagent X no longer exists" at delegation time.
		// Now delete sweeps every agent's subagents list and drops the gone id
		// (both the management tool path AND the REST DELETE path — cleanup is
		// in AgentStore.delete, the store-layer choke point).
		const keepChild = management.createAgent({ name: "kept" } as any);
		const goneChild = management.createAgent({ name: "gone" } as any);
		const parent = management.createAgent({
			name: "Parent",
			subagents: [
				{ agentId: keepChild.id, name: "Kept" },
				{ agentId: goneChild.id, name: "Gone" },
			],
		} as any);
		// Also exercise the REST path: agentStore.delete is what the router calls.
		agentStore.delete(goneChild.id);
		const after = management.getAgent(parent.id);
		expect(after?.subagents?.map((s) => s.agentId)).toEqual([keepChild.id]);
		// Deleting the last referenced child empties the list (no dangling ref).
		agentStore.delete(keepChild.id);
		expect(management.getAgent(parent.id)?.subagents).toEqual([]);
	});

	test("missing required fields return clear errors (not cryptic DB errors)", async () => {
		// create without name (and no template)
		expect(String(await execAgent({ action: "create" }, ctx()))).toMatch(/create requires `name`/);
		// update without id
		expect(String(await execAgent({ action: "update", name: "X" }, ctx()))).toMatch(/update requires `id`/);
		// delete without id
		expect(String(await execAgent({ action: "delete" }, ctx()))).toMatch(/delete requires `id`/);
		// get without id
		expect(String(await execAgent({ action: "get" }, ctx()))).toMatch(/get requires `id`/);
		// getTemplate without templateId
		expect(String(await execAgent({ action: "getTemplate" }, ctx()))).toMatch(/getTemplate requires `templateId`/);
	});

	test("not-found returns uniform 'Error: …' (not an {error} object)", async () => {
		expect(String(await execAgent({ action: "get", id: "nope" }, ctx()))).toMatch(/^Error: Agent not found: nope/);
		expect(String(await execAgent({ action: "getTemplate", templateId: "nope" }, ctx()))).toMatch(/^Error: Template not found: nope/);
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
		// createdId returns the short id; expand resolves it back and renders
		// the child line with its inherited [type].
		const childShort = createdId(r);
		const expanded = await execWiki({ action: "expand", nodeId: parent.id }, ctx());
		expect(expanded).toMatch(/Child/);
		expect(expanded).toMatch(/\[intent\]/);
		// The short id we round-tripped must resolve to a real node of the right type.
		const childLine = expanded.split("\n").find((l) => /Child/.test(l))!;
		expect(childLine).toContain(childShort);
	});

	test("expand returns node metadata + direct children (default depth 1), NOT the body", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "Y", summary: "sum-y" }, ctx());
		const nodeId = createdId(r);
		// Give the node a body — expand must NOT surface it (docRead's job).
		await execWiki({ action: "docWrite", nodeId, content: "SECRET-BODY-should-not-leak-via-expand" }, ctx());
		const expanded = await execWiki({ action: "expand", nodeId }, ctx());
		expect(expanded).toMatch(/Y/);
		expect(expanded).toMatch(/sum-y/);
		// Body stays out of expand — only docRead returns it.
		expect(expanded).not.toMatch(/SECRET-BODY/);
		// docRead is the body channel.
		const body = await execWiki({ action: "docRead", nodeId }, ctx());
		expect(body).toMatch(/SECRET-BODY/);
	});

	test("expand depth controls how many descendant levels are included", async () => {
		// Build parent → child → grandchild.
		const parent = createdId(await execWiki({ action: "create", parentId: root(), title: "Parent" }, ctx()));
		const child = createdId(await execWiki({ action: "create", parentId: parent, title: "Child" }, ctx()));
		await execWiki({ action: "create", parentId: child, title: "Grandchild" }, ctx());

		// depth 1 (default): direct children only — Child visible, Grandchild not.
		const d1 = await execWiki({ action: "expand", nodeId: parent }, ctx());
		expect(d1).toMatch(/Child/);
		expect(d1).not.toMatch(/Grandchild/);
		// Grandchild exists but is hidden by the depth cap → surface it.
		expect(d1).toMatch(/1 more node hidden below depth 1/);

		// depth 2: includes grandchildren.
		const d2 = await execWiki({ action: "expand", nodeId: parent, depth: 2 }, ctx());
		expect(d2).toMatch(/Child/);
		expect(d2).toMatch(/Grandchild/);
		// Structure is a markdown nested list (not bare-space indent, which
		// Markdown collapses and makes the tree look flat): Child is a top
		// `- ` item, Grandchild an indented nested item under it.
		const d2lines = d2.split("\n");
		const childLine = d2lines.find((l) => /Child/.test(l))!;
		const grandLine = d2lines.find((l) => /Grandchild/.test(l))!;
		expect(childLine).toMatch(/^- /);
		expect(grandLine).toMatch(/^  - /);
		expect(grandLine.indexOf("-")).toBeGreaterThan(childLine.indexOf("-"));

		// depth is capped at 5 (a huge value behaves like 5, not an error).
		const dCap = await execWiki({ action: "expand", nodeId: parent, depth: 99 }, ctx());
		expect(dCap).toMatch(/Grandchild/);
	});

	test("expand breadth-first budget: keeps ALL level-1 siblings, drops deeper levels when the subtree is huge", async () => {
		// Regression: the old depth-first walk rendered the full `depth`, so a huge
		// first-child branch buried its siblings once the result was truncated. The
		// breadth-first budget must keep every level-1 child (siblings complete) and
		// sacrifice DEPTH instead. Build parent → 60 children → 5 grandchildren each
		// (360 descendants); request depth 5; assert all 60 children show and deeper
		// is budget-cut.
		const parent = wikiStoreGlobal.upsertProjectNode(projectId, {
			parentId: root(), type: "intent", path: "intent:wide", title: "WideParent", lastUpdatedBy: "test",
		});
		const childTitles: string[] = [];
		for (let i = 0; i < 60; i++) {
			const c = wikiStoreGlobal.upsertProjectNode(projectId, {
				parentId: parent.id, type: "intent", path: `intent:wide/c${i}`, title: `Child${i}`, lastUpdatedBy: "test",
			});
			childTitles.push(`Child${i}`);
			for (let g = 0; g < 5; g++) {
				wikiStoreGlobal.upsertProjectNode(projectId, {
					parentId: c.id, type: "intent", path: `intent:wide/c${i}/g${g}`, title: `GC${i}-${g}`, lastUpdatedBy: "test",
				});
			}
		}
		const expanded = await execWiki({ action: "expand", nodeId: parent.id, depth: 5 }, ctx());
		// EVERY level-1 sibling appears — the breadth-first guarantee. DFS+truncation
		// would have filled the output with Child0's subtree and dropped Child40+.
		for (const title of childTitles) expect(expanded).toContain(title);
		// Grandchildren (level 2) were dropped by the budget, not the siblings.
		expect(expanded).not.toContain("GC0-0");
		// Budget-cut note surfaces, naming the kept level range.
		expect(expanded).toMatch(/breadth-first budget kept levels 1\.\.1 complete/);
	});

	test("expand rootDoc:true replaces Summary line with the node doc (capped 4kb)", async () => {
		// Create a node with both a summary and a body doc.
		const r = await execWiki({ action: "create", parentId: root(), title: "RD", summary: "sum-line" }, ctx());
		const nodeId = createdId(r);
		await execWiki({ action: "docWrite", nodeId, content: "THE DOC BODY that rootDoc should surface" }, ctx());
		// Seed a child so the expand result has a child line carrying a marker.
		await execWiki({ action: "create", parentId: nodeId, title: "ChildOfRD", summary: "kid" }, ctx());
	
		// Without rootDoc: root shows Summary, NOT the doc body.
		const plain = await execWiki({ action: "expand", nodeId }, ctx());
		expect(plain).toMatch(/Summary: sum-line/);
		expect(plain).not.toContain("Doc:");
		expect(plain).not.toContain("THE DOC BODY that rootDoc should surface");
	
		// With rootDoc:true: root shows Doc: (the body), capped at 4kb.
		const withDoc = await execWiki({ action: "expand", nodeId, rootDoc: true }, ctx());
		expect(withDoc).toMatch(/Doc: THE DOC BODY that rootDoc should surface/);
		expect(withDoc).not.toMatch(/^Summary:/m);
	
		// Child line (ChildOfRD has no children) carries the leaf marker.
		expect(withDoc).toMatch(/ChildOfRD.*leaf/);
	});


	test("short id round-trip: create returns #xxxxxxxx; docRead/update/expand resolve it; full id never leaks", async () => {
		const r = await execWiki({ action: "create", parentId: root(), title: "ShortIdTarget", summary: "sm" }, ctx());
		const short = createdId(r);
		// Result uses the short-id form (# + 8 hex), not the full uuid.
		expect(short).toMatch(/^#[0-9a-f]{8}$/);
		// docWrite + docRead via the short id round-trip.
		await execWiki({ action: "docWrite", nodeId: short, content: "hello short" }, ctx());
		const body = await execWiki({ action: "docRead", nodeId: short }, ctx());
		expect(body).toMatch(/hello short/);
		// update via short id, then expand to confirm the rename took.
		await execWiki({ action: "update", nodeId: short, title: "ShortIdRenamed" }, ctx());
		const expanded = await execWiki({ action: "expand", nodeId: short }, ctx());
		expect(expanded).toMatch(/ShortIdRenamed/);
		// The full uuid is never shown to the agent — only the #xxxxxxxx handle.
		expect(expanded).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
	});

	test("expand child line includes the subtree-abstract summary", async () => {
		// Create a child with a summary directly under root, then expand root.
		const childR = await execWiki({
			action: "create", parentId: root(), title: "SumChild", summary: "child-abstract-xyz",
		}, ctx());
		const childShort = createdId(childR);
		const expanded = await execWiki({ action: "expand", nodeId: root() }, ctx());
		// The child row carries its summary (not just title + size).
		const childLine = expanded.split("\n").find((l) => l.includes(childShort))!;
		expect(childLine).toContain("SumChild");
		expect(childLine).toContain("child-abstract-xyz");
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

	test("expand shows each node's body size (no body vs has body)", async () => {
		const parent = createdId(await execWiki({ action: "create", parentId: root(), title: "SizeParent" }, ctx()));
		const leaf = createdId(await execWiki({ action: "create", parentId: parent, title: "SizeLeaf" }, ctx()));
		// Leaf has no body yet; parent has none either.
		let expanded = await execWiki({ action: "expand", nodeId: parent }, ctx());
		expect(expanded).toMatch(/Body: \(no doc\)/);
		// Give the leaf a body and re-expand — its size must surface.
		await execWiki({ action: "docWrite", nodeId: leaf, content: "x".repeat(2048) }, ctx());
		expanded = await execWiki({ action: "expand", nodeId: parent }, ctx());
		expect(expanded).toMatch(/SizeLeaf.*\(doc 2\.0kb\)/);
	});

	test("search shows each hit's body size", async () => {
		const n = createdId(await execWiki({ action: "create", parentId: root(), title: "SearchSize", summary: "sz-sum" }, ctx()));
		await execWiki({ action: "docWrite", nodeId: n, content: "x".repeat(600) }, ctx());
		const out = await execWiki({ action: "search", query: "SearchSize" }, ctx());
		expect(out).toMatch(/SearchSize.*\(doc 600b\)/);
	});

	test("docWrite refuses to clobber a non-empty body without overwrite:true", async () => {
		const n = createdId(await execWiki({ action: "create", parentId: root(), title: "Clobber" }, ctx()));
		await execWiki({ action: "docWrite", nodeId: n, content: "original" }, ctx());
		const reject = await execWiki({ action: "docWrite", nodeId: n, content: "replacement" }, ctx());
		expect(reject).toMatch(/already has a .* body/i);
		expect(reject).toMatch(/overwrite:true/i);
		// Body unchanged.
		expect(await execWiki({ action: "docRead", nodeId: n }, ctx())).toContain("original");
	});

	test("docWrite with overwrite:true replaces a non-empty body", async () => {
		const n = createdId(await execWiki({ action: "create", parentId: root(), title: "Overwrite" }, ctx()));
		await execWiki({ action: "docWrite", nodeId: n, content: "original" }, ctx());
		const ok = await execWiki({ action: "docWrite", nodeId: n, content: "replacement", overwrite: true }, ctx());
		expect(ok).toMatch(/written/i);
		expect(await execWiki({ action: "docRead", nodeId: n }, ctx())).toContain("replacement");
	});

	test("docWrite on an empty node succeeds without overwrite", async () => {
		const n = createdId(await execWiki({ action: "create", parentId: root(), title: "Fresh" }, ctx()));
		const ok = await execWiki({ action: "docWrite", nodeId: n, content: "first body" }, ctx());
		expect(ok).toMatch(/written/i);
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
		const { buildTool } = await import("../../src/tools/tool-factory.js");
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

	// tool-decoupling sub-3 fix: migrated tool returning {ok:false} must be
	// treated as a failure by the buildTool wrapper — throw so AI SDK emits
	// tool-error (→ agent-loop persists isError=true + tool-execution-hooks
	// records success=false), AND record success=false in tool_usage. The
	// previous bug: ok:false was returned as a normal string → success path
	// → recordToolUsage(true) + PostToolUse + AI SDK tool-result (isError=false).
	test("migrated tool returning {ok:false} is recorded as failure + throws", async () => {
		const { buildTool } = await import("../../src/tools/tool-factory.js");
		const { HookRegistry } = await import("../../src/core/hook-registry.js");
		const z = await import("zod");

		// Register a PostToolUseFailure + PostToolUse spy on the singleton so we
		// can assert which side the wrapper took (buildTool fires to the
		// singleton via triggerHooks; production per-loop hooks are separate, but
		// the wrapper's own triggerHooks call reaches this spy).
		const singleton = HookRegistry.getInstance();
		singleton.clear();
		const fired: string[] = [];
		const unsub1 = singleton.register("PostToolUse", async () => { fired.push("PostToolUse"); });
		const unsub2 = singleton.register("PostToolUseFailure", async (c: any) => { fired.push("PostToolUseFailure:" + String(c.error)); });

		try {
			const failingMigratedTool = buildTool({
				name: "FailingMigrated",
				description: "test-only migrated tool returning ok:false",
				meta: { category: "management" as const, isReadOnly: false, isConcurrencySafe: false, isDestructive: false },
				inputSchema: z.object({}),
				execute: async () => ({ ok: false, error: "boom-from-migrated" }),
				format: (r) => `FORMATTED: ${r.error ?? "no error"}`,
			});
			const ctx: any = { toolUsageStore, agentId: "agent-1", sessionId: "sess-1" };

			// The wrapper must throw so AI SDK emits tool-error (the load-bearing
			// signal for agent-loop's isError=true + tool-execution success=false).
			await expect(
				failingMigratedTool.execute({}, { experimental_context: ctx, toolCallId: "m1" }),
			).rejects.toThrow(/boom-from-migrated/);

			// tool_usage row must be success=false (the load-bearing failure mark;
			// the table has no errorMessage column — recordToolUsage's _errorMsg
			// param is a best-effort dead arg, the row only carries success bool).
			const rows = toolUsageStore.listByTool("FailingMigrated");
			expect(rows.length).toBe(1);
			expect(rows[0].success).toBe(false);

			// Wrapper must have taken the failure side (NOT PostToolUse success).
			expect(fired).toEqual(["PostToolUseFailure:boom-from-migrated"]);
			expect(fired.some((e) => e.startsWith("PostToolUse:"))).toBe(false);
		} finally {
			unsub1();
			unsub2();
		}
	});

	// Symmetric positive case: migrated ok:true must still take the success
	// side (no regression on the happy path).
	test("migrated tool returning {ok:true} still takes the success side", async () => {
		const { buildTool } = await import("../../src/tools/tool-factory.js");
		const { HookRegistry } = await import("../../src/core/hook-registry.js");
		const z = await import("zod");

		const singleton = HookRegistry.getInstance();
		singleton.clear();
		const fired: string[] = [];
		const unsub1 = singleton.register("PostToolUse", async () => { fired.push("PostToolUse"); });
		const unsub2 = singleton.register("PostToolUseFailure", async () => { fired.push("PostToolUseFailure"); });

		try {
			const okMigratedTool = buildTool({
				name: "OkMigrated",
				description: "test-only migrated tool returning ok:true",
				meta: { category: "management" as const, isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
				inputSchema: z.object({}),
				execute: async () => ({ ok: true, data: { text: "all good" } }),
				format: (r) => (r.data as any)?.text ?? "ok",
			});
			const ctx: any = { toolUsageStore, agentId: "agent-1", sessionId: "sess-1" };
			const out = await okMigratedTool.execute({}, { experimental_context: ctx, toolCallId: "m2" });
			expect(out).toBe("all good");

			const rows = toolUsageStore.listByTool("OkMigrated");
			expect(rows.length).toBe(1);
			expect(rows[0].success).toBe(true);

			expect(fired).toEqual(["PostToolUse"]);
		} finally {
			unsub1();
			unsub2();
		}
	});
});
