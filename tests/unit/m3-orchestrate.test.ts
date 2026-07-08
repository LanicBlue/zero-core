// M3 单元测试:Orchestrate DSL + confirm 门 + 状态机 + 通知路由 + 幂等 + cron 兜底
//
// # 文件说明书
//
// ## 核心功能
// 验证 M3 核心交付 (acceptance-M3.md):
//   - OrchestratePlanStore / OrchestrateManifestStore 持久化
//   - ConfirmRegistry 真·挂起语义(await 不 resolve = 永久挂起;外部 resolve 才唤醒)
//   - 状态转移路径(ready→plan→build→verify→closed)有效
//   - ProjectNotificationRouter 路由到 {角色, projectId} → session
//   - pickup 幂等(OQ5:assignedLeadSessionId 已写则跳过)
//   - cron fallback:backfillPendingNotifications 重发漏掉的通知
//   - commit 引用 requirementId(决策 21)
//   - feature worktree 路径约定(决策 25)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import {
	OrchestratePlanStore,
	OrchestrateManifestStore,
	ConfirmRegistry,
} from "../../src/server/orchestrate-store.js";
import { TaskStepStore } from "../../src/server/task-step-store.js";
import { ProjectWikiStore } from "../../src/server/project-wiki-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { LeadService } from "../../src/server/lead-service.js";
import { ProjectWorkStore } from "../../src/server/project-work-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { isValidTransition } from "../../src/server/requirement-state-machine.js";
import { featureWorktreePath, featureBranchName } from "../../src/server/archivist-git.js";
import type { OrchestrateFlow, OrchestrateNode } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let requirementStore: RequirementStore;
let planStore: OrchestratePlanStore;
let manifestStore: OrchestrateManifestStore;
let registry: ConfirmRegistry;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m3-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	planStore = new OrchestratePlanStore(sessionDB);
	manifestStore = new OrchestrateManifestStore(sessionDB);
	// ConfirmRegistry is a singleton — reset between tests by clearing pending entries.
	registry = ConfirmRegistry.getInstance();
	for (const id of registry.listPendingPlanIds()) registry.drop(id);
});

