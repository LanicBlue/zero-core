// project-work 存储(取代工作流角色的"工位/工作"系统)
//
// # 文件说明书
//
// ## 核心功能
// ProjectWorkRecord 持久化,基于 SqliteStore 的 CRUD。一个 project_work = 项目里
// 定义的一项工作(具体职责),带动作 prompt + requiredTools + agentId(可空)+
// contextPolicy + hooks。触发源由 cron(crons.work_id)/hook(inline)/手动驱动,
// 不在本表;本表只持有"工作定义"本身。
//
// ## 输入
// - CoreDatabase 实例
// - ProjectWorkRecord 数据
//
// ## 输出
// - ProjectWorkRecord CRUD + listByProject + listWithHook
//
// ## 定位
// 服务层存储,被 ManagementService / ProjectWorkRunner / ProjectWorkHookManager 使用。
//
// ## 依赖
// - ./sqlite-store - 通用存储
// - ../shared/types - ProjectWorkRecord
//
// ## 维护规则
// - 新增字段时需同步 db-migration.ts 的 PROJECT_WORK_COLUMNS(否则 fresh DB 缺列)
// - requiredTools/contextPolicy/hooks 作为 JSON 整列存储
// - 删 work 不级联删它引用的 agent(解绑而非级联);cron 触发器由 ManagementService 清理
//

import type { CoreDatabase } from "./core-database.js";
import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { ProjectWorkRecord, WorkHookTrigger } from "../shared/types.js";

// MUST stay in sync with db-migration.ts PROJECT_WORK_COLUMNS.
const PROJECT_WORK_COLUMNS: ColumnDef[] = [
	{ key: "projectId", column: "project_id" },
	{ key: "name" },
	{ key: "actionPrompt", column: "action_prompt" },
	{ key: "requiredTools", column: "required_tools", json: true },
	{ key: "agentId", column: "agent_id" },
	{ key: "contextPolicy", column: "context_policy", json: true },
	{ key: "hooks", json: true },
	{ key: "enabled", bool: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

export class ProjectWorkStore {
	private store: SqliteStore<ProjectWorkRecord>;

	constructor(sessionDB: CoreDatabase) {
		this.store = new SqliteStore<ProjectWorkRecord>(
			sessionDB.getDb(),
			"project_work",
			PROJECT_WORK_COLUMNS,
		);
	}

	list(): ProjectWorkRecord[] {
		return this.store.list();
	}

	/** 列出某 project 的全部 work。 */
	listByProject(projectId: string): ProjectWorkRecord[] {
		return this.store.findAllByColumns({ projectId });
	}

	/**
	 * 列出监听指定 hook 事件的全部 work(跨 project)。ProjectWorkHookManager 收到
	 * data-change-hub 事件后用此找到候选,再按 record.projectId 过滤。
	 * event 形如 "requirement.created"。
	 */
	listWithHook(event: string): ProjectWorkRecord[] {
		return this.list().filter((w) => {
			if (!w.enabled || !Array.isArray(w.hooks)) return false;
			return w.hooks.some((h: WorkHookTrigger) => h.enabled && h.event === event);
		});
	}

	get(id: string): ProjectWorkRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<ProjectWorkRecord, "id" | "createdAt" | "updatedAt">): ProjectWorkRecord {
		return this.store.create(input);
	}

	update(id: string, patch: Partial<Omit<ProjectWorkRecord, "id" | "createdAt">>): ProjectWorkRecord {
		return this.store.update(id, patch);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}
