// PM (产品经理) 服务 (v0.8 M4 — RFC §2.5 / §2.10 / §2.17b / §4.5)
//
// # 文件说明书
//
// ## 核心功能
// 给 M0 已存在的全局 PM 角色预设补「行为」(M0 只交付身份)。PM 被自身 cron
// (M1) 驱动:cron 发 prompt 激活 {PM, projectId} session,PM 自己 scan
// workspace / 调 analyzer / 决定建什么需求 (M4 修订:发现完全由 PM agent 驱动,
// 不是 service 方法直调)。PM 用 CreateRequirementWithDoc 工具建需求 + 文档 +
// 落 discuss (该工具路由到本服务的 createRequirementWithDoc)。
//
// 本服务提供 PM 行为原语,被 PM 工具 (requirement-tools) + IPC discuss/coverage
// handler 调用:
//   1. createRequirementWithDoc()    —— 把一条发现落成 RequirementRecord +
//      repo 内需求文档 + docPath 绑定 (决策 12/14)。wiki 意图节点由 archivist
//      兜底建 (M2),不由 PM/本服务写。
//   2. judgeCoverage() / submitCoverageVerdict() —— verify 时 PM 看清单判覆盖
//      (决策 34),verdict 接 project-notification-router (verify_accept /
//      coverage-reject)
//   3. openDiscussSession() —— 看板「讨论」入口 → {PM, projectId} session
//
// ## 写隔离 (决策 7/18)
// - PM 只发现/创建新需求,不改已有需求文档;对 wiki 树结构和代码 read-only
//   (本服务用 RequirementDocStore.buildNewRequirementDoc 实现幂等新建,
//   用 WikiNodeStore 读 wiki,不写结构)
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
// - ProjectNotificationRouter (verdict 对接)
// - SessionDB / SessionContextRouter (discuss 路由)
//
// ## 输出
// - PmService 类
//
// ## 定位
// 服务层,被 PM 工具 (requirement-tools.ts) + IPC handler 使用。
//
// ## 依赖
// - ./agent-service, ./agent-store, ./project-store
// - ./requirement-store, ./requirement-doc-store
// - ./wiki-node-store, ./orchestrate-store
// - ./project-notification-router, ./session-context-router
// - ./session-db
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
import type { ProjectNotificationRouter } from "./project-notification-router.js";
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
	projectNotificationRouter?: ProjectNotificationRouter;
	sessionDB: SessionDB;
	resolveWikiRoot?: WikiRootResolver;
}

export interface CoverageVerdict {
	/** true = changes+tests cover the requirement intent; false = gap. */
	covered: boolean;
	/** Free-text reason / gaps. */
	reason?: string;
}

export class PmService {
	private deps: PmServiceDeps;

	constructor(deps: PmServiceDeps) {
		this.deps = deps;
	}

	// ─── Role agent lookup ───────────────────────────────────────────────

	/**
	 * Find the global PM role agent. RFC v0.8: PM is a global role; one project
	 * uses one PM agent. If multiple carry roleTag="pm", the first (by
	 * createdAt) wins (same convention as ProjectNotificationRouter).
	 */
	findPmAgent(): AgentRecord | undefined {
		// v0.8 (P0 §1.4): roleTag removed from AgentRecord. Use
		// AgentStore.listByRoleTag (reads the retained `role_tag` physical
		// column directly) so we don't lose the legacy filter while P2/P7
		// migrates identity off roleTag.
		const matches = this.deps.agentStore.listByRoleTag("pm");
		if (matches.length === 0) return undefined;
		matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return matches[0];
	}

