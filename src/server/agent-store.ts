// Agent 存储
//
// # 文件说明书
//
// ## 核心功能
// Agent 数据持久化，基于 SqliteStore 的 CRUD 操作。
//
// ## v0.8 P7 重做要点
// - **删 legacy "Zero" 默认 seed**(P6 留给本阶段清掉)。store 不再在构造函数
//   里塞一个名为 "Zero" 的默认 agent;真正空库时 `agentStore.list().length===0`
//   成立。fresh-DB 的真正默认 seed(zero agent + software-dev wiki 节点)由
//   `fresh-db-seed.ts` 在服务层(startServer 内、所有 store 建好后)按
//   `agentStore.list().length === 0` 判断写入(RFC §7.1),不再埋在 store 里。
//
// ## 输入
// - SessionDB 实例
// - Agent 数据
//
// ## 输出
// - AgentRecord CRUD
//
// ## 定位
// 服务层存储，被 agent-service 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { AgentRecord } from "../shared/types.js";
import { ZERO_CORE_DIR } from "../core/config.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "workspaceDir", column: "workspace_dir" },
	{ key: "model" },
	{ key: "provider" },
	{ key: "thinkingLevel", column: "thinking_level" },
	{ key: "contextConfig", column: "context_config", json: true },
	{ key: "systemPrompt", column: "system_prompt" },
	{ key: "toolPolicy", column: "tool_policy", json: true },
	{ key: "skillPolicy", column: "skill_policy", json: true },
	{ key: "knowledgeBaseIds", column: "knowledge_base_ids", json: true },
	// v0.8 (P0 §2.2): subagents + wikiAnchors — JSON single-column round-trip
	// (parity with knowledgeBaseIds). role_tag is INTENTIONALLY OMITTED — the
	// physical column is retained (legacy) but store no longer round-trips it.
	{ key: "subagents", json: true },
	{ key: "wikiAnchors", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWorkspaceDir(dir: string | undefined): string | undefined {
	if (!dir) return join(ZERO_CORE_DIR, "workspace");
	let d = dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir;
	const sep = process.platform === "win32" ? "\\" : "/";
	d = d.replace(/[/\\]+/g, sep);
	return d;
}

// ---------------------------------------------------------------------------
// AgentStore
// ---------------------------------------------------------------------------

export class AgentStore {
	private store: SqliteStore<AgentRecord>;
	private db: SessionDB;
	/**
	 * v0.8 (P0 §1.4): prepared statement to read the legacy `role_tag` column
	 * for listByRoleTag. The column is not in COLUMNS so SqliteStore doesn't
	 * round-trip it; we read it raw here for any runtime/service callers that
	 * still depend on role-tag filtering. P7 removed the major callers
	 * (findPmAgent / ProjectNotificationRouter); the workflow path no longer
	 * uses roleTag, addressing goes through req-recorded agentIds. Retained
	 * as a low-level escape hatch for diagnostics / future callers.
	 */
	private _roleTagStmt?: import("better-sqlite3").Statement;

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB;
		this.store = new SqliteStore<AgentRecord>(sessionDB.getDb(), "agents", COLUMNS);

		// v0.8 P7: NO legacy "Zero" default seed. A truly-empty agents table
		// yields `list().length === 0`. Fresh-DB defaults (zero agent +
		// software-dev wiki node) are seeded by fresh-db-seed.ts at the
		// service layer (RFC §7.1). Removing this lets fresh-db-seed's
		// `agentStore.list().length === 0` guard fire correctly.
	}

	list(): AgentRecord[] {
		return this.store.list();
	}

	/**
	 * List agents by legacy roleTag (preset entry grouping).
	 *
	 * v0.8 (P0 §1.4): roleTag was removed from AgentRecord. The physical
	 * `role_tag` column is retained for legacy data; this method reads it raw
	 * (it's not in COLUMNS, so SqliteStore won't surface it). v0.8 P7 removed
	 * the workflow-path callers (findPmAgent / ProjectNotificationRouter);
	 * cross-agent addressing now goes through req-recorded agentIds
	 * (req.createdByAgentId / reviewerAgentId). Retained as a low-level
	 * escape hatch for diagnostics / future callers — NOT used by the
	 * requirement lifecycle (§1.5).
	 */
	listByRoleTag(roleTag: string): AgentRecord[] {
		if (!this._roleTagStmt) {
			this._roleTagStmt = this.db.getDb().prepare(
				"SELECT id FROM agents WHERE role_tag = ?",
			);
		}
		const matchingIds = new Set(
			(this._roleTagStmt.all(roleTag) as Array<{ id: string }>).map((r) => r.id),
		);
		if (matchingIds.size === 0) return [];
		return this.store.list().filter((a) => matchingIds.has(a.id));
	}

	get(id: string): AgentRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		const normalized = { ...input };
		normalized.workspaceDir = normalizeWorkspaceDir(normalized.workspaceDir);
		return this.store.create(normalized as any);
	}

	update(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		const patched = { ...input };
		if (patched.workspaceDir !== undefined) {
			patched.workspaceDir = normalizeWorkspaceDir(patched.workspaceDir);
		}
		return this.store.update(id, patched as any);
	}

	delete(id: string): void {
		// v0.8 P7 §7.3: zero agent is protected at the STORE layer so every
		// deletion path (agent-router REST DELETE, management tool, any future
		// caller) is uniformly blocked. Identity in v0.8 = name + systemPrompt
		// (RFC §1.4); the fresh-DB seed instantiates it as name "zero"
		// (lowercase). Match case-insensitively to absorb display variants.
		const agent = this.store.get(id);
		if (agent && typeof agent.name === "string" && agent.name.toLowerCase() === "zero") {
			throw new Error("Cannot delete the protected 'zero' management agent");
		}
		this.store.delete(id);
	}
}
