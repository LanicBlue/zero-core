// verify 工具 (v0.8 P3 — §4.5 / §11.4)
//
// # 文件说明书
//
// ## 核心功能
// "verify" 是 lead 提交产物时调用的阻塞工具(§4.5)。流程:
//   1. lead 在 Orchestrate 跑完、自验通过后,调 verify(requirementId)
//   2. 工具把 requirement.status 置为 "verify" + 写 verify payload(消息)
//   3. 工具按 requirement.createdByAgentId / reviewer_agent_id 解析 PM agent
//   4. 通过 delegateTask 激活 {PM, projectId} session 跑产品覆盖判断(P3 用
//      同步 delegateTask 阻塞 await;P7 走 project-notification-router 端到端
//      闭环)
//   5. PM verdict 文本回灌给 lead。verdict 不通过 → 返回意见,lead 据此改
//      计划重提(P7 闭环,P3 是机制就绪)
//
// ## 阻塞语义
// 工具 execute 内 await delegateTask。delegateTask 已 await caller 拿结果,
// 工具未返回 → agent-loop 已 await 工具,自然停在这里不发 LLM call。真正的
// 挂起,不是忙等(同 Orchestrate confirm 门模式)。
//
// ## 调 PM 的机制(plan-P3.md §9.4)
// "激活 PM 的 {PM, projectId} session 跑覆盖判断(复用 delegateTask 或
// session 激活),拿 verdict"。P3 用 delegateTask(targetAgentId=PM agent id)
// —— delegateTask 已经接受 targetAgentId(§2.11/decision 16),在 caller
// bundle 继承下,PM 跑覆盖判断的同 {PM, projectId} session 与 PM 自己的
// cron 巡检 session 同一个(resolveSessionByRoleProject 复用)。
//
// ## 边界 (plan-P3.md 末尾)
// verify→PM→archivist 端到端闭环 → P7。本工具只让"lead 提交 → PM 判 →
// verdict 回 lead"的机制就绪(不接 archivist 合并、不写 manifest 完整流程)。
//
// ## 输入
// - ctx.delegateTask
// - ctx.requirementStore
// - ctx.management (用于 fallback 找 PM agent)
// - ctx.projectId
//
// ## 输出
// - export const verifyTool
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const verifySchema = z.object({
	requirementId: z.string().describe("The requirement lead just finished building"),
	/**
	 * Optional free-text summary lead wants PM to read alongside the
	 * Orchestrate manifest. lead should keep this short — the canonical
	 * evidence is the manifest (PM reads it via PmService.getCoverageEvidence).
	 */
	summary: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const verifyTool = buildTool({
	name: "verify",
	description:
		"Submit the built requirement for product-granularity coverage judgement by PM. BLOCKING — awaits PM verdict.",
	prompt:
		"Submit your finished work for PM coverage judgement.\n\n" +
		"Call this AFTER your Orchestrate flow has run green (tests pass + reviewer approved). It:\n" +
		"  1. sets the requirement status to 'verify';\n" +
		"  2. activates the {PM, projectId} session to run product-granularity coverage judgement (does the change+tests cover the original intent — NOT technical accept, that lived in the Orchestrate flow);\n" +
		"  3. BLOCKS until PM returns a verdict.\n\n" +
		"On APPROVED → the requirement moves toward merge (P7 wires the archivist step). On REJECTED → PM's gap reason is returned; revise your plan and re-submit.\n\n" +
		"Inputs:\n" +
		"- requirementId (required) — the requirement you just built.\n" +
		"- summary (optional) — short note for PM (canonical evidence is the Orchestrate manifest).",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: verifySchema,
	execute: async (input, ctx) => {
		const reqStore = ctx.requirementStore;
		if (!reqStore) return "Error: requirementStore not available";
		if (!ctx.delegateTask) return "Error: delegateTask not available — cannot invoke PM";

		const req = reqStore.get(input.requirementId);
		if (!req) return `Error: requirement not found: ${input.requirementId}`;

		// 1. Set status to verify + record verify payload as a message (audit).
		try {
			reqStore.update(input.requirementId, { status: "verify" } as any);
		} catch (err) {
			// best-effort: status write must not block the verdict loop
			// (some requirement store impls reject status transitions; P7
			// tightens the state machine).
		}
		try {
			reqStore.addMessage(
				input.requirementId,
				"analyst", // sender slot compat (lead uses 'analyst' sender)
				`Lead submitted for verify. Summary: ${input.summary ?? "(none)"}`,
				"status_change",
			);
		} catch {
			// best-effort
		}

		// 2. Resolve the PM agent: prefer reviewerAgentId, then createdByAgentId,
		//    then fall back to the global PM via management service.
		const targetAgentId =
			req.reviewerAgentId ?? req.createdByAgentId ?? findPmAgentId(ctx);

		if (!targetAgentId) {
			return "Error: no PM agent resolvable for coverage judgement (set requirement.reviewerAgentId or create a PM agent)";
		}

		// 3. Dispatch to PM via delegateTask. Blocking — agent-loop awaits the
		//    tool result. The PM session inherits this caller's bundle (so the
		//    {PM, projectId} session is the same one PM's cron uses).
		const pmTask =
			`Product-coverage judgement for requirement ${input.requirementId}.\n` +
			`Title: ${req.title}\n` +
			`Intent: ${req.description ?? "(see requirement doc)"}\n` +
			`Lead summary: ${input.summary ?? "(none)"}\n\n` +
			`Read the latest Orchestrate manifest for this requirement, then judge whether the ` +
			`changes + tests cover the original intent at PRODUCT granularity (NOT technical ` +
			`acceptance — that lived in the flow).\n\n` +
			`Respond with EXACTLY one line in the form:\n` +
			`VERDICT: APPROVED|REJECTED — <one-sentence reason>\n` +
			`(REJECTED must cite the specific gap; APPROVED must confirm what's covered.)`;

		let pmOutput: string;
		try {
			pmOutput = await ctx.delegateTask(pmTask, { targetAgentId });
		} catch (err: any) {
			return `PM coverage dispatch failed: ${err.message ?? String(err)}`;
		}

		// 4. Parse verdict — be liberal: lead needs the reason either way.
		const verdict = parseVerdict(pmOutput);

		// P3: we do NOT call PmService.submitCoverageVerdict / notification router
		// here (that's P7's end-to-end close — archivist merge etc.). P3 only
		// returns the verdict + reason to lead. P7 will route approved →
		// verify_accept → archivist; rejected → coverage-reject → lead loop.
		if (verdict.approved) {
			return `PM APPROVED — ${verdict.reason}\n\n(P3 stub: end-to-end verify→archivist close wires in P7. The requirement is now in 'verify' status; PM/cron will pick up the manifest.)`;
		}
		return `PM REJECTED — ${verdict.reason}\n\nRevise your plan and re-submit. (Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`;
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPmAgentId(ctx: any): string | undefined {
	const mgmt = ctx?.management;
	if (!mgmt) return undefined;
	try {
		const agents = mgmt.listAgents("pm") as Array<{ id: string; createdAt?: string }>;
		if (agents.length === 0) return undefined;
		agents.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
		return agents[0].id;
	} catch {
		return undefined;
	}
}

interface ParsedVerdict {
	approved: boolean;
	reason: string;
}

/**
 * Parse the PM verdict line. Liberal — defaults to REJECTED with the raw
 * output as the reason if the line is missing/malformed (fail-safe: a
 * confused PM output is treated as a gap, not silent approval).
 */
function parseVerdict(raw: string): ParsedVerdict {
	const text = (raw ?? "").trim();
	const m = text.match(/VERDICT:\s*(APPROVED|REJECTED)\s*[—\-:]\s*([^\n]*)/i);
	if (m) {
		const approved = /^APPROVED$/i.test(m[1]);
		return { approved, reason: m[2].trim() || "(no reason given)" };
	}
	// Fallback heuristics — PM didn't follow the format. Be conservative.
	if (/\bAPPROV(?:ED|ING)\b/i.test(text) && !/\bREJECT/i.test(text)) {
		return { approved: true, reason: "(PM output mentioned approval — format mismatch)" };
	}
	return {
		approved: false,
		reason: text.slice(0, 300) || "(PM output unparseable; treating as rejected)",
	};
}
