// Agent 存储
//
// # 文件说明书
//
// ## 核心功能
// Agent 数据持久化，基于 SqliteStore 的 CRUD 操作。
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
// - ../core/default-prompt - 默认提示词
//
// ## 维护规则
// - 新增字段时需更新列定义
//
import { join } from "node:path";
import { homedir } from "node:os";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import { buildDefaultPrompt } from "../core/default-prompt.js";
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
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_AGENT: Omit<AgentRecord, "id" | "createdAt" | "updatedAt"> = {
	name: "Zero",
	systemPrompt: buildDefaultPrompt("Zero"),
};

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

	constructor(sessionDB: SessionDB) {
		this.db = sessionDB;
		this.store = new SqliteStore<AgentRecord>(sessionDB.getDb(), "agents", COLUMNS);

		// Ensure at least one default agent exists
		if (this.store.list().length === 0) {
			const defaultWs = join(ZERO_CORE_DIR, "workspace");
			this.store.create({ ...DEFAULT_AGENT, workspaceDir: defaultWs } as any);
		}
	}

	list(): AgentRecord[] {
		return this.store.list();
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
		this.store.delete(id);
	}
}
