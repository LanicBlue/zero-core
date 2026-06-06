// Agent 工具持久化存储
//
// # 文件说明书
//
// ## 核心功能
// 管理 Agent 自定义工具配置的 SQLite 持久化存储
//
// ## 输入
// AgentToolEntry 数据（名称、描述、handler 配置等）
//
// ## 输出
// CRUD 操作、工具列表查询
//
// ## 定位
// src/server/ — 服务层，为 IPC 和 REST API 提供工具数据存储
//
// ## 依赖
// sqlite-store.ts、session-db.ts、shared/types.ts
//
// ## 维护规则
// 新增工具字段需同步更新 COLUMNS 数组
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { AgentToolEntry } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "description" },
	{ key: "type" },
	{ key: "enabled", bool: true },
	{ key: "agentId", column: "agent_id" },
	{ key: "transport" },
	{ key: "command" },
	{ key: "argsTemplate", column: "args_template" },
	{ key: "url" },
	{ key: "method" },
	{ key: "headers", json: true },
	{ key: "bodyTemplate", column: "body_template" },
	{ key: "responsePath", column: "response_path" },
	{ key: "timeout" },
	{ key: "blocking", bool: true },
		{ key: "auto_background_timeout" },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// AgentToolStore
// ---------------------------------------------------------------------------

export class AgentToolStore {
	private store: SqliteStore<AgentToolEntry>;
	private sessionDB: SessionDB;

	constructor(sessionDB: SessionDB) {
		this.sessionDB = sessionDB;
		this.store = new SqliteStore<AgentToolEntry>(sessionDB.getDb(), "agent_tools", COLUMNS);
	}

	/** Remove agent-tool entries that reference deleted agents. */
	cleanupOrphans(): void {
		const agentIds = new Set(
			this.sessionDB.getDb().prepare("SELECT id FROM agents").all().map((r: any) => r.id),
		);
		const orphans = this.store.list().filter(
			(e) => e.type === "internal" && e.agentId && !agentIds.has(e.agentId),
		);
		for (const o of orphans) {
			this.store.delete(o.id);
		}
	}

	list(): AgentToolEntry[] {
		return this.store.list();
	}

	get(id: string): AgentToolEntry | undefined {
		return this.store.get(id);
	}

	getByAgentId(agentId: string): AgentToolEntry | undefined {
		return this.store.list().find((e) => e.type === "internal" && e.agentId === agentId);
	}

	create(input: Omit<AgentToolEntry, "id" | "createdAt" | "updatedAt">): AgentToolEntry {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<AgentToolEntry, "id" | "createdAt">>): AgentToolEntry {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}

	deleteByAgentId(agentId: string): void {
		const entries = this.store.list().filter(
			(e) => e.type === "internal" && e.agentId === agentId,
		);
		for (const e of entries) {
			this.store.delete(e.id);
		}
	}
}
