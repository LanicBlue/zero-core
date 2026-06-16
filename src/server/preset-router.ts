// 角色预设 REST API 路由 (v0.8 M0)
//
// # 文件说明书
//
// ## 核心功能
// 暴露角色预设列表 + 一键实例化接口,供 UI 和测试使用。
// zero 全局管理 agent 也可通过 InstantiatePreset 工具达成同样效果 (并行入口)。
//
// ## 输入
// - ZeroAdminService
//
// ## 输出
// - GET /presets        —— 列出预设 (含 M0 降级备注)
// - POST /presets/:id   —— 一键实例化为全局 agent
//
// ## 定位
// src/server/ — REST 路由,挂载于 /api/presets
//
// ## 依赖
// - express
// - ./zero-admin-service
// - ../runtime/role-presets
//

import { Router } from "express";
import type { ZeroAdminService } from "./zero-admin-service.js";
import { getPreset, listPresets } from "../runtime/role-presets.js";

export function createPresetRouter(zeroAdmin: ZeroAdminService): Router {
	const router = Router();

	/** GET / — list presets (optionally filtered by roleTag) */
	router.get("/", (req, res) => {
		const roleTag = req.query.roleTag as string | undefined;
		res.json(listPresets(roleTag));
	});

	/** GET /:id — get a single preset */
	router.get("/:id", (req, res) => {
		const preset = getPreset(req.params.id);
		if (!preset) return res.status(404).json({ error: `Unknown preset: ${req.params.id}` });
		res.json(preset);
	});

	/** POST /:id/instantiate — instantiate as a global agent */
	router.post("/:id/instantiate", (req, res) => {
		try {
			const agent = zeroAdmin.instantiatePreset(
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
