// Work action 工具 (project-flow — project 类三工具之一)
//
// # 文件说明书
//
// ## 核心功能
// "Work" 管理 project 内的 work(工位/项目内工作)。一个 work = 项目里定义的一项
// 工作,带 actionPrompt + requiredTools + agentId(执行者,可空)+ hooks/cron 触发器。
// Action 切换:
//   - create   建 work(可带 cronTriggers / runOnce 立即跑一次)
//   - update   改 work(name/actionPrompt/requiredTools/agentId/enabled/hooks/cronTriggers)
//   - delete   删 work + 其 cron 触发器
//   - list     列某 project 的全部 work(聚合视图,+ cron 触发器状态)
//   - fire     手动触发 work 一次(走 ProjectWorkRunner,异步)
//
// ## 定位
// Runtime 工具,被 buildTools 经 ALL_TOOLS 拉入。门控:仅 ctx.management 存在启用
// (与 Project 同,zero session)。
//
// ## 依赖
// - ctx.management (ManagementService)
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { ManagementService } from "../server/management-service.js";

function mgmt(ctx: any): ManagementService {
	const svc = ctx?.management;
	if (!svc) throw new Error("Work tool requires ctx.management (zero session only)");
	return svc as ManagementService;
}

async function safe(fn: () => any): Promise<string> {
	try {
		const result = await fn();
		return typeof result === "string" ? result : JSON.stringify(result);
	} catch (err: any) {
		return `Error: ${err.message ?? String(err)}`;
	}
}

function requireField(value: unknown, field: string, action: string): void {
	if (value === undefined || value === null || value === "") {
		throw new Error(`${action} requires \`${field}\``);
	}
}

// Flat action schema — one tool, work actions (same FLAT z.object pattern as
// Project/Flow: top-level discriminatedUnion is mis-parsed by most LLM
// function-calling providers).
export const workActionSchema = z.object({
	action: z.enum(["create", "update", "delete", "list", "fire"]),
	/** projectId for create / list. */
	projectId: z.string().optional(),
	/** workId for update / delete / fire. */
	workId: z.string().optional(),
	/** Work's role name (distinct from any project name). Required for create. */
	workName: z.string().optional(),
	/** What this work does; sent as the user message when the work fires. */
	actionPrompt: z.string().optional(),
	/** Tools the assigned agent must provide; validated on assign/update. */
	requiredTools: z.array(z.string()).optional(),
	/** Agent assigned to run this work. null/omit = vacant (no agent). */
	agentId: z.string().nullable().optional(),
	/** data-change hooks that auto-fire this work (e.g. on requirement events). */
	hooks: z.array(z.object({
		event: z.string(),
		collection: z.string(),
		enabled: z.boolean(),
	})).optional(),
	/** cron schedules that auto-fire this work. */
	cronTriggers: z.array(z.object({
		schedule: z.any(),
		gitAware: z.boolean().optional(),
	})).optional(),
	/** create: fire once immediately after creating. */
	runOnce: z.boolean().optional(),
	/** create/update: whether the work is active (default true on create). */
	enabled: z.boolean().optional(),
});

export const workTool = buildTool({
	name: "Work",
	description:
		"Manage a Project's Works (a Work = a scoped job in a project: actionPrompt + requiredTools + assigned agent + hooks/cron triggers). Action-switched: create/update/delete/list/fire.",
	prompt:
		"Manage a Project's Works via a single action-switched tool. A Work is a defined job in a project (a `workName`, an `actionPrompt` saying what to do, `requiredTools` the assigned agent must provide, an optional `agentId` to run it, and optional `hooks`/`cronTriggers` to auto-fire it).\n\n" +
		"Actions:\n" +
		"- { action:'create', projectId, workName, actionPrompt?, requiredTools?, agentId?, hooks?, cronTriggers?, runOnce?, enabled? } — define a new work. `workName` is required. If `agentId` is given, that agent must satisfy `requiredTools` (else rejected). `cronTriggers` auto-fire on schedule; `runOnce:true` fires once immediately; `hooks` auto-fire on data-change events (e.g. {event:'requirements.ready', collection:'requirements', enabled:true}).\n" +
		"- { action:'update', workId, workName?/actionPrompt?/requiredTools?/agentId?/enabled?/hooks?/cronTriggers? } — mutate one work. Only the fields you pass are changed (omit others). Set `agentId:null` to unassign (make the work vacant).\n" +
		"- { action:'delete', workId } — delete a work AND its cron triggers.\n" +
		"- { action:'list', projectId } — list all works in a project (with their cron-trigger status, assigned agent name, lastRunAt).\n" +
		"- { action:'fire', workId } — manually trigger a work once now (async; returns { status, sessionId } on ok).\n\n" +
		"Errors are uniform: any failure (not found, missing required field, agent lacks required tools) returns `\"Error: …\"`.",
	meta: {
		category: "project",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},
	inputSchema: workActionSchema,
	execute: async (input, ctx) =>
		safe(() => {
			const svc = mgmt(ctx);
			switch (input.action) {
				case "create": {
					requireField(input.projectId, "projectId", "create");
					requireField(input.workName, "workName", "create");
					return svc.createProjectWork(input.projectId, {
						name: input.workName,
						actionPrompt: input.actionPrompt,
						requiredTools: input.requiredTools,
						agentId: input.agentId ?? undefined,
						hooks: input.hooks,
						cronTriggers: input.cronTriggers,
						runOnce: input.runOnce,
						enabled: input.enabled,
					});
				}
				case "update": {
					requireField(input.workId, "workId", "update");
					// Build a patch of ONLY the fields the caller supplied, so omitted
					// fields are preserved (passing undefined would blank them).
					const patch: Record<string, unknown> = {};
					if (input.workName !== undefined) patch.name = input.workName;
					if (input.actionPrompt !== undefined) patch.actionPrompt = input.actionPrompt;
					if (input.requiredTools !== undefined) patch.requiredTools = input.requiredTools;
					if (input.agentId !== undefined) patch.agentId = input.agentId;
					if (input.hooks !== undefined) patch.hooks = input.hooks;
					if (input.cronTriggers !== undefined) patch.cronTriggers = input.cronTriggers;
					if (input.runOnce !== undefined) patch.runOnce = input.runOnce;
					if (input.enabled !== undefined) patch.enabled = input.enabled;
					return svc.updateProjectWork(input.workId, patch as any);
				}
				case "delete":
					requireField(input.workId, "workId", "delete");
					svc.deleteProjectWork(input.workId);
					return { success: true };
				case "list":
					requireField(input.projectId, "projectId", "list");
					return svc.getProjectWorks(input.projectId);
				case "fire":
					requireField(input.workId, "workId", "fire");
					return svc.triggerProjectWork(input.workId);
			}
		}),
});
