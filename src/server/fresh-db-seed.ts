// Fresh-DB 默认 seed (v0.8 P6 — RFC §7.1 / §7.5)
//
// # 文件说明书
//
// ## 核心功能
// 空库启动时写入 fresh-DB 默认 agent:从 zero template 实例化的全局管理 agent,
// workspaceDir = `~/.zero-core`(不绑单个项目)。protected:不可删。
//
// wiki-system-redesign plan-08 §1 cutover:旧的 wiki §10.5 子树 seed(knowledge /
// workflow / software-dev playbook / projects / memory root + 正文)全部删除。
// 它写的是被退役的 sessions.db project_wiki 表;新 wiki.db 的固定根
// (wiki-root + knowledge/memory/projects)由 `wiki/wiki-database.ts` 的
// `bootstrapFixedRoots` 在 schema init 后幂等创建,software-dev playbook 的
// 迁移到新 wiki.db 留作后续工作(plan-08 §1 不要求)。
//
// ## 触发点
// `server/index.ts` 的 `startServer` 内、所有 store 建好后、`restoreAllSessions`
// 之前,检查 `agentStore.list().length === 0` → seed zero agent。业务语义,放
// 服务层不放 migration 层(RFC §7.1)。
//
// ## protected
// - `AgentStore delete` 拒删 zero agent —— 见 agent-store.ts(store 层拦截,
//   覆盖 agent-router REST DELETE / management tool / 任何未来 caller)。
//
// ## 输入
// - agentStore
// - management (ManagementService — 用于 instantiateTemplate)
//
// ## 输出
// 无返回;写入失败仅 console.warn 不阻塞启动。
//
// ## 定位
// src/server/ — 服务层启动期 seed,被 server/index.ts 调用。
//

import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentStore } from "./agent-store.js";
import type { ManagementService } from "./management-service.js";

/**
 * Seed the fresh-DB defaults (RFC §7.1).
 *
 * STRICT FRESH-ONLY (v0.8 P7): the function is a hard no-op whenever
 * `agentStore.list().length > 0`. The caller (server/index.ts) already
 * gates on this condition; we re-check here as the authoritative guard
 * so a re-seed can never write a duplicate on a partially-populated DB.
 *
 * plan-08 §1 cutover: wikiStore param removed; legacy wiki §10.5 seed
 * (knowledge / software-dev / projects / memory root body files) deleted.
 * Those wrote the retired sessions.db project_wiki table. The new wiki.db
 * bootstrap (wiki/wiki-database.ts bootstrapFixedRoots) creates wiki-root
 * + knowledge/memory/projects containers idempotent — no service-layer
 * seed needed for the structural skeleton. Migrating the software-dev
 * playbook content to wiki.db is tracked as a follow-up (not in §1 scope).
 *
 * Both records are protected:
 * - zero agent: AgentRegistry delete rejects (management-service.ts).
 */
export function seedFreshDbDefaults(deps: {
	agentStore: AgentStore;
	management: ManagementService;
}): void {
	const { agentStore, management } = deps;

	// ─── 1. zero agent ─────────────────────────────────────────────
	// Identity in v0.8 = name + systemPrompt (RFC §1.4).
	//
	// STRICT FRESH-ONLY guard (v0.8 P7). Before P7, AgentStore's constructor
	// seeded a legacy default "Zero" agent, so a "truly empty" DB still had
	// length > 0 and a name==='zero' workaround guard was used to coexist.
	// P7 retired the legacy default (agent-store.ts), so
	// `agentStore.list().length === 0` now correctly identifies a fresh DB.
	// The caller (server/index.ts) already gates on this condition, but we
	// re-check here as a hard guarantee: this function ONLY writes on a truly
	// empty table. On any non-empty DB (legacy data, partial state, a prior
	// "Zero" capitalized record) we are a no-op — we never seed a duplicate.
	const currentAgents = agentStore.list();
	if (currentAgents.length > 0) {
		return;
	}
	try {
		management.instantiateRole("zero", {
			name: "zero",
			workspaceDir: join(homedir(), ".zero-core"),
		});
		console.log("[seed] instantiated zero agent (fresh-DB seed)");
	} catch (err) {
		console.warn("[seed] failed to seed zero agent:", (err as Error).message);
	}
}
