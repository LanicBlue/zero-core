// P6 单元测试:fresh-DB seed + protected-delete + §12 prompt 断言
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-P6.md「测试」节三条:
//   - **seed 测试** — 空库 → seed 两条(zero agent + software-dev wiki 节点);
//     非空库 → 不重复 seed(幂等)。
//   - **protected-delete 测试** — zero agent 删被拒;knowledge/software-dev
//     wiki 节点删被拒;其他 agent / wiki 节点正常删。
//   - **prompt 内容断言** — §12 关键字段:lead 提交 verify、PM 判覆盖、
//     archivist 合并 main。
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores + ManagementService。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/fresh-db-seed.ts (seedFreshDbDefaults)
//   - src/server/wiki-node-store.ts (assertNotProtected)
//   - src/server/management-service.ts (deleteAgent — zero protected)
//   - src/runtime/role-templates.ts (§12 prompts)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import { SessionDB } from "../../src/server/session-db.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { WikiStore, WIKI_GLOBAL_ROOT_ID } from "../../src/server/wiki-node-store.js";
import { ManagementService } from "../../src/server/management-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { seedFreshDbDefaults, KNOWLEDGE_ROOT_PATH, SOFTWARE_DEV_NODE_PATH } from "../../src/server/fresh-db-seed.js";
import { getTemplate } from "../../src/runtime/role-templates.js";

let tmpDir: string;
let sessionDB: SessionDB;
let agentStore: AgentStore;
let wikiStore: WikiStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p6-seed-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	agentStore = new AgentStore(sessionDB);
	const projectStore = new ProjectStore(sessionDB);
	const cronStore = new CronStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, cronStore });
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── seed: empty-ish DB ──────────────────────────────────────

describe("P6 fresh-DB seed", () => {
	test("on a fresh DB, seeds both the zero agent and the software-dev wiki node", () => {
		// Note: AgentStore's constructor seeds a legacy "Zero" default — we expect
		// seedFreshDbDefaults to additionally instantiate the v0.8 "zero" template
		// agent (lowercase) regardless, since the spec invariant is "fresh DB has
		// the v0.8 zero agent + software-dev node present".
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		// zero agent present (by name; v0.8 identity = name + systemPrompt).
		const zeroAgent = agentStore.list().find((a) => a.name === "zero");
		expect(zeroAgent, "expected seeded 'zero' agent").toBeDefined();
		// workspaceDir from RFC §7.1 = ~/.zero-core
		expect(zeroAgent!.workspaceDir).toBe(join(homedir(), ".zero-core"));
		// systemPrompt carries the zero identity (§12).
		expect(zeroAgent!.systemPrompt).toMatch(/zero/i);

		// knowledge/software-dev wiki node present under the global root.
		const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH);
		expect(knowledgeRoot, "knowledge root expected").toBeDefined();
		const softwareDevNode = wikiStore.getByParentAndPath(knowledgeRoot!.id, SOFTWARE_DEV_NODE_PATH);
		expect(softwareDevNode, "software-dev node expected").toBeDefined();
		// playbook body present and references the role roster.
		const body = wikiStore.readNodeDetail(softwareDevNode!.id);
		expect(body).toMatch(/software-dev/);
		expect(body).toMatch(/角色清单|role templates/);
		// acceptance-P6 §「software-dev 节点含工作流配置草稿」:
		// 角色清单 + subagents 关系 + cron 建议 三段都在。
		expect(body).toMatch(/subagents/);
		expect(body).toMatch(/cron/i);
	});

	test("seeding is idempotent — re-running on a seeded DB does not duplicate or clobber", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });
		const zeroCountAfterFirst = agentStore.list().filter((a) => a.name === "zero").length;
		const nodesAfterFirst = wikiStore.listVisibleFromRoot(WIKI_GLOBAL_ROOT_ID).length;

		// Re-seed.
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		const zeroCountAfterSecond = agentStore.list().filter((a) => a.name === "zero").length;
		const nodesAfterSecond = wikiStore.listVisibleFromRoot(WIKI_GLOBAL_ROOT_ID).length;

		expect(zeroCountAfterSecond).toBe(zeroCountAfterFirst);
		expect(zeroCountAfterSecond).toBe(1);
		expect(nodesAfterSecond).toBe(nodesAfterFirst);
	});

	test("seeding is idempotent even if a user refined the software-dev playbook body", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });
		const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH)!;
		const node = wikiStore.getByParentAndPath(knowledgeRoot.id, SOFTWARE_DEV_NODE_PATH)!;
		// Simulate zero/user refining the playbook.
		wikiStore.writeNodeDetail(node.id, "# user-customized playbook\n\nzero wrote this.");

		// Re-seed — must not clobber the user's body.
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		const refreshed = wikiStore.readNodeDetail(node.id);
		expect(refreshed).toMatch(/user-customized playbook/);
	});
});

