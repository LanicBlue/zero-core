// 工作区配置管理
//
// # 文件说明书
//
// ## 核心功能
// 管理工作区级别的配置（活动 Agent、Provider、工作目录等），基于 SQLite kv_store
//
// ## 输入
// SessionDB 实例、WorkspaceConfig 数据
//
// ## 输出
// loadWorkspaceConfig/saveWorkspaceConfig 函数
//
// ## 定位
// src/server/ — 服务层，为 IPC 和 API 提供工作区配置持久化
//
// ## 依赖
// session-db.ts、core/config.ts、shared/types.ts
//
// ## 维护规则
// 配置字段变更需同步更新 WorkspaceConfig 类型
//
import { join } from "node:path";
import type { SessionDB } from "../server/session-db.js";
import { ZERO_CORE_DIR } from "../core/config.js";
import type { WorkspaceConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Workspace configuration — backed by SQLite kv_store
// ---------------------------------------------------------------------------

export type { WorkspaceConfig } from "../shared/types.js";

const DEFAULT_CONFIG: WorkspaceConfig = {
	workspaceDir: join(ZERO_CORE_DIR, "workspace"),
};

const KV_KEY = "workspace";

export function loadWorkspaceConfig(db?: SessionDB): WorkspaceConfig {
	if (!db) return { ...DEFAULT_CONFIG };

	const kv = db.getKVStore();
	const stored = kv.getJson<WorkspaceConfig>(KV_KEY);
	return stored ? { ...DEFAULT_CONFIG, ...stored } : { ...DEFAULT_CONFIG };
}

export function saveWorkspaceConfig(config: Partial<WorkspaceConfig>, db: SessionDB): WorkspaceConfig {
	const current = loadWorkspaceConfig(db);
	const updated = { ...current, ...config };

	db.getKVStore().setJson(KV_KEY, updated);
	return updated;
}
