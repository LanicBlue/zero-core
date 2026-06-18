// 角色 Template REST API 路由 (v0.8 P6 — RFC §7.2)
//
// # 文件说明书
//
// ## 核心功能
// 暴露角色 Template 列表 + 一键实例化接口,供 UI 和测试使用。
// zero 全局管理 agent 也可通过 AgentRegistry(create, template=...) 达成同样
// 效果 (并行入口)。
//
// ## 命名沿革 (v0.8 P6)
// 本文件原名 `preset-router.ts`,挂载于 `/api/presets`,IPC 通道无 (历史 REST-
// only 入口)。v0.8 P6 按 RFC §7.2 改名:
//   - `preset-router.ts`        → `role-template-router.ts`
//   - 路由 `/api/presets`        → `/api/role-templates`
//   - 新增 IPC `role-templates:list/get/instantiate` (ROUTE_MAP + preload 同步,
//     RFC §1.1 契约)。
//
// ## 命名空间说明
// 既有的 `/api/templates` (TemplateStore — DB 里的对话 prompt 模板) 与本路由的
// `/api/role-templates` (角色身份 template) 是两个独立概念,各自独立挂载,不混用。
//
// ## 输入
// - ManagementService (P3 改名 from ZeroAdminService)
//
// ## 输出
// - GET /api/role-templates        — 列出角色 template (可按 roleTag 过滤)
// - GET /api/role-templates/:id    — 读一条
// - POST /api/role-templates/:id/instantiate — 一键实例化为全局 agent
//
// ## 定位
// src/server/ — REST 路由,挂载于 /api/role-templates
//
// ## 依赖
// - express
// - ./management-service
// - ../runtime/role-templates
//

import { Router } from "express";
import type { ManagementService } from "./management-service.js";
import { getTemplate, listTemplates } from "../runtime/role-templates.js";

export function createRoleTemplateRouter(management: ManagementService): Router {
	const router = Router();

	/** GET / — list role templates (optionally filtered by roleTag) */
	router.get("/", (req, res) => {
		const roleTag = req.query.roleTag as string | undefined;
		res.json(listTemplates(roleTag));
	});

	/** GET /:id — get a single role template */
	router.get("/:id", (req, res) => {
		const template = getTemplate(req.params.id);
		if (!template) return res.status(404).json({ error: `Unknown role template: ${req.params.id}` });
		res.json(template);
	});

	/** POST /:id/instantiate — instantiate as a global agent */
	router.post("/:id/instantiate", (req, res) => {
		try {
			const agent = management.instantiateTemplate(
				req.params.id,
				{
					name: req.body?.name,
					model: req.body?.model,
					provider: req.body?.provider,
					workspaceDir: req.body?.workspaceDir,
				},
				{ bindToolPolicy: req.body?.bindToolPolicy ?? true },
			);
			res.status(201).json(agent);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	return router;
}
