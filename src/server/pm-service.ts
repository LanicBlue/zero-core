// PM (产品经理) 服务 (v0.8 P7 — 拉模型重做,RFC §4.2 / §4.5 / §4.6)
//
// # 文件说明书
//
// ## 核心功能
// PM 行为原语,被 IPC discuss/coverage handler + Flow.verify(复合覆盖判断闭环,
// project-flow F3)调用:
//   1. createRequirementWithDoc()    —— 把一条发现落成 RequirementRecord +
//      repo 内需求文档 + docPath 绑定 (决策 12/14)。wiki 意图节点由 archivist
//      兜底建,不由 PM/本服务写。
//   2. judgeCoverage() / submitCoverageVerdict() —— verify 时 PM 看清单判覆盖
//      (决策 34)。verdict 路由(§4.5/§4.6):
//        - covered=true  → 委派/触发 archivist 合并 feature→main + 增量扫描
//          (archivistService.mergeFeatureToMain,本服务直接同步调用)→ 置
//          requirement.status="closed"(=archived,见下)。
//        - covered=false → 意见写回 requirement.addMessage;lead 被重新激活
//          时读到 → 改计划重提 verify(§4.5)。
//   3. openDiscussSession() —— 看板「讨论」入口 → 按 req.createdByAgentId
//      定位建该需求的 PM agent,resolve {PM, projectId} session。
//
// ## v0.8 P7 重做要点(RFC §1.5 / §4)
// - 删 findPmAgent(roleTag 查找)——寻址全用 req 记录的 agentId。
// - 删 ProjectNotificationRouter 依赖——拉模型,无中央路由。
// - submitCoverageVerdict 直接驱动 archivistService 合并 + 状态置 closed。
//
// ## status="closed" 语义
// RequirementStatus 仅含 "closed"(无 "archived")。规范 §4.6/§5 用的「archived」
// 在代码里以 "closed" 承载;这是数据模型与规范的命名差异,行为一致(requirement
// 交付完成、git 已合并)。
//
// ## 写隔离 (决策 7/18)
// - PM 只发现/创建新需求,不改已有需求文档;对 wiki 树结构和代码 read-only
//   (本服务用 RequirementDocStore.buildNewRequirementDoc 实现幂等新建,
//   用 WikiNodeStore 读 wiki,不写结构)。
//
// ## reviewerAgentId 语义 (决策 34)
// = 覆盖判断方,默认 = 创建该需求的 PM (createdByAgentId)。不是技术 accept
// (技术验收在 Orchestrate 流程内)。不引入 productionReady 多门禁聚合。
//
// ## 输入
// - AgentService / AgentStore / ProjectStore / RequirementStore
// - RequirementDocStore (需求文档读写)
// - WikiNodeStore (读 wiki 上下文)
// - OrchestrateManifestStore (verify 时读清单)
// - ArchivistService (verify 通过 → 触发合并 + 增量扫描,§4.6)
// - SessionDB / SessionContextRouter (discuss 路由)
//
// ## 输出
// - PmService 类
//
// ## 定位
// 服务层,被 IPC handler + Flow.verify(复合覆盖判断,project-flow F3)使用。
//
// ## 依赖
// - ./agent-service, ./agent-store, ./project-store
// - ./requirement-store, ./requirement-doc-store
// - ./wiki-node-store, ./orchestrate-store, ./archivist-service
// - ./session-context-router, ./session-db
//
// ## 维护规则
// - cron 触发路径与 discuss 路径共用同一 {PM, projectId} session (决策 13/14)
// - 所有写操作幂等 (重扫同 project 不重复建需求)
// - 异常不抛出到 cron 触发器 (cron-analysis 会 catch,这里也 best-effort)
//

import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { RequirementDocStore } from "./requirement-doc-store.js";
import type { WikiStore } from "./wiki-node-store.js";
import type { OrchestrateManifestStore } from "./orchestrate-store.js";
import type { WikiSkeletonService } from "./wiki-skeleton-service.js";
import type { SessionDB } from "./session-db.js";
import type {
	AgentRecord,
	RequirementRecord,
	RequirementPriority,
	OrchestrateManifestRecord,
} from "../shared/types.js";
import {
	resolveSessionByRoleProject,
	type WikiRootResolver,
} from "./session-context-router.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// PmService
// ---------------------------------------------------------------------------

export interface PmServiceDeps {
	agentService: AgentService;
	agentStore: AgentStore;
	projectStore: ProjectStore;
	requirementStore: RequirementStore;
	requirementDocStore: RequirementDocStore;
	wikiNodeStore: WikiStore;
	manifestStore?: OrchestrateManifestStore;
	/** v0.8 P7: archivist 合并入口(verify 通过 → mergeFeatureToMain + 增量扫描)。 */
	archivistService?: WikiSkeletonService;
	sessionDB: SessionDB;
	resolveWikiRoot?: WikiRootResolver;
}

