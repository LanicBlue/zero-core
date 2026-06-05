// MCP 服务器配置持久化存储
//
// # 文件说明书
//
// ## 核心功能
// 管理 MCP（Model Context Protocol）服务器配置的 SQLite 持久化存储
//
// ## 输入
// McpServerConfig（服务器名称、命令、参数、环境变量等）
//
// ## 输出
// MCP 服务器列表、CRUD 操作结果
//
// ## 定位
// src/server/ — 服务层，为 IPC 和 REST API 提供 MCP 配置存储
//
// ## 依赖
// sqlite-store.ts、session-db.ts、shared/types.ts
//
// ## 维护规则
// 新增 MCP 配置字段需同步更新 COLUMNS 数组
//
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { McpServerConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "transport" },
	{ key: "command" },
	{ key: "args", json: true },
	{ key: "env", json: true },
	{ key: "url" },
	{ key: "headers", json: true },
	{ key: "enabled", bool: true },
	{ key: "agentIds", column: "agent_ids", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// McpStore
// ---------------------------------------------------------------------------

export class McpStore {
	private store: SqliteStore<McpServerConfig>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<McpServerConfig>(sessionDB.getDb(), "mcp_servers", COLUMNS);
	}

	list(): McpServerConfig[] {
		return this.store.list();
	}

	get(id: string): McpServerConfig | undefined {
		return this.store.get(id);
	}

	create(input: Omit<McpServerConfig, "id" | "createdAt" | "updatedAt">): McpServerConfig {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<McpServerConfig, "id" | "createdAt">>): McpServerConfig {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
