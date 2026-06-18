// PM (产品经理) IPC 处理器 (v0.8 M4 — RFC §2.5 / §2.10 / §2.17b)
//
// # 文件说明书
//
// ## 核心功能
// 注册 `requirements:doc:*`、`pm:*` 系列 IPC 通道,把前端(PM session 页面、
// 看板覆盖判断卡)与后端 PmService + RequirementDocStore 接通:
//   - requirements:doc:read / write / list —— 需求文档(repo 内 markdown)读写
//   - pm:createRequirement —— 创建需求 + 文档(看板 +New / PM cron / 用户)
//   - pm:openDiscuss      —— 看板「讨论」入口 → {PM, projectId} session
//   - pm:coverageView     —— 覆盖判断视图(意图文档 + manifest 清单)
//   - pm:coverageVerdict  —— PM 覆盖判断 verdict → notify(verify_accept/reject)
//
// ## 输入
// - IpcContext.pmService + requirementDocStore + requirementStore
// - 通道参数:projectId、requirementId、content、verdict 等
//
// ## 输出
// - 文档内容 / docPath 列表 / RequirementRecord / discuss session / verdict 结果
// - 失败路径统一返回 { error }
//
// ## 定位
// src/main/ipc 下领域 IPC 处理器;由 ipc 注册入口调用 registerPmHandlers(ctx)。
//
// ## 依赖
// - ./typed-ipc.js、./types.js
// - 间接:ctx.pmService、ctx.requirementDocStore、ctx.requirementStore
//
// ## 维护规则
// - 文档读写幂等(读不存在返回空对象,写不存在的 project 返回 error)
// - verdict 不抛错,router 缺失时返回 success:false + reason
//

import { typedHandle } from "./typed-ipc.js";
import type { RequirementPriority } from "../../shared/types.js";

export function registerPmHandlers(): void {
	// Read a requirement doc; returns { docPath?, content? } (empty if missing).
	typedHandle("requirements:doc:read", "sessionDb", (ctx, projectId, requirementId) => {
		const docStore = ctx.requirementDocStore;
		const reqStore = ctx.requirementStore;
		if (!docStore) return {};
		const content = docStore.readRequirementDoc(projectId, requirementId);
		const req = reqStore?.get(requirementId);
		return { docPath: req?.docPath, content };
	});

	// Write (create or overwrite) a requirement doc.
	typedHandle("requirements:doc:write", "sessionDb", (ctx, projectId, requirementId, content) => {
		const docStore = ctx.requirementDocStore;
		if (!docStore) return { error: "requirement doc store not available" };
		try {
			const docPath = docStore.updateRequirementDoc(projectId, requirementId, content);
			return { docPath };
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// List all requirement docs for a project (doc panel in PM session page).
	typedHandle("requirements:doc:list", "sessionDb", (ctx, projectId) => {
		const docStore = ctx.requirementDocStore;
		if (!docStore) return [];
		return docStore.listRequirementDocs(projectId);
	});

	// Create a requirement + repo doc in one shot (PM cron / kanban +New / user).
	typedHandle("pm:createRequirement", "sessionDb", (ctx, input) => {
		const pm = ctx.pmService;
		if (!pm) return { error: "pm service not available" };
		try {
			const req = pm.createRequirementWithDoc({
				projectId: input.projectId,
				title: input.title,
				summary: input.summary,
				body: input.body,
				priority: input.priority as RequirementPriority | undefined,
				source: input.source,
			});
			return req;
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// v0.8 P7 (§4.2): open the {PM, projectId} discuss session — route by
	// requirementId → read req.createdByAgentId → resolve PM session.
	// No roleTag scan. Returns { agentId, sessionId, created }; renderer does
	// the page navigation + opens the requirement doc.
	typedHandle("pm:openDiscuss", "sessionDb", (ctx, requirementId) => {
		const pm = ctx.pmService;
		if (!pm) return { error: "pm service not available" };
		try {
			const resolved = pm.openDiscussSession(requirementId);
			return {
				agentId: resolved.agentId,
				sessionId: resolved.session.id,
				created: resolved.created,
			};
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Coverage judgement view: requirement intent doc + latest manifest.
	typedHandle("pm:coverageView", "sessionDb", (ctx, requirementId) => {
		const pm = ctx.pmService;
		if (!pm) return {};
		return pm.buildCoverageView(requirementId);
	});

	// v0.8 P7 (§4.6): submit PM coverage verdict → drives ArchivistService
	// merge (covered=true) or feedback record (covered=false). Returns the
	// final requirement status + merge result so the UI can reflect the
	// end-to-end outcome.
	typedHandle("pm:coverageVerdict", "sessionDb", async (ctx, requirementId, covered, reason?) => {
		const pm = ctx.pmService;
		if (!pm) return { error: "pm service not available" };
		try {
			const outcome = await pm.submitCoverageVerdict(requirementId, { covered, reason });
			return {
				success: true,
				requirementId,
				kind: covered ? "verify_accept" as const : "verify_reject" as const,
				finalStatus: outcome.finalStatus,
				mergeOk: outcome.merge?.ok,
			};
		} catch (e) {
			return { error: (e as Error).message };
		}
	});
}
