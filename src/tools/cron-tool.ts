// Cron action 工具 (v0.8 P3 — §9.4)
//
// # 文件说明书
//
// ## 核心功能
// "Cron" 是 v0.8 P3 四个判别联合 action 工具之一。一个工具 + action 字段
// 切换 6 个操作 (§9.4):
//   - create   建 CronRecord (三模式 schedule)
//   - update   改 workingScope / schedule / prompt / enabled
//   - delete   解绑(被引用的 Agent 不动)
//   - get      读一条
//   - list     列(可选 agentId 过滤)
//   - trigger  立即手动触发(P3 stub:落意图,P4 调度器实际跑)
//
// ## 边界 (plan-P3.md 末尾)
// 三模式调度触发逻辑 / cron_runs 写入 → P4。本工具只接 store CRUD + 一个
// trigger 入口点(调度实际执行 P4)。
//
// ## 命名 (§7.3 硬原则)
// 原 CreateCron/UpdateCron/DeleteCron/ListCrons 四个工具合并到此。
//
// ## 输入
// - ctx.management (ManagementService)
//
// ## 输出
// - export const cronTool
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import { getManagementService } from "../server/management-service.js";
import type { ManagementService } from "../server/management-service.js";
import { getCronAnalysisManager } from "../server/cron-analysis.js";
import type { CallerCtx, ToolResult } from "./types.js";

/**
 * tool-decoupling sub-3(决策 1):直读 getManagementService() 单例 —— 不再经
 * ctx.management。headless / 非 zero session 无单例(undefined)→ 工具优雅
 * 报错(不崩)。
 */
function mgmt(): ManagementService {
	const svc = getManagementService();
	if (!svc) throw new Error("Cron tool requires ManagementService singleton (zero session only)");
	return svc;
}

/**
 * tool-decoupling sub-3(决策 3):execute 返 ToolResult{data:{text, result}}。
 * text = 渲染后的 LLM 文本(同 sub-3 前 —— 成功 → JSON.dump,result 字符串透出;
 * 失败 → "Error: …")。format(r) = r.data.text。result 保留原始 store 返值让
 * UI dispatcher(sub-5)直渲染。
 */
async function runAction(fn: () => any): Promise<ToolResult> {
	try {
		const result = await fn();
		const text = typeof result === "string" ? result : JSON.stringify(result);
		return { ok: true, data: { text, result } };
	} catch (err: any) {
		const msg = `Error: ${err.message ?? String(err)}`;
		return { ok: false, error: msg, data: { text: msg } };
	}
}

// ---------------------------------------------------------------------------
// Schedule + workingScope shapes (P0 §3.4 structured union)
// ---------------------------------------------------------------------------

const workingScopeSchema = z.object({
	projectId: z.string().optional(),
	workspaceDir: z.string(),
	wikiRootNodeId: z.string(),
});

// Schedule: flat object with mode discriminator (not discriminatedUnion).
// Same provider-compat reason as the action schema below — nested oneOf is also
// poorly supported by some providers; flatten to one object keyed by `mode`.
const scheduleSchema = z.object({
	mode: z.enum(["once", "alarm", "interval"]),
	// once
	at: z.string().optional().describe("ISO 8601 timestamp the cron fires once at (mode:'once')"),
	// alarm
	time: z.string().optional().describe('Local time-of-day "HH:MM" (mode:\'alarm\')'),
	days: z.array(z.number()).optional().describe("ISO weekday 1=Mon … 7=Sun; [] = every day (mode:'alarm')"),
	tz: z.string().optional().describe('IANA timezone, e.g. "Asia/Shanghai" (mode:\'alarm\')'),
	// interval
	everyMs: z.number().optional().describe("Firing period in milliseconds (mode:'interval')"),
});

// ---------------------------------------------------------------------------
// Flat action schema
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object, not z.discriminatedUnion. LLM tool-calling
// protocols require a top-level `type: object` parameters schema; a top-level
// oneOf/discriminated union is dropped/mis-parsed by most providers, so the
// model calls the tool with `{}`. The action enum validates the discriminator.