export interface CoverageVerdict {
	/** true = changes+tests cover the requirement intent; false = gap. */
	covered: boolean;
	/** Free-text reason / gaps. */
	reason?: string;
}

export interface MergeResult {
	ok: boolean;
	ref?: string;
	error?: string;
}

export interface CoverageVerdictOutcome {
	/** Whether the verdict was a pass (covered) or fail (gap). */
	covered: boolean;
	/** PM agent id that issued the verdict. */
	reviewerAgentId?: string;
	/** When covered=true: result of the archivist merge (ok/ref/error). */
	merge?: MergeResult;
	/** Final requirement status after the verdict (closed = archived). */
	finalStatus: string;
}

// tool-decoupling(决策 1):process-wide 单例 getter/setter。启动时注册;
// 工具(Flow 的 PM-session 路径 / verify 复合关闭)import { getPmService }
// 直读。headless 无则 undefined。
let _pmService: PmService | undefined;
export function getPmService(): PmService | undefined {
	return _pmService;
}
export function setPmService(s: PmService | undefined): void {
	_pmService = s;
}

export class PmService {
	private deps: PmServiceDeps;

	constructor(deps: PmServiceDeps) {
		this.deps = deps;
	}

	// ─── Discovery path ─────────────────────────────────────────────────
	//
	// v0.8 (M4 design): PM discovery is fully agent-driven. There is NO
	// service-level "discoverAndCreateRequirement" — the cron only sends a
	// prompt that wakes the PM session; PM itself decides what to scan, which
	// analyzer agent-tools to call, and which findings to turn into
	// requirements via the Flow.create tool (project-flow F3; the legacy
	// CreateRequirementWithDoc tool was retired in F3 and its file deleted in
	// F5). Flow.create routes through the createRequirementWithDoc primitive
	// below when the PM session drives it. The platform's only job is to seed
	// PM's system prompt + tool allowlist + the cron's prompt — all done by
	// the user (zero role) at PM instantiation time.

	/**
	 * Read a short summary of the project wiki subtree for PM context (decision
	 * 7 — PM 读 archivist wiki 写需求). Returns at most N node summaries.
	 */
	readProjectWikiSummary(projectId: string, maxNodes = 25): string {
		try {
			const nodes = this.deps.wikiNodeStore.listByProject(projectId);
			if (nodes.length === 0) return "";
			const slice = nodes.slice(0, maxNodes);
			return slice
				.map((n: { type: string; title: string; summary?: string }) =>
					`- [${n.type}] ${n.title}${n.summary ? ` — ${n.summary}` : ""}`)
				.join("\n");
		} catch (err) {
			log.debug("pm", `Wiki read failed for ${projectId}: ${(err as Error).message}`);
			return "";
		}
	}

	// ─── Requirement + doc creation (decision 12/14) ─────────────────────

	/**
	 * Create a new requirement (record + repo doc) from a PM discovery or a
	 * user-created requirement. Idempotent on title+project: if a requirement
	 * with the same title already exists in this project, returns it unchanged
	 * (PM cron re-scan safety).
	 *
	 * createdByAgentId MUST be supplied (the PM agent that's creating this).
	 * reviewerAgentId defaults to createdByAgentId (decision 34).
	 */
	createRequirementWithDoc(input: {
		projectId: string;
		title: string;
		summary?: string;
		body?: string;
		priority?: RequirementPriority;
		source?: "agent" | "user";
		/** PM agent creating this; required for v0.8 address-by-agentId. */
		createdByAgentId?: string;
	}): RequirementRecord {
		const project = this.deps.projectStore.get(input.projectId);
		if (!project) {
			throw new Error(`Project not found: ${input.projectId}`);
		}

		// Idempotency: same title in same project → no-op.
		const existing = this.deps.requirementStore
			.listByProject(input.projectId)
			.find((r) => r.title === input.title);
		if (existing) {
			log.debug("pm", `Requirement "${input.title}" already exists in ${input.projectId}; skipping`);
			return existing;
		}

		const createdByAgentId = input.createdByAgentId;
		// v0.8 P7: address by agentId — no roleTag lookup. Discovery path requires
		// the caller (PM tool / IPC) to supply createdByAgentId. We do NOT fall
		// back to a global PM scan; that was the legacy findPmAgent path that
		// P7 removes. If missing, the requirement is still created (creator
		// stamp blank), and discuss/verify will route via reviewerAgentId at
		// verify time.
		if (!createdByAgentId) {
			log.debug("pm", `createRequirementWithDoc: createdByAgentId missing for "${input.title}" — discuss/verify routing will require explicit agentId at use time`);
		}

		// Create the RequirementRecord first (store mints the id), carrying the
		// agent fields (RFC §4.5). docPath is filled in after we know the id.
		const req = this.deps.requirementStore.create({
			projectId: input.projectId,
			title: input.title,
			description: input.summary,
			status: "discuss",
			source: input.source === "user" ? "user" : "agent", // RequirementSource compat
			priority: input.priority ?? "normal",
			createdByAgentId,
			reviewerAgentId: createdByAgentId, // decision 34: defaults to the PM that created it
		} as any);

		// Write the repo doc named after the real requirement id (idempotent —
		// won't overwrite if exists, so re-scans are safe per decision 7).
		const body = input.body ?? this.defaultRequirementDocBody(input.title, input.summary);
		const docPath = this.deps.requirementDocStore.buildNewRequirementDoc(
			input.projectId,
			req.id,
			body,
		);

		// Stamp the docPath onto the record.
		const updated = this.deps.requirementStore.update(req.id, { docPath } as any);

		log.agent(`PM created requirement "${input.title}" → ${docPath}`);
		return updated;
	}

