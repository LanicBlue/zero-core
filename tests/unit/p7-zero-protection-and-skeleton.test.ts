// P7 收尾验收:zero store 层保护 + wiki §10.5 骨架根
//
// # 文件说明书
//
// ## 核心功能
// 验收 sub1 三项修复:
//   1. **zero 保护下沉 store 层** —— `AgentStore.delete` 直接拦 name==="zero"
//      (case-insensitive: "zero" / "Zero" / "ZERO" 都拦)。这是 router REST
//      DELETE 路径(agent-router.ts:71 直接 `agentStore.delete`)唯一经过的层,
//      所以 store 拦住了 = router 路径也拦住了,绕不过去。
//   2. **syncFromAgents 已删** —— project-store.ts 不再从 agent.workspaceDir
//      自动建项目(此点不在 store 层,这里只验证 zero agent 的 ~/.zero-core
//      workspaceDir 不会因为 seed 而变成一个项目)。
//   3. **wiki §10.5 骨架根** —— fresh-DB seed 写入 knowledge / projects /
//      memory / software-dev 四个顶层结构节点(global root 直接子节点)。
//
// ## 为什么和 p6-fresh-db-seed.test.ts 分开
// P6 测试覆盖的是 P6 阶段的契约(zero + software-dev)。这里覆盖 P7 收尾
// 新增的契约:
//   - **store 层直接拦截**(P6 测试只测 management.deleteAgent 路径,不测
//     agentStore.delete 直接调用 —— 即 router 路径)。
//   - **大小写不敏感**(P6 测试只测 lowercase "zero")。
//   - **projects/memory 骨架根**(P6 测试时这俩根还没加)。
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores + ManagementService。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/agent-store.ts (delete — store 层保护)
//   - src/server/wiki-node-store.ts (PROJECTS_ROOT_PATH_SEED / MEMORY_ROOT_PATH_SEED)
//   - src/server/fresh-db-seed.ts (ensureProjectsRoot / ensureMemoryRoot)
//   - src/server/agent-router.ts:71 (REST DELETE 直调 agentStore.delete)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	PROJECTS_ROOT_PATH_SEED,
	MEMORY_ROOT_PATH_SEED,
	KNOWLEDGE_ROOT_PATH_SEED,
	WORKFLOW_PATH_SEED,
	SOFTWARE_DEV_NODE_PATH_SEED,
} from "../../src/server/wiki-node-store.js";
import { ManagementService } from "../../src/server/management-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { seedFreshDbDefaults } from "../../src/server/fresh-db-seed.js";

let tmpDir: string;
let sessionDB: SessionDB;
let agentStore: AgentStore;
let projectStore: ProjectStore;
let cronStore: CronStore;
let wikiStore: WikiStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p7-skeleton-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	agentStore = new AgentStore(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, cronStore, wikiStore });
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── ① zero 保护:store 层 + router 路径 + case-insensitive ───────

describe("P7 zero agent — store-layer protection", () => {
	test("AgentStore.delete directly rejects name='zero' (the router path)", () => {
		// agent-router.ts:71 calls `agentStore.delete(req.params.id)` directly —
		// NOT management.deleteAgent. So protection MUST fire at the store layer.
		seedFreshDbDefaults({ agentStore, wikiStore, management });
		const zero = agentStore.list().find((a) => a.name === "zero")!;
		expect(zero, "seeded zero agent expected").toBeDefined();

		// Store-level delete rejects.
		expect(() => agentStore.delete(zero.id)).toThrow(/protected/i);
		// Still present.
		expect(agentStore.get(zero.id)).toBeDefined();
	});

	test("protection is case-insensitive — 'Zero' / 'ZERO' / 'zErO' all rejected", () => {
		// Identity match must absorb display variants (some legacy rows may carry
		// capitalized "Zero" from the pre-P7 default seed).
		for (const variant of ["Zero", "ZERO", "zErO"]) {
			const a = agentStore.create({
				name: variant,
				systemPrompt: "x",
				workspaceDir: join(tmpDir, "w"),
			} as any);
			expect(() => agentStore.delete(a.id)).toThrow(/protected/i);
			expect(agentStore.get(a.id), `${variant} should still exist after rejected delete`).toBeDefined();
		}
	});

	test("a normal agent (name !== 'zero') is deletable at the store layer", () => {
		const other = agentStore.create({
			name: "disposable-agent",
			systemPrompt: "x",
			workspaceDir: join(tmpDir, "w"),
		} as any);
		expect(() => agentStore.delete(other.id)).not.toThrow();
		expect(agentStore.get(other.id)).toBeUndefined();
	});

	test("deleting an unknown id at the store layer is a no-op (does not throw)", () => {
		// No row → no name match → falls through to store.delete (which is a
		// no-op on missing ids in SqliteStore). Important so the router's
		// `agentStore.delete(req.params.id)` doesn't 500 on a stale id.
		expect(() => agentStore.delete("nonexistent-id")).not.toThrow();
	});
});