	// ─── Discovery path ─────────────────────────────────────────────────
	//
	// v0.8 (M4 design): PM discovery is fully agent-driven. There is NO
	// service-level "discoverAndCreateRequirement" — the cron only sends a
	// prompt that wakes the PM session; PM itself decides what to scan, which
	// analyzer agent-tools to call, and which findings to turn into
	// requirements via the CreateRequirementWithDoc tool (which routes through
	// createRequirementWithDoc below). The platform's only job is to seed PM's
	// system prompt + tool allowlist + the cron's prompt — all done by the
	// user (zero role) at PM instantiation time.

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
	 * The doc is also surfaced as the wiki tree's intent leaf (decision 14):
	 * we record docPath on the RequirementRecord; archivist's wiki scan will
	 * pick it up and build the intent node + relations (archivist owns wiki
	 * structure; PM only owns the leaf content). This keeps PM read-only on
	 * the wiki tree structure, per decision 7/18.
	 */
	createRequirementWithDoc(input: {
		projectId: string;
		title: string;
		summary?: string;
		body?: string;
		priority?: RequirementPriority;
		source?: "pm" | "user";
		/** PM agent creating this; defaults to the global PM. */
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

		const pmAgent = this.findPmAgent();
		const createdByAgentId = input.createdByAgentId ?? pmAgent?.id;

		// Create the RequirementRecord first (store mints the id), carrying the
		// agent fields (RFC §4.5). docPath is filled in after we know the id.
		const req = this.deps.requirementStore.create({
			projectId: input.projectId,
			title: input.title,
			description: input.summary,
			status: "discuss",
			source: input.source === "user" ? "user" : "analyst", // RequirementSource compat
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

	// ─── Discuss entry (decision 13/14) ──────────────────────────────────

	/**
	 * Open (find-or-create) the {PM, projectId} session — the single discuss
	 * entry for a project. Cross-cron, cross-date discussion lands here.
	 */
	openDiscussSession(projectId: string) {
		const pmAgent = this.findPmAgent();
		if (!pmAgent) {
			throw new Error("No PM agent registered (roleTag='pm')");
		}
		return resolveSessionByRoleProject(
			{
				sessionDB: this.deps.sessionDB,
				projectStore: this.deps.projectStore,
				resolveWikiRoot: this.deps.resolveWikiRoot,
			},
			pmAgent.id,
			projectId,
			{ title: `PM · ${projectId}` },
		);
	}

	// ─── Coverage judgement (decision 34) ────────────────────────────────

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
	 * Submit the PM coverage verdict. Drives the cross-role notification:
	 *   covered=true  → notify("verify_accept")  → archivist merges feature→main
	 *   covered=false → notify("coverage-reject") → lead 补 (decision 11/34)
	 *
	 * Also stamps reviewerAgentId (decision 34) and records a status_change
	 * message on the requirement. The PM agent id is the judger by default.
	 */
	async submitCoverageVerdict(
		requirementId: string,
		verdict: CoverageVerdict,
		opts?: { reviewerAgentId?: string },
	): Promise<void> {
		const req = this.deps.requirementStore.get(requirementId);
		if (!req) {
			throw new Error(`Requirement not found: ${requirementId}`);
		}

		const reviewerAgentId = opts?.reviewerAgentId ?? req.reviewerAgentId ?? this.findPmAgent()?.id;

		// Stamp reviewerAgentId (decision 34 — coverage-judgement party).
		if (reviewerAgentId && req.reviewerAgentId !== reviewerAgentId) {
			this.deps.requirementStore.update(requirementId, { reviewerAgentId } as any);
		}

		// Record the verdict as a status_change message (audit trail).
		this.deps.requirementStore.addMessage(
			requirementId,
			"analyst", // RequirementMessageSender compat slot; PM uses 'analyst' sender
			`PM coverage verdict: ${verdict.covered ? "COVERED" : "NOT_COVERED"}` +
				(verdict.reason ? ` — ${verdict.reason}` : ""),
			"status_change",
		);

		// Drive the cross-role notification (decision 10/11/34).
		const router = this.deps.projectNotificationRouter;
		if (!router) {
			log.warn("pm", `Coverage verdict for ${requirementId} recorded, but no notification router wired`);
			return;
		}

		if (verdict.covered) {
			await router.notify("verify_accept", requirementId, req.projectId, { reason: verdict.reason });
			log.agent(`PM coverage OK → verify_accept for ${requirementId}`);
		} else {
			await router.notify("verify_reject", requirementId, req.projectId, { reason: verdict.reason });
			log.agent(`PM coverage FAIL → coverage-reject for ${requirementId}`);
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "req";
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 8);
}