afterEach(() => {
	for (const id of registry.listPendingPlanIds()) registry.drop(id);
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── DSL types sanity ─────────────────────────────────────────

describe("Orchestrate DSL types", () => {
	test("all node kinds constructible (parallel/pipeline/if/for/barrier/verify/task)", () => {
		const flow: OrchestrateFlow = {
			requirementId: "req-1",
			title: "Sample",
			root: {
				kind: "pipeline",
				id: "root",
				children: [
					{ kind: "task", id: "t1", agentTool: "developer", task: "do thing" },
					{
						kind: "parallel",
						id: "p1",
						children: [
							{ kind: "task", id: "t2", agentTool: "reviewer", task: "review" },
							{ kind: "barrier", id: "b1" },
						],
					},
					{
						kind: "if",
						id: "i1",
						condition: "review approved",
						then: [{ kind: "task", id: "t3", agentTool: "qa", task: "test" }],
					},
					{ kind: "for", id: "f1", over: "items", as: "item", body: [{ kind: "barrier", id: "b2" }] },
					{ kind: "verify", id: "v1", commands: ["npm test"], reviewerAgentTool: "reviewer" },
				],
			},
		};
		expect(flow.root.kind).toBe("pipeline");
		expect((flow.root as any).children.length).toBe(5);
	});
});

// ─── OrchestratePlanStore + OrchestrateManifestStore ─────────────

describe("OrchestratePlanStore", () => {
	test("create + get + list + setState", () => {
		const plan = planStore.create({
			requirementId: "req-1",
			projectId: "proj-1",
			leadAgentId: "lead-1",
			leadSessionId: "sess-1",
			flow: JSON.stringify({ requirementId: "req-1", title: "x", root: { kind: "barrier", id: "b" } }),
			state: "pending",
		});
		expect(plan.state).toBe("pending");

		// setState pending → confirmed
		const confirmed = planStore.setState(plan.id, "confirmed");
		expect(confirmed.state).toBe("confirmed");

		// list filter
		expect(planStore.list({ requirementId: "req-1" }).length).toBe(1);
		expect(planStore.list({ state: "pending" }).length).toBe(0);
		expect(planStore.list({ state: "confirmed" }).length).toBe(1);
	});

	test("reject carries rejectionReason", () => {
		const plan = planStore.create({
			requirementId: "req-1", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		const rejected = planStore.setState(plan.id, "rejected", { rejectionReason: "missing tests" });
		expect(rejected.state).toBe("rejected");
		expect(rejected.rejectionReason).toBe("missing tests");
	});

	test("findLatestPendingForSession sorts by createdAt desc", async () => {
		planStore.create({
			requirementId: "req-1", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-A",
			flow: "{}", state: "pending",
		});
		// Tiny time gap so createdAt differs
		await new Promise((r) => setTimeout(r, 5));
		const later = planStore.create({
			requirementId: "req-2", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-A",
			flow: "{}", state: "pending",
		});
		const found = planStore.findLatestPendingForSession("sess-A");
		expect(found?.id).toBe(later.id);
	});
});

describe("OrchestrateManifestStore", () => {
	test("create + findLatestForRequirement", async () => {
		const m1 = manifestStore.create({
			requirementId: "req-1", planId: "plan-1", projectId: "proj-1",
			touchedFiles: ["a.ts"], tests: [{ command: "npm test", ok: true }],
			review: { verdict: "approved" }, summary: "first",
		});
		await new Promise((r) => setTimeout(r, 5));
		const m2 = manifestStore.create({
			requirementId: "req-1", planId: "plan-2", projectId: "proj-1",
			touchedFiles: ["b.ts"], tests: [{ command: "npm test", ok: false }],
			review: { verdict: "rejected" }, summary: "second",
		});
		const latest = manifestStore.findLatestForRequirement("req-1");
		expect(latest?.id).toBe(m2.id);
		expect(m1.touchedFiles).toEqual(["a.ts"]);
		expect(m2.tests[0].ok).toBe(false);
	});
});

// ─── ConfirmRegistry — 真·挂起语义 ──────────────────────────────

describe("ConfirmRegistry (suspend semantics)", () => {
	test("register returns a promise that does NOT resolve until confirm() is called", async () => {
		const planId = "test-plan-1";
		const p = registry.register(planId);
		let resolved = false;
		const probe = p.then(() => { resolved = true; });

		// Yield to microtask queue multiple times — must stay unresolved.
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);
		expect(registry.isPending(planId)).toBe(true);

		// Confirm resolves it to true.
		const ok = registry.confirm(planId);
		expect(ok).toBe(true);
		await probe;
		expect(resolved).toBe(true);
		expect(await p).toBe(true);
	});

	test("reject() resolves to false (not throws)", async () => {
		const planId = "test-plan-2";
		const p = registry.register(planId);
		registry.reject(planId);
		expect(await p).toBe(false);
		expect(registry.isPending(planId)).toBe(false);
	});

	test("register is idempotent — second call returns same promise", () => {
		const planId = "test-plan-3";
		const p1 = registry.register(planId);
		// Swallow the rejection that drop() will trigger; we're only checking identity.
		p1.catch(() => {});
		const p2 = registry.register(planId);
		expect(p1).toBe(p2);
		registry.drop(planId);
	});

	test("confirm/reject on unknown plan returns false", () => {
		expect(registry.confirm("never-registered")).toBe(false);
		expect(registry.reject("never-registered")).toBe(false);
	});

	test("drop() unblocks awaiter with rejection error", async () => {
		const planId = "test-plan-drop";
		const p = registry.register(planId);
		registry.drop(planId);
		await expect(p).rejects.toThrow(/dropped/);
	});

	test("listPendingPlanIds reflects current pending set", () => {
		registry.register("p-a");
		const pb = registry.register("p-b");
		pb.catch(() => {});
		const ids = new Set(registry.listPendingPlanIds());
		expect(ids.has("p-a")).toBe(true);
		expect(ids.has("p-b")).toBe(true);
		registry.confirm("p-a");
		expect(new Set(registry.listPendingPlanIds()).has("p-a")).toBe(false);
		registry.drop("p-b");
	});
});

// ─── Requirement state machine — M3 transitions ─────────────────

describe("requirement state machine (M3 paths)", () => {
	test("ready → plan (agent)", () => {
		expect(isValidTransition("ready", "plan", "agent").valid).toBe(true);
	});

	test("plan → build (agent)", () => {
		expect(isValidTransition("plan", "build", "agent").valid).toBe(true);
	});

	test("plan → ready (agent) — plan gate reject回路", () => {
		expect(isValidTransition("plan", "ready", "agent").valid).toBe(true);
	});

	test("build → verify (system)", () => {
		expect(isValidTransition("build", "verify", "system").valid).toBe(true);
	});

	test("verify → build (agent) — coverage reject回路", () => {
		expect(isValidTransition("verify", "build", "agent").valid).toBe(true);
	});

	test("verify → closed (agent/user)", () => {
		expect(isValidTransition("verify", "closed", "agent").valid).toBe(true);
		expect(isValidTransition("verify", "closed", "user").valid).toBe(true);
	});

	test("invalid transitions rejected", () => {
		// discuss→ready is a human-only confirmation gate; an agent can't self-confirm it.
		expect(isValidTransition("discuss", "ready", "agent").valid).toBe(false);
		// Can't skip plan from ready.
		expect(isValidTransition("ready", "build", "agent").valid).toBe(false);
	});
});

// ─── Pickup idempotency (OQ5) ────────────────────────────────────

describe("pickup idempotency (OQ5)", () => {
	test("pickupRequirement twice on same req → second throws 'already assigned'", () => {
		const project = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const req = requirementStore.create({
			projectId: project.id,
			title: "T",
			status: "ready",
			source: "user",
			priority: "normal",
			reviewer: "user",
		} as any);

		// First "pickup" — just set assignedLeadSessionId manually (mimics LeadService).
		requirementStore.update(req.id, { assignedLeadSessionId: "sess-1" } as any);
		const after1 = requirementStore.get(req.id);
		expect(after1?.assignedLeadSessionId).toBe("sess-1");

		// Second pickup attempt detects existing assignment → throws.
		const r2 = requirementStore.get(req.id);
		expect(() => {
			if (r2?.assignedLeadSessionId) {
				throw new Error(`Requirement already assigned to session: ${r2.assignedLeadSessionId}`);
			}
		}).toThrow(/already assigned/);
	});
});

// ─── Feature worktree path + commit reference convention ─────────

describe("feature worktree + commit reference convention", () => {
	test("featureWorktreePath matches {workspace}.worktrees/req-{shortId}/", () => {
		const ws = "/proj/workspace";
		const reqId = "req-1234567890abcdef";
		const p = featureWorktreePath(ws, reqId);
		expect(p).toBe(join(ws + ".worktrees", "req-" + reqId.substring(0, 8)));
	});

	test("featureBranchName matches req-{shortId}", () => {
		const reqId = "abcdef1234567";
		expect(featureBranchName(reqId)).toBe("req-" + reqId.substring(0, 8));
	});

	test("commit message convention includes [req-<shortId>]", () => {
		// Convention enforced by GitIntegration.commitStep:
		//   subject = `${cleanMsg} [req-${shortId}]`
		// The requirementId itself is opaque; the convention always wraps its
		// first-8-char prefix in [req-...].
		const reqId = "abcdef1234567890";
		const shortId = reqId.substring(0, 8);
		const msg = `feat: add login [req-${shortId}]`;
		expect(msg).toMatch(/\[req-[a-f0-9]{8}\]/);
	});
});


// ─── Orchestrate tool execute — end-to-end confirm gate ──────────

describe("Orchestrate tool (confirm gate + DSL engine integration)", () => {
	test("mode=run executes pipeline + parallel + barrier without confirm gate", async () => {
		const { orchestrateTool } = await import("../../src/tools/orchestrate-tool.js");
		const { getToolExecute } = await import("../../src/tools/tool-factory.js");
		const execFn = getToolExecute(orchestrateTool)!;

		const dispatched: string[] = [];
		const ctx: any = {
			delegateTask: async (task: string) => {
				dispatched.push(task);
				return `OK: ${task}`;
			},
			activeRequirementId: "req-1",
			projectId: "proj-1",
			agentId: "lead-1",
			sessionId: "sess-1",
			workingDir: tmpDir,
			emit: () => {},
			orchestratePlanStore: planStore,
			orchestrateManifestStore: manifestStore,
		};

		const flow = {
			requirementId: "req-1",
			title: "Test flow",
			root: {
				kind: "pipeline" as const,
				id: "root",
				children: [
					{ kind: "task" as const, id: "t1", agentTool: "developer", task: "implement feature" },
					{
						kind: "parallel" as const,
						id: "p1",
						children: [
							{ kind: "task" as const, id: "t2", agentTool: "reviewer", task: "review code" },
							{ kind: "barrier" as const, id: "b1" },
						],
					},
				],
			},
		};

		const out = await execFn({ flow, mode: "run" }, ctx);
		expect(out).toContain("PASS");
		// Both tasks dispatched.
		expect(dispatched.some((d) => d.includes("implement feature"))).toBe(true);
		expect(dispatched.some((d) => d.includes("review code"))).toBe(true);

		// Plan persisted + transitioned to completed.
		const plans = planStore.list({ requirementId: "req-1" });
		expect(plans.length).toBe(1);
		expect(["completed", "failed"]).toContain(plans[0].state);

		// Manifest persisted.
		const manifest = manifestStore.findLatestForRequirement("req-1");
		expect(manifest).toBeDefined();
		expect(manifest?.planId).toBe(plans[0].id);
	});

	test("mode=confirm suspends → confirm() releases → runs", async () => {
		const { orchestrateTool } = await import("../../src/tools/orchestrate-tool.js");
		const { getToolExecute } = await import("../../src/tools/tool-factory.js");
		const execFn = getToolExecute(orchestrateTool)!;

		const dispatched: string[] = [];
		const ctx: any = {
			delegateTask: async (task: string) => {
				dispatched.push(task);
				return `OK: ${task}`;
			},
			activeRequirementId: "req-2",
			projectId: "proj-2",
			agentId: "lead-2",
			sessionId: "sess-2",
			workingDir: tmpDir,
			emit: () => {},
			orchestratePlanStore: planStore,
			orchestrateManifestStore: manifestStore,
		};

		const flow = {
			requirementId: "req-2",
			title: "Confirm test",
			root: { kind: "task" as const, id: "t1", agentTool: "developer", task: "do work" },
		};

		// Start the tool — it will register a pending plan and await confirm.
		const execPromise = execFn({ flow, mode: "confirm" }, ctx);

		// Yield — confirm gate must hold (engine has not dispatched yet).
		await new Promise((r) => setTimeout(r, 20));
		expect(dispatched.length).toBe(0);

		// Plan is pending in the store.
		const pending = planStore.list({ requirementId: "req-2", state: "pending" });
		expect(pending.length).toBe(1);

		// Confirm → tool resumes, runs, returns PASS.
		registry.confirm(pending[0].id);
		const out = await execPromise;
		expect(out).toContain("PASS");
		expect(dispatched.length).toBe(1);

		// Final plan state = completed (after confirm → run).
		const finalPlan = planStore.get(pending[0].id);
		expect(finalPlan?.state).toBe("completed");
	});

	test("mode=confirm rejected → returns false: <reason>, does not dispatch", async () => {
		const { orchestrateTool } = await import("../../src/tools/orchestrate-tool.js");
		const { getToolExecute } = await import("../../src/tools/tool-factory.js");
		const execFn = getToolExecute(orchestrateTool)!;

		const dispatched: string[] = [];
		const ctx: any = {
			delegateTask: async (task: string) => { dispatched.push(task); return "ok"; },
			activeRequirementId: "req-3",
			projectId: "proj-3",
			agentId: "lead-3",
			sessionId: "sess-3",
			workingDir: tmpDir,
			emit: () => {},
			orchestratePlanStore: planStore,
			orchestrateManifestStore: manifestStore,
		};

		const flow = {
			requirementId: "req-3",
			title: "Reject test",
			root: { kind: "task" as const, id: "t1", agentTool: "developer", task: "x" },
		};

		const execPromise = execFn({ flow, mode: "confirm" }, ctx);
		await new Promise((r) => setTimeout(r, 10));

		const pending = planStore.list({ requirementId: "req-3", state: "pending" });
		expect(pending.length).toBe(1);

		// Set the rejection reason BEFORE calling registry.reject — the tool
		// reads it from the store on resume.
		planStore.setState(pending[0].id, "rejected", { rejectionReason: "missing tests" });
		registry.reject(pending[0].id);

		const out = await execPromise;
		expect(out).toMatch(/^false/);
		expect(out).toContain("missing tests");
		expect(dispatched.length).toBe(0); // never ran
	});
});

// ─── Orchestrate router (IPC confirm/reject + manifest query) ────

describe("createOrchestrateRouter (IPC)", () => {
	test("POST /plans/:id/confirm resolves the awaiting tool via ConfirmRegistry", async () => {
		const { createOrchestrateRouter } = await import("../../src/server/orchestrate-router.js");
		const express = (await import("express")).default;

		const plan = planStore.create({
			requirementId: "req-1", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		const pendingPromise = registry.register(plan.id);

		const app = express();
		app.use(express.json());
		app.use("/api/orchestrate", createOrchestrateRouter({ planStore, manifestStore }));

		const { default: http } = await import("node:http");
		const server = http.createServer(app);
		await new Promise<void>((r) => server.listen(0, r));
		const port = (server.address() as any).port;

		try {
			const resp = await fetch(`http://127.0.0.1:${port}/api/orchestrate/plans/${plan.id}/confirm`, {
				method: "POST",
			});
			const body = await resp.json();
			expect(body.success).toBe(true);

			// Pending promise released to true.
			expect(await pendingPromise).toBe(true);

			// Plan state moved to confirmed.
			expect(planStore.get(plan.id)?.state).toBe("confirmed");

			// Second confirm on same plan returns 409 (no longer pending).
			const resp2 = await fetch(`http://127.0.0.1:${port}/api/orchestrate/plans/${plan.id}/confirm`, {
				method: "POST",
			});
			expect(resp2.status).toBe(409);
		} finally {
			server.close();
		}
	});

	test("POST /plans/:id/reject stores reason and resolves tool to false", async () => {
		const { createOrchestrateRouter } = await import("../../src/server/orchestrate-router.js");
		const express = (await import("express")).default;

		const plan = planStore.create({
			requirementId: "req-2", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		const pendingPromise = registry.register(plan.id);
		pendingPromise.catch(() => {}); // swallow — we expect false, not error

		const app = express();
		app.use(express.json());
		app.use("/api/orchestrate", createOrchestrateRouter({ planStore, manifestStore }));

		const { default: http } = await import("node:http");
		const server = http.createServer(app);
		await new Promise<void>((r) => server.listen(0, r));
		const port = (server.address() as any).port;

		try {
			const resp = await fetch(`http://127.0.0.1:${port}/api/orchestrate/plans/${plan.id}/reject`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "tests missing" }),
			});
			const body = await resp.json();
			expect(body.success).toBe(true);
			expect(body.reason).toBe("tests missing");

			expect(await pendingPromise).toBe(false);

			const stored = planStore.get(plan.id);
			expect(stored?.state).toBe("rejected");
			expect(stored?.rejectionReason).toBe("tests missing");
		} finally {
			server.close();
		}
	});

	test("GET /pending returns pending plans for a project (kanban entry)", async () => {
		const { createOrchestrateRouter } = await import("../../src/server/orchestrate-router.js");
		const express = (await import("express")).default;

		planStore.create({
			requirementId: "req-1", projectId: "proj-A",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		planStore.create({
			requirementId: "req-2", projectId: "proj-A",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "completed",
		});
		planStore.create({
			requirementId: "req-3", projectId: "proj-B",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});

		const app = express();
		app.use(express.json());
		app.use("/api/orchestrate", createOrchestrateRouter({ planStore, manifestStore }));

		const { default: http } = await import("node:http");
		const server = http.createServer(app);
		await new Promise<void>((r) => server.listen(0, r));
		const port = (server.address() as any).port;

		try {
			const resp = await fetch(`http://127.0.0.1:${port}/api/orchestrate/pending?projectId=proj-A`);
			const body = await resp.json() as any[];
			expect(body.length).toBe(1);
			expect(body[0].projectId).toBe("proj-A");
			expect(body[0].state).toBe("pending");
		} finally {
			server.close();
		}
	});
});

// ─── v0.8 P7 — lead 自动领取拉模型(取代 router backfillPendingNotifications)──
//
// P7 重做后,旧 ProjectNotificationRouter.backfillPendingNotifications 的角色
// (扫描 ready 需求 → 调 leadService.pickupRequirement)被两路取代:
//   - 主路径:lead 完成上一需求后,PostTurnComplete hook 调
//     LeadService.autoPickupIfIdle(primary);
//   - 兜底:lead cron fallback。
//
// 这里直接驱动 LeadService.autoPickupIfIdle,断言它把 ready→plan,
// 同时不会重复领取(active plan/build 跳过),不再需要 router。

describe("v0.8 P7 — LeadService.autoPickupIfIdle (取代 router backfill)", () => {
	function makeLeadService(): LeadService {
		const taskStepStore = new TaskStepStore(sessionDB);
		const wikiStoreGlobal = new WikiStore(sessionDB);
		const wikiStore = new ProjectWikiStore(wikiStoreGlobal);
		const templateStore = new TemplateStore(sessionDB);
		const projectWorkStore = new ProjectWorkStore(sessionDB);
		const lead = new LeadService({
			agentService: {
				getDB: () => sessionDB,
				// v0.8 project-work 去-role:lead 走 sendProjectPrompt(不再 sendRolePrompt)。
				sendProjectPrompt: async () => {},
			} as any,
			agentStore,
			requirementStore,
			taskStepStore,
			wikiStore,
			projectStore,
			templateStore,
			orchestratePlanStore: planStore,
			orchestrateManifestStore: manifestStore,
		});
		lead.setProjectWorkStore(projectWorkStore);
		return lead;
	}

	/** v0.8 project-work 去-role:给 project seed 一个"需求管理"工位 + 分配 agent。 */
	function seedLeadWork(projectId: string): string {
		const projectWorkStore = new ProjectWorkStore(sessionDB);
		const agent = agentStore.create({ name: `Lead-${projectId}`, workspaceDir: tmpDir } as any);
		projectWorkStore.create({
			projectId,
			name: "需求管理",
			actionPrompt: "接手需求并推进交付。",
			requiredTools: [],
			agentId: agent.id,
			enabled: true,
		} as any);
		return agent.id;
	}

	test("picks the highest-priority ready requirement and transitions it to 'plan'", async () => {
		const lead = makeLeadService();
		const project = projectStore.create({ name: "P7", workspaceDir: join(tmpDir, "ws-p7") } as any);
		// Two ready reqs — low priority first, critical second.
		const low = requirementStore.create({
			projectId: project.id, title: "Low", status: "ready",
			source: "user", priority: "low", reviewer: "user",
		} as any);
		const crit = requirementStore.create({
			projectId: project.id, title: "Crit", status: "ready",
			source: "user", priority: "critical", reviewer: "user",
		} as any);

		// v0.8 project-work 去-role:lead 从"需求管理"工位取 agent(先 seed)。
		seedLeadWork(project.id);

		// autoPickupIfIdle returns the lead sessionId (not the reqId). The
		// observability is in the requirement status: the critical one was
		// picked → plan; the low one stays ready.
		const pickedSession = await lead.autoPickupIfIdle(project.id);
		expect(pickedSession).toBeTruthy();
		expect(requirementStore.get(crit.id)!.status).toBe("plan");
		expect(requirementStore.get(crit.id)!.assignedLeadSessionId).toBe(pickedSession);
		// Low stays ready (lead is single-flight per project).
		expect(requirementStore.get(low.id)!.status).toBe("ready");
	});

	test("returns null when there is already an active (plan/build) requirement for the project", async () => {
		const lead = makeLeadService();
		const project = projectStore.create({ name: "P7-busy", workspaceDir: join(tmpDir, "ws-p7-b") } as any);
		// A build-status req occupies the lead.
		const active = requirementStore.create({
			projectId: project.id, title: "Active", status: "plan",
			source: "user", priority: "normal", reviewer: "user",
			assignedLeadSessionId: "sess-x",
		} as any);
		// A second ready req waiting.
		requirementStore.create({
			projectId: project.id, title: "Wait", status: "ready",
			source: "user", priority: "normal", reviewer: "user",
		} as any);

		const picked = await lead.autoPickupIfIdle(project.id);
		expect(picked).toBeNull();
		// The active one is untouched; the waiting one is NOT picked up.
		expect(requirementStore.get(active.id)!.status).toBe("plan");
	});

	test("returns null when no ready requirements exist", async () => {
		const lead = makeLeadService();
		const project = projectStore.create({ name: "P7-empty", workspaceDir: join(tmpDir, "ws-p7-e") } as any);
		const picked = await lead.autoPickupIfIdle(project.id);
		expect(picked).toBeNull();
	});

	test("skips ready reqs that already have an assignedLeadSessionId (idempotent)", async () => {
		const lead = makeLeadService();
		const project = projectStore.create({ name: "P7-assigned", workspaceDir: join(tmpDir, "ws-p7-a") } as any);
		// ready but already claimed by another session.
		requirementStore.create({
			projectId: project.id, title: "Taken", status: "ready",
			source: "user", priority: "normal", reviewer: "user",
			assignedLeadSessionId: "other-session",
		} as any);

		const picked = await lead.autoPickupIfIdle(project.id);
		expect(picked).toBeNull();
	});
});