export const cronActionSchema = z.object({
	action: z.enum(["create", "update", "delete", "get", "list", "trigger", "today"]),
	agentId: z.string().optional(),
	workingScope: workingScopeSchema.optional(),
	schedule: scheduleSchema.optional(),
	prompt: z.string().optional(),
	enabled: z.boolean().optional(),
	id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const cronTool = buildTool({
	name: "Cron",
	description:
		"Manage Cron records (scheduled recurring runs of a global agent). Action-switched: create/update/delete/get/list/trigger/today.",
	prompt:
		"Manage Crons via a single action-switched tool.\n\n" +
		"Actions:\n" +
		"- { action:'create', agentId, workingScope:{projectId?,workspaceDir,wikiRootNodeId}, schedule, prompt?, enabled? } — schedule a global agent. schedule is the structured union: {mode:'once',at} | {mode:'alarm',time,days,tz} | {mode:'interval',everyMs}.\n" +
		"- { action:'update', id, workingScope?/schedule?/prompt?/enabled? } — partial update. agentId is immutable.\n" +
		"- { action:'delete', id } — unbind (the agent it referenced stays).\n" +
		"- { action:'get', id } — read one.\n" +
		"- { action:'list', agentId? } — list, optionally filtered by agentId.\n" +
		"- { action:'trigger', id } — fire immediately. (P3 stub: records the trigger request; P4 lands the actual scheduler run + cron_runs write.)\n" +
		"- { action:'today' } — list today's planned cron fires (one row per enabled cron whose next slot lands inside today's local calendar day; interval crons always listed with an interval hint). Read-only; backs the kanban's 'today' column.",
	meta: {
		category: "agent",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: cronActionSchema,
	execute: async (input: any, _callerCtx: CallerCtx): Promise<ToolResult> => {
		// 'today' is read-only + reads the CronAnalysisManager singleton (not
		// ManagementService). Handle it before the mgmt() switch so it works in
		// contexts where ManagementService isn't registered but the scheduler is.
		// tool-decoupling sub-6: typed JSON data shape { items: [...] }.
		if (input.action === "today") {
			const mgr = getCronAnalysisManager();
			if (!mgr || typeof mgr.listTodaysFires !== "function") {
				const msg = "Cron scheduler not available in this context (CronAnalysisManager singleton not registered).";
				return { ok: false, error: msg, data: { text: msg, items: [] } };
			}
			try {
				const items = mgr.listTodaysFires();
				const text = JSON.stringify(items);
				return { ok: true, data: { text, items } };
			} catch (err: any) {
				const msg = `Error: ${err.message ?? String(err)}`;
				return { ok: false, error: msg, data: { text: msg, items: [] } };
			}
		}
		return runAction(() => {
			const svc = mgmt();
			switch (input.action) {
				case "create":
					return svc.createCron({
						agentId: input.agentId,
						workingScope: input.workingScope,
						schedule: input.schedule as any,
						prompt: input.prompt,
						enabled: input.enabled,
					});
				case "update": {
					const patch: any = {};
					if (input.workingScope !== undefined) patch.workingScope = input.workingScope;
					if (input.schedule !== undefined) patch.schedule = input.schedule as any;
					if (input.prompt !== undefined) patch.prompt = input.prompt;
					if (input.enabled !== undefined) patch.enabled = input.enabled;
					return svc.updateCron(input.id, patch);
				}
				case "delete":
					svc.deleteCron(input.id);
					return { success: true };
				case "get":
					return svc.getCron(input.id) ?? { error: `Cron not found: ${input.id}` };
				case "list":
					return svc.listCrons(input.agentId ? { agentId: input.agentId } : undefined);
				case "trigger":
					return svc.triggerCron(input.id);
			}
		});
	},
	// format(决策 3):纯函数,透出 data.text(渲染后的 LLM 文本)。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Cron action failed.";
	},
});
