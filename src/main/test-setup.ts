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
// src/main/ — 主进程层，仅用于 E2E 测试初始化
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
// We keep this in production source (gated by env var) so it links against
// the Electron-compiled better-sqlite3. Running it from Playwright's Node
// would fail with NODE_MODULE_VERSION mismatch.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionDB } from "../server/session-db.js";
import type { AgentStore } from "../server/agent-store.js";
import type { ProviderStore } from "../server/provider-store.js";
import { ZERO_CORE_DIR } from "../core/config.js";
import { log } from "../core/logger.js";

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
): TestSeedResult | null {
	const fixturePath = process.env.ZERO_CORE_TEST_FIXTURE;
	if (!fixturePath) return null;

	const workspaceDir = join(ZERO_CORE_DIR, "workspace");
	mkdirSync(workspaceDir, { recursive: true });

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
			models: [{ id: "mock-1", name: "Mock Model", group: "Mock" }],
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

	const agents = agentStore.list();
	const target = agents[0];
	const updated = agentStore.update(target.id, {
		name: "TestAgent",
		provider: providerName,
		model: modelId,
		workspaceDir,
	} as any);

	log.session("test", `Test environment seeded: agent=${updated.id}, fixture=${fixturePath}`);

	return {
		agentId: updated.id,
		providerName,
		modelId,
		fixturePath,
		workspaceDir,
	};
}