// ─── ② syncFromAgents 已删:zero seed 不会被建成 project ───────────

describe("P7 syncFromAgents removal — zero workspace is NOT a project", () => {
	test("after fresh-DB seed, projects list is empty (zero's ~/.zero-core not auto-built)", () => {
		// v0.7 used to auto-create a project from every agent.workspaceDir; that
		// path turned zero's ~/.zero-core platform dir into a bogus "zero"
		// project + archivist-scanned junk wiki nodes. v0.8 removed the sync.
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		// Service-layer list (what projectsList IPC returns).
		expect(management.listProjects(), "no project should be auto-created from zero seed").toEqual([]);
		// Store-level list (belt + suspenders).
		expect(projectStore.list()).toEqual([]);
	});
});

// ─── ③ wiki §10.5 骨架根:knowledge + projects + memory + software-dev ──

describe("P7 wiki §10.5 skeleton — fresh-DB seeds all four top-level nodes", () => {
	test("global root has knowledge / projects / memory as direct children", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		const children = wikiStore.getChildren(WIKI_GLOBAL_ROOT_ID);
		const childPaths = children.map((n) => n.path).sort();

		// Three §10.5 skeleton roots hang directly under the global root.
		expect(childPaths, "expected the three §10.5 top-level roots").toEqual(
			expect.arrayContaining([
				KNOWLEDGE_ROOT_PATH_SEED,
				PROJECTS_ROOT_PATH_SEED,
				MEMORY_ROOT_PATH_SEED,
			]),
		);
	});

	test("each skeleton root is addressable by its (parent, path) seed constant", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		// Direct lookups using the exported seed constants — proves the wiki
		// browser can find each top-level branch on a fresh DB.
		expect(
			wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED),
			"knowledge root",
		).toBeDefined();
		expect(
			wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, PROJECTS_ROOT_PATH_SEED),
			"projects root",
		).toBeDefined();
		expect(
			wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, MEMORY_ROOT_PATH_SEED),
			"memory root",
		).toBeDefined();
	});

	test("software-dev node hangs under knowledge/workflow (regression guard)", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		const knowledgeRoot = wikiStore.getByParentAndPath(
			WIKI_GLOBAL_ROOT_ID,
			KNOWLEDGE_ROOT_PATH_SEED,
		)!;
		const workflow = wikiStore.getByParentAndPath(
			knowledgeRoot.id,
			WORKFLOW_PATH_SEED,
		);
		expect(workflow, "workflow category node expected under knowledge root").toBeDefined();
		const softwareDev = wikiStore.getByParentAndPath(
			workflow!.id,
			SOFTWARE_DEV_NODE_PATH_SEED,
		);
		expect(softwareDev, "software-dev leaf expected under knowledge/workflow").toBeDefined();
	});

	test("projects / memory skeleton roots are NOT protected (deletable navigation)", () => {
		// Spec: these are navigation skeletons, NOT anchors — they should be
		// deletable so a user can clean up if desired (contrast with knowledge
		// root + software-dev leaf which ARE protected).
		seedFreshDbDefaults({ agentStore, wikiStore, management });

		const projectsRoot = wikiStore.getByParentAndPath(
			WIKI_GLOBAL_ROOT_ID,
			PROJECTS_ROOT_PATH_SEED,
		)!;
		const memoryRoot = wikiStore.getByParentAndPath(
			WIKI_GLOBAL_ROOT_ID,
			MEMORY_ROOT_PATH_SEED,
		)!;

		expect(() => wikiStore.delete(projectsRoot.id)).not.toThrow();
		expect(() => wikiStore.delete(memoryRoot.id)).not.toThrow();
		expect(wikiStore.get(projectsRoot.id)).toBeUndefined();
		expect(wikiStore.get(memoryRoot.id)).toBeUndefined();
	});

	test("seeding is idempotent — re-running does not duplicate the skeleton roots", () => {
		seedFreshDbDefaults({ agentStore, wikiStore, management });
		const firstChildren = wikiStore.getChildren(WIKI_GLOBAL_ROOT_ID).length;

		seedFreshDbDefaults({ agentStore, wikiStore, management });
		const secondChildren = wikiStore.getChildren(WIKI_GLOBAL_ROOT_ID).length;

		expect(secondChildren).toBe(firstChildren);
	});
});
