// Project（多 agent 工作流的项目实体）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `projects:*` 系列 IPC 通道,落地 Project 域的 5 个 CRUD 操作。v0.8
// P5 在 P4 的基础上把 get/create/delete 改成显式 handler,以承接 §8.3 的
// create 副作用(同步 ensureProjectSubtree + 异步 kick archivist 扫描)和
// §8.4 的容器视图聚合,以及 §8.6 的 DELETE crons 级联补丁。
//
// 通道清单:
//   - projects:list         全部项目(左栏列表用)
//   - projects:get          单个;?includeContext=true → 容器视图(§8.4)
//   - projects:create       建项目 + ensureProjectSubtree + 异步 archivist
//                            扫描(§8.3);走 ManagementService
//   - projects:update       改 name(workspaceDir immutable)
//   - projects:delete       级联:requirements + task_steps + wiki 子树 +
//                            **该 projectId 的 crons**(§8.6 补)+ project 行
//   - projects:getResourceUsage  v0.8 P5 §8.5:sessions token/cost SUM
//
// v0.8 (P4 §8.6): projects:pause / resume / updateInterval 已删除 — 这些是
// project 域 dead 调度通道 (cron 一等公民后, project 不再 own 一个 schedule)。
// 调度面统一走 crons:* (agent-scoped)。
//
// ## 输入
// - IpcContext:projectStore + cronStore + wikiStore + requirementStore +
//   taskStepStore + managementService + archivistService
//
// ## 输出
// - ProjectRecord / 容器视图 / 资源消耗 / CRUD 结果
//
// ## 定位
// src/main/ipc 下的领域 IPC 处理器;由 ipc 注册入口在初始化时调用
// registerProjectHandlers(ctx)。
//
// ## 依赖
// - ./typed-ipc.js:typedHandle
// - ./types.js:IpcContext
// - ../../shared/types.js:ProjectRecord、CreateProjectInput、UpdateProjectInput、
//   ProjectContainerView、ProjectResourceUsage
//
// ## 维护规则
// - 容器视图聚合逻辑改动同步 project-router.ts (REST 镜像)
// - 字段变更需同时更新 shared 类型与 projectStore 列定义
// - crons 级联遗漏 = bug;DELETE 必须把 project-scoped crons 一起删
//
import { ipcMain } from "electron";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type {
	ProjectRecord,
	CreateProjectInput,
	UpdateProjectInput,
} from "../../shared/types.js";

export function registerProjectHandlers(_ctx: IpcContext): void {
	// ── list ────────────────────────────────────────────────────────────
	typedHandle("projects:list", "sessionDb", async (ctx) => {
		return ctx.projectStore.list();
	});

	// ── get (§8.4 container view toggle) ────────────────────────────────
	//
	// 第二个 IPC 参数是 includeContext:boolean。true + ManagementService 可
	// 用 → 返回容器视图;否则返回纯 ProjectRecord。
	typedHandle(
		"projects:get",
		"sessionDb",
		async (ctx, id: string, includeContext?: boolean) => {
			const project = ctx.projectStore.get(id);
			if (!project) return undefined as any;
			if (includeContext && ctx.managementService) {
				return ctx.managementService.getProjectContainerView(id);
			}
			return project;
		},
	);

	// ── create (§8.3 side-effects) ──────────────────────────────────────
	//
	// 经 ManagementService.createProject,以便同步建空 wiki subtree root +
	// 异步 kick archivist 渐进扫描。ManagementService 未挂载时(tests)回退到
	// 裸 ProjectStore.create,保留向后兼容。
	typedHandle(
		"projects:create",
		"sessionDb",
		async (ctx, input: CreateProjectInput) => {
			if (ctx.managementService) {
				return ctx.managementService.createProject(input);
			}
			return ctx.projectStore.create(input);
		},
	);

	// ── update ──────────────────────────────────────────────────────────
	typedHandle(
		"projects:update",
		"sessionDb",
		async (ctx, id: string, input: UpdateProjectInput) => {
			try {
				return ctx.projectStore.update(id, input);
			} catch (e) {
				return { error: (e as Error).message };
			}
		},
	);

	// ── delete (§8.6 cascade + crons patch) ─────────────────────────────
	//
	// v0.8 (P5 §8.6): 级联补「删该 projectId 的 crons」。完整级联:
	//   - requirements → task_steps + status_history + messages
	//     (inside RequirementStore.delete)
	//   - wiki 子树 (ProjectWikiStore.deleteByProject)
	//   - **crons whose workingScope.projectId matches (P5 补)**
	//   - project 行本身
	typedHandle("projects:delete", "sessionDb", async (ctx, id: string) => {
		const { projectStore, requirementStore, wikiStore, taskStepStore, cronStore } = ctx;
		const reqs = requirementStore.listByProject(id);
		for (const r of reqs) {
			taskStepStore.deleteByRequirement(r.id);
		}
		for (const r of reqs) {
			requirementStore.delete(r.id);
		}
		wikiStore.deleteByProject(id);
		// v0.8 (P5 §8.6): delete project-scoped crons (previously missing).
		if (cronStore) {
			for (const c of cronStore.list()) {
				if (c.workingScope?.projectId === id) cronStore.delete(c.id);
			}
		}
		projectStore.delete(id);
		return { success: true as const };
	});

	// ── getResourceUsage (§8.5 — sessions token/cost SUM by projectId) ──
	//
	// 单独通道,而不是塞进容器视图 —— 仪表盘频繁刷新,容器视图开销大;资源
	// 消耗是窄聚合查询,独立刷新更省。ManagementService 未挂载时返回零值结构。
	ipcMain.handle("projects:getResourceUsage", async (_e, id: string) => {
		await ctx.whenReady("sessionDb");
		if (!ctx.managementService) {
			return {
				projectId: id,
				inputTokens: 0, outputTokens: 0, totalTokens: 0,
				cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
				estimatedCostUsd: 0, sessionCount: 0,
			};
		}
		return ctx.managementService.getProjectResourceUsage(id);
	});
}
