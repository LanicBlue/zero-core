// verify 工具 (v0.8 P7 端到端闭环 — §4.5 / §4.6 / §11.4)
//
// # 文件说明书
//
// ## 核心功能
// "verify" 是 lead 提交产物时调用的阻塞工具(§4.5 第二道门)。流程:
//   1. lead 在 Orchestrate 跑完、自验通过后,调 verify(requirementId, summary?)
//   2. 工具把 requirement.status 置为 "verify" + 写 verify payload(消息)
//   3. 工具按 requirement.createdByAgentId / reviewer_agent_id 解析 PM agent
//   4. 通过 delegateTask 激活 {PM, projectId} session 跑产品覆盖判断(同步
//      delegateTask 阻塞 await;caller bundle 继承,§4.5)
//   5. PM verdict 回灌:verdict APPROVED → 调 PmService.submitCoverageVerdict
//      (covered=true) → archivist mergeFeatureToMain + 增量扫描 → 置 closed
//      (§4.6);verdict REJECTED → submitCoverageVerdict(covered=false) →
//      意见写回 requirement.addMessage → 工具返回意见给 lead,lead 据此改
//      计划重提。
//
// ## v0.8 P7 闭环关键点(plan-P7.md #3 #4)
// - 不走 project-notification-router(已废,§1.5)。
// - 通过 req.createdByAgentId / reviewer_agent_id 寻址 PM(§4.5)。
// - submitCoverageVerdict 直接驱动 archivistService.mergeFeatureToMain(§4.6)。
// - PM 失败/超时降级:delegateTask 抛错 → 返回 fail+意见让 lead 重提,不卡死。
// - archivist 不在或 merge 失败 → status 留在 verify,archivist cron 兜底拉。
//
// ## 阻塞语义
// 工具 execute 内 await delegateTask。delegateTask 已 await caller 拿结果,
// 工具未返回 → agent-loop 已 await 工具,自然停在这里不发 LLM call。真正的
// 挂起,不是忙等(同 Orchestrate confirm 门模式)。
//
// ## 输入
// - ctx.delegateTask (调 PM)
// - ctx.requirementStore
// - ctx.pmService (P7: verify→archivist 闭环)
// - ctx.projectId (用于 delegateTask 默认 bundle)
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
		"On APPROVED → PM triggers archivist to merge feature→main and the requirement is closed (archived). On REJECTED → PM's gap reason is returned; revise your plan and re-submit.\n\n" +
		"Inputs:\n" +
		"- requirementId (required) — the requirement you just built.\n" +
		"- summary (optional) — short note for PM (canonical evidence is the Orchestrate manifest).",
	meta: {
		category: "workflow",
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
		//    v0.8 P7 (§4.5): lead submits verify explicitly; this status write
		//    is the gate, not a hook auto-transition.
		try {
			reqStore.update(input.requirementId, { status: "verify" } as any);
		} catch (err) {
			// best-effort: status write must not block the verdict loop
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

		// 2. Resolve the PM agent by req-recorded agentId (§4.5). Prefer
		//    reviewerAgentId, then createdByAgentId. No roleTag scan.
		const targetAgentId = req.reviewerAgentId ?? req.createdByAgentId;

		if (!targetAgentId) {
			return (
				"Error: requirement has no reviewerAgentId / createdByAgentId — cannot resolve PM " +
				"for coverage judgement (P7 addresses PM by req-recorded agentId, not by role scan)."
			);
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
			// PM dispatch failure → degrade to fail-safe: tell lead to retry.
			// Do NOT silently advance status. Status stays in "verify"; lead
			// (or its cron fallback) will re-attempt.
			return `PM coverage dispatch failed: ${err.message ?? String(err)}\n\nThe requirement is in 'verify' status; you can re-submit verify to retry, or your cron fallback will wake you.`;
		}

		// 4. Parse verdict — be liberal: lead needs the reason either way.
		const verdict = parseVerdict(pmOutput);

		// 5. v0.8 P7 end-to-end close: drive PmService.submitCoverageVerdict.
		//    This stamps reviewerAgentId, records the verdict as a status_change
		//    message (audit), and on APPROVED triggers archivist
		//    mergeFeatureToMain + 增量扫描 → transition to closed (§4.6).
		const pmSvc: any = (ctx as any).pmService;
		if (pmSvc?.submitCoverageVerdict) {
			try {
				const outcome = await pmSvc.submitCoverageVerdict(
					input.requirementId,
					{ covered: verdict.approved, reason: verdict.reason },
					{ reviewerAgentId: targetAgentId },
				);
				if (verdict.approved) {
					if (outcome?.merge?.ok) {
						return (
							`PM APPROVED — ${verdict.reason}\n\n` +
							`Archivist merged feature→main (ref ${outcome.merge.ref ?? "?"}); ` +
							`requirement status → ${outcome.finalStatus}. Delivery complete.`
						);
					}
					// Merge failed or archivist not wired: leave status in verify.
					return (
						`PM APPROVED — ${verdict.reason}\n\n` +
						`Archivist merge ${outcome?.merge?.ok === false ? "FAILED" : "not wired"} ` +
						`(${outcome?.merge?.error ?? "no archivist"}). Requirement stays in 'verify'; ` +
						`archivist cron will retry the merge. You can re-submit verify if needed.`
					);
				}
				return (
					`PM REJECTED — ${verdict.reason}\n\n` +
					`Feedback recorded on the requirement. Revise your plan and re-submit verify when ready.\n\n` +
					`(Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`
				);
			} catch (err: any) {
				// submitCoverageVerdict threw — degrade. Verdict text is still
				// returned to lead so the loop isn't stuck.
				return (
					`PM verdict: ${verdict.approved ? "APPROVED" : "REJECTED"} — ${verdict.reason}\n\n` +
					`submitCoverageVerdict failed: ${err.message ?? String(err)}. ` +
					`Requirement stays in 'verify'; you can re-submit or wait for cron fallback.\n\n` +
					`(Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`
				);
			}
		}

		// pmService not wired (e.g. legacy ctx). Return verdict text + note.
		// Status stays in 'verify'; no archivist merge.
		if (verdict.approved) {
			return (
				`PM APPROVED — ${verdict.reason}\n\n` +
				`(pmService not wired on this ctx — end-to-end close skipped. Requirement is in 'verify'; ` +
				`PM/archivist cron will pick it up.)`
			);
		}
		return (
			`PM REJECTED — ${verdict.reason}\n\n` +
			`Revise your plan and re-submit. (Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`
		);
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