// ─── protected-delete ────────────────────────────────────────

describe("P6 protected-delete", () => {
	beforeEach(() => {
		// Seed so the protected records exist.
		seedFreshDbDefaults({ agentStore, wikiStore, management });
	});

	test("deleting the seeded 'zero' agent is rejected (management.deleteAgent)", () => {
		const zeroAgent = agentStore.list().find((a) => a.name === "zero");
		expect(zeroAgent).toBeDefined();
		expect(() => management.deleteAgent(zeroAgent!.id)).toThrow(/protected/);
		// Still present.
		expect(agentStore.get(zeroAgent!.id)).toBeDefined();
	});

	test("deleting the protected knowledge root is rejected (WikiStore.delete)", () => {
		const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH)!;
		expect(() => wikiStore.delete(knowledgeRoot.id)).toThrow(/protected/);
		expect(wikiStore.get(knowledgeRoot.id)).toBeDefined();
	});

	test("deleting the protected software-dev node is rejected (WikiStore.delete)", () => {
		const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH)!;
		const softwareDevNode = wikiStore.getByParentAndPath(knowledgeRoot.id, SOFTWARE_DEV_NODE_PATH)!;
		expect(() => wikiStore.delete(softwareDevNode.id)).toThrow(/protected/);
		expect(wikiStore.get(softwareDevNode.id)).toBeDefined();
	});

	test("a normal (non-protected) agent can still be deleted — protection is scoped", () => {
		// A non-zero agent should delete normally.
		const other = management.createAgent({ name: "throwaway", systemPrompt: "x" } as any);
		expect(() => management.deleteAgent(other.id)).not.toThrow();
		expect(agentStore.get(other.id)).toBeUndefined();
	});

	test("a normal (non-protected) wiki node can still be deleted — protection is scoped", () => {
		// A user-created knowledge subtree node should delete normally.
		const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH)!;
		const userNode = wikiStore.create({
			parentId: knowledgeRoot.id,
			path: "user-playbook",
			title: "User Playbook",
			summary: "user-authored",
			type: "knowledge" as any,
		});
		expect(() => wikiStore.delete(userNode.id)).not.toThrow();
		expect(wikiStore.get(userNode.id)).toBeUndefined();
	});
});

// ─── §12 prompt content assertions ───────────────────────────

describe("P6 §12 prompt content", () => {
	test("lead prompt: pickup → plan → build → verify, with verify-gate stop and no merge to main", () => {
		const lead = getTemplate("lead")!;
		// lead submits verify and stops (no self-merge).
		expect(lead.systemPrompt).toMatch(/verify/i);
		expect(lead.systemPrompt).toMatch(/STOP|wait for/i);
		// Merging to main is archivist's job, not lead's.
		expect(lead.systemPrompt).toMatch(/merge.*archivist|archivist.*merge|Merging to main is archivist/i);
	});

	test("PM prompt: product-level coverage judgement on verify, owns discovery", () => {
		const pm = getTemplate("pm")!;
		// PM judges coverage (§4.5).
		expect(pm.systemPrompt).toMatch(/coverage/i);
		// Verdict triggers archivist merge (not PM merging itself).
		expect(pm.systemPrompt).toMatch(/trigger archivist to merge|archivist.*merge/i);
		// Discovery is PM's own responsibility (not cron's).
		expect(pm.systemPrompt).toMatch(/YOUR responsibility|your call/i);
	});

	test("archivist prompt: builds project wiki subtree AND manages the main branch", () => {
		const archivist = getTemplate("archivist")!;
		// References project files in wiki leaves (read-only).
		expect(archivist.systemPrompt).toMatch(/reference docs|project file|wiki subtree/i);
		// Manages the main branch (merge feature → main triggered by PM).
		expect(archivist.systemPrompt).toMatch(/main branch|merge.*main|Manage the main/i);
	});

	test("dev/reviewer/qa prompts: identity-only, no task Rules/Output-format in system prompt (§12.5)", () => {
		for (const id of ["developer", "reviewer", "qa"] as const) {
			const t = getTemplate(id)!;
			// Carries identity (the role name).
			expect(t.systemPrompt.toLowerCase()).toContain(id);
			// Does NOT prescribe task-level Rules / Output format headers
			// (those live in the calling tool, per §12.5).
			expect(t.systemPrompt).not.toMatch(/^#{1,3}\s*(Rules|Output format|Output Format)/m);
			expect(t.systemPrompt).not.toMatch(/\bOutput format\b/i);
		}
	});

	test("zero prompt: global management identity, references software-dev playbook under knowledge/", () => {
		const zero = getTemplate("zero")!;
		expect(zero.systemPrompt).toMatch(/knowledge\/ subtree|knowledge\/.*software-dev/i);
	});
});
