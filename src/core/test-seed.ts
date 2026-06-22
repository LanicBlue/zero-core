// E2E 测试数据种子
//
// # 文件说明书
//
// ## 核心功能
// 在测试模式下（ZERO_CORE_TEST_FIXTURE 环境变量）创建 mock provider 和 agent 种子数据
//
// ## 输入
// ZERO_CORE_TEST_FIXTURE 环境变量指定的 fixture 路径
//
// ## 输出
// 写入测试用 provider、agent 和工作区配置到数据库
//
// ## 定位
// src/core/ — 共享基础设施，被主进程和服务层调用
//
// ## 依赖
// server 层各 Store、core/config.ts
//
// ## 维护规则
// 测试 fixture 变更需同步更新此文件
//
// Test-mode seed — only runs when ZERO_CORE_TEST_FIXTURE env var is set.
// Creates a mock provider pointing at the fixture and an agent using it,
// then sets the workspace config so the UI is immediately usable.
//
// We keep this in production source (gated by env var). The seed runs inside
// the backend subprocess (spawned via system Node.js in dev, Electron fork in
// packaged mode), so better-sqlite3 is always loaded with a compatible ABI.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionDB } from "../server/session-db.js";
import type { AgentStore } from "../server/agent-store.js";
import type { ProviderStore } from "../server/provider-store.js";
import type { WikiStore } from "../server/wiki-node-store.js";
import type { ProjectStore } from "../server/project-store.js";
import {
	ensureWikiSkeleton,
} from "../server/fresh-db-seed.js";
import { ZERO_CORE_DIR } from "./config.js";
import { log } from "./logger.js";

export interface TestSeedResult {
	agentId: string;
	providerName: string;
	modelId: string;
	fixturePath: string;
	workspaceDir: string;
}

export function isTestMode(): boolean {
	return !!process.env.ZERO_CORE_TEST_FIXTURE;
}

export function seedTestEnvironment(
	sessionDb: SessionDB,
	agentStore: AgentStore,
	providerStore: ProviderStore,
	wikiStore?: WikiStore,
	projectStore?: ProjectStore,
): TestSeedResult | null {
	const fixturePath = process.env.ZERO_CORE_TEST_FIXTURE;
	if (!fixturePath) return null;

	const workspaceDir = join(ZERO_CORE_DIR, "workspace");
	mkdirSync(workspaceDir, { recursive: true });

	// Dedicated workspace dir for the seeded TestProject so its workspaceDir
	// never collides with the agent workspaceDir uniqueness key. The wiki
	// project subtree is created lazily below via ensureProjectSubtree.
	const testProjectDir = join(workspaceDir, "test-project");
	mkdirSync(testProjectDir, { recursive: true });

	const providerName = "Mock";
	const existing = providerStore.list().find((p) => p.type === "mock");
	let provider;
	if (existing) {
		provider = providerStore.update(existing.id, {
			name: providerName,
			apiKey: "test",
			baseUrl: fixturePath,
			enabled: true,
		});
	} else {
		provider = providerStore.create({
			name: providerName,
			type: "mock",
			apiKey: "test",
			baseUrl: fixturePath,
			models: [{ id: "mock-1", name: "Mock Model", group: "Mock", contextWindow: 128000, maxTokens: 16384 }],
			enabled: true,
			isSystem: false,
		} as any);
	}
	const modelId = provider.models[0]?.id ?? "mock-1";

	sessionDb.getKVStore().setJson("workspace", {
		workspaceDir,
		defaultModel: modelId,
		defaultProvider: providerName,
	});

	// v0.8 P7 removed the legacy "Zero" default agent that AgentStore used to
	// seed in its constructor. On a truly-fresh test DB (agentStore.list()
	// empty), create a test agent first; otherwise patch the first existing
	// one. Either way the seed leaves exactly one ready-to-use "TestAgent".
	let target = agentStore.list()[0];
	if (!target) {
		target = agentStore.create({ name: "TestAgent" } as any);
	}
	const updated = agentStore.update(target.id, {
		name: "TestAgent",
		provider: providerName,
		model: modelId,
		workspaceDir,
	} as any);

	// Seed a SECOND test agent ("TestAgent2") so the P8 agent-config e2e
	// "subagents round-trip" test has a non-self target to pick in the
	// delegation dropdown. The subagents picker filters out the agent being
	// edited, so with only one agent in the DB there is nothing to delegate
	// to and the test cannot exercise the round-trip.
	if (agentStore.list().filter((a) => a.name === "TestAgent2").length === 0) {
		const second = agentStore.create({ name: "TestAgent2" } as any);
		agentStore.update(second.id, {
			name: "TestAgent2",
			provider: providerName,
			model: modelId,
			workspaceDir,
		} as any);
	}

	// Seed a real Project so the P8 wiki-browser "project scope" test has a
	// genuine project option to pick in the scope dropdown (the dropdown
	// option value = project.id; only "global" otherwise). The projectStore
	// uniqueness is keyed by workspaceDir, so we use a dedicated subdir.
	let testProjectId: string | undefined;
	if (projectStore) {
		try {
			const existing = projectStore.getByWorkspaceDir(testProjectDir);
			const project = existing
				? projectStore.get(existing.id)!
				: projectStore.create({
					name: "TestProject",
					workspaceDir: testProjectDir,
				});
			testProjectId = project.id;
		} catch (err) {
			log.session("test", `TestProject seed failed: ${(err as Error).message}`);
		}
	}

	log.session("test", `Test environment seeded: agent=${updated.id}, fixture=${fixturePath}`);

	// §10.5 wiki skeleton — same shape fresh-db-seed.ts plants on a truly-empty
	// DB. In test mode we create a TestAgent ABOVE, so by the time
	// seedFreshDbDefaults runs it sees agentStore.list().length > 0 and short-
	// circuits, skipping the wiki skeleton. The skeleton is idempotent
	// (ensure* helpers early-return on existing nodes), so we can safely plant
	// it here unconditionally. Without this, the P8 wiki-browser e2e opens an
	// empty tree even with the correct selectors.
	if (wikiStore) {
		try {
			ensureWikiSkeleton(wikiStore);
			// Materialize the seeded TestProject's wiki subtree so a
			// project-scoped wiki view returns a real (non-empty) tree rooted
			// at wiki-root:<projectId>. The P8 project-scope e2e asserts the
			// GLOBAL root disappears from the project view — having the
			// project subtree present makes the fixture a faithful
			// representation of a project with wiki content. Idempotent.
			if (testProjectId) {
				wikiStore.ensureProjectSubtree(testProjectId, "TestProject");
			}
		} catch (err) {
			log.session("test", `wiki skeleton seed failed: ${(err as Error).message}`);
		}
	}

	return {
		agentId: updated.id,
		providerName,
		modelId,
		fixturePath,
		workspaceDir,
	};
}