	/** Default markdown body for a freshly discovered requirement doc. */
	private defaultRequirementDocBody(title: string, summary?: string): string {
		const now = new Date().toISOString();
		return [
			`# ${title}`,
			"",
			`> Created by PM · ${now}`,
			"> Status: discuss",
			"",
			"## Intent",
			"",
			summary?.trim() || "_(To be refined during discuss.)_",
			"",
			"## Discussion",
			"",
			"_(PM and user refine the requirement here. Status moves to 'ready' on confirmation.)_",
			"",
		].join("\n");
	}

	// ─── Discuss entry (decision 13/14, v0.8 P7 by createdByAgentId) ──────

	/**
	 * Open (find-or-create) the {PM, projectId} session — the single discuss
	 * entry for a project.
	 *
	 * v0.8 P7: route by `requirement.createdByAgentId` (the PM agent that
	 * created this requirement), NOT by scanning roleTag="pm". This is the
	 * canonical "address by req-recorded agentId" pattern (RFC §1.5 / §4.2).
	 * Cross-cron, cross-date discussion lands here.
	 *
	 * Returns { agentId, session, created } where agentId is the resolved PM
	 * agent id (caller uses it to setActiveAgent on the renderer).
	 */
	openDiscussSession(requirementId: string): {
		agentId: string;
		session: { id: string };
		created: boolean;
	} {
		const req = this.deps.requirementStore.get(requirementId);
		if (!req) {
			throw new Error(`Requirement not found: ${requirementId}`);
		}
		const pmAgentId = req.createdByAgentId;
		if (!pmAgentId) {
			throw new Error(
				`Requirement ${requirementId} has no createdByAgentId — cannot route discuss (P7 needs req-recorded PM agent id)`,
			);
		}
		// Sanity: the recorded agent id must exist (it may have been deleted).
		const pmAgent = this.deps.agentStore.get(pmAgentId);
		if (!pmAgent) {
			throw new Error(`PM agent ${pmAgentId} (createdByAgentId on req ${requirementId}) not found in agent store`);
		}
		const resolved = resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			pmAgent.id,
			req.projectId,
			{ title: `PM · ${req.projectId}` },
		);
		return {
			agentId: pmAgent.id,
			session: { id: resolved.session.id },
			created: resolved.created,
		};
	}

	// ─── Coverage judgement (decision 34, v0.8 P7 end-to-end close) ──────

	/**
	 * Read the latest Orchestrate manifest for a requirement. PM looks at this
	 * to judge whether changes + tests cover the original intent (product
	 * granularity — does NOT do technical acceptance, that's in the flow).
	 */
	getCoverageEvidence(requirementId: string): OrchestrateManifestRecord | undefined {
		return this.deps.manifestStore?.findLatestForRequirement(requirementId);
	}

	/**
	 * Build the coverage-judgement view payload for the UI: requirement intent
	 * (doc) + manifest summary (changed files + tests + review verdict).
	 */
	buildCoverageView(requirementId: string): {
		requirement?: RequirementRecord;
		intentDoc?: string;
		manifest?: OrchestrateManifestRecord;
	} {
		const req = this.deps.requirementStore.get(requirementId);
		if (!req) return {};
		const project = this.deps.projectStore.get(req.projectId);
		const intentDoc = project
			? this.deps.requirementDocStore.readRequirementDocByPath(
				req.docPath ?? "",
				project.workspaceDir,
			)
			: undefined;
		const manifest = this.getCoverageEvidence(requirementId);
		return { requirement: req, intentDoc, manifest };
	}

	/**
	 * Submit the PM coverage verdict (§4.5 / §4.6, v0.8 P7 end-to-end close).
	 *
	 *   covered=true  → trigger archivist merge (mergeFeatureToMain + 增量扫描,
	 *                   §4.6) → transition requirement status to "closed"
	 *                   (=archived; RequirementStatus has no "archived" value,
	 *                   closed is the data-model equivalent).
	 *   covered=false → write the gap feedback onto requirement.addMessage;
	 *                   lead will see it when re-activated (verify tool returns
	 *                   the reason to lead, lead revises plan and re-submits).
	 *
	 * reviewerAgentId defaults to req.reviewerAgentId / req.createdByAgentId.
	 * Stamps reviewerAgentId (decision 34) and records a status_change message
	 * for audit.
	 *
	 * PM failure/degradation: if archivist merge throws, the verdict is still
	 * recorded (covered=true), status stays in "verify", and the error is
	 * returned in outcome.merge.error — caller/cron may retry. We do NOT roll
	 * back the verdict (the coverage decision was made; merge is the
	 * consequential step).
	 */
	async submitCoverageVerdict(
		requirementId: string,
		verdict: CoverageVerdict,
		opts?: { reviewerAgentId?: string },
	): Promise<CoverageVerdictOutcome> {
		const req = this.deps.requirementStore.get(requirementId);
		if (!req) {
			throw new Error(`Requirement not found: ${requirementId}`);
		}

		// v0.8 P7: resolve reviewer by req-recorded agentId. Falls back through
		// reviewerAgentId → createdByAgentId (decision 34: defaults to the
		// creating PM). No roleTag scan.
		const reviewerAgentId =
			opts?.reviewerAgentId ?? req.reviewerAgentId ?? req.createdByAgentId;

		// Stamp reviewerAgentId (decision 34 — coverage-judgement party).
		if (reviewerAgentId && req.reviewerAgentId !== reviewerAgentId) {
			this.deps.requirementStore.update(requirementId, { reviewerAgentId } as any);
		}

		// Record the verdict as a status_change message (audit trail + lead
		// feedback surface).
		this.deps.requirementStore.addMessage(
			requirementId,
			"agent", // RequirementMessageSender slot — the reviewing agent
			`PM coverage verdict: ${verdict.covered ? "COVERED" : "NOT_COVERED"}` +
				(verdict.reason ? ` — ${verdict.reason}` : ""),
			"status_change",
		);

		// v0.8 P7: drive the archivist directly (§4.6). No central router — the
		// PM service holds an ArchivistService handle and calls merge.
		if (verdict.covered) {
			let merge: MergeResult = { ok: false, error: "archivist service not wired" };
			if (this.deps.archivistService) {
				try {
					const r = await this.deps.archivistService.mergeFeatureToMain(
						req.projectId,
						requirementId,
					);
					merge = {
						ok: !!r?.ok,
						ref: (r as any)?.ref,
						error: (r as any)?.error,
					};
				} catch (err) {
					merge = { ok: false, error: (err as Error).message };
					log.warn("pm", `archivist merge failed for ${requirementId}: ${(err as Error).message}`);
				}
			} else {
				log.warn("pm", `Coverage verdict OK for ${requirementId} but no archivistService wired; status stays in verify`);
			}

			// Transition to "closed" (=archived) only if the merge succeeded.
			// On merge failure, leave status=verify so a cron/archivist retry
			// can pick up the requirement (RFC §4.6 risk: archivist cron 兜底
			// 拉待合并状态自行处理).
			let finalStatus = req.status;
			if (merge.ok) {
				try {
					this.deps.requirementStore.transitionStatus(
						requirementId,
						"closed",
						"agent", // RequirementMessageSender slot — the reviewing agent
						`PM coverage OK + archivist merged (ref ${merge.ref ?? "?"})`,
					);
					finalStatus = "closed";
				} catch (err) {
					log.warn("pm", `verify→closed transition failed for ${requirementId}: ${(err as Error).message}`);
				}
			}

			log.agent(`PM coverage OK + archivist merge ${merge.ok ? "OK" : "FAILED"} for ${requirementId}`);
			return { covered: true, reviewerAgentId, merge, finalStatus };
		}

		// covered=false: feedback already recorded as status_change message
		// above; lead will read it when re-activated. Leave status in "verify"
		// so lead's session can pick up the next turn (§4.5: "不通过 → 意见回
		// lead,lead 改计划重提"). The lead's re-activation will be driven by
		// the verify tool returning the reason, OR by lead's cron fallback.
		log.agent(`PM coverage FAIL for ${requirementId}: ${verdict.reason ?? "(no reason)"}`);
		return {
			covered: false,
			reviewerAgentId,
			finalStatus: req.status,
		};
	}
}
