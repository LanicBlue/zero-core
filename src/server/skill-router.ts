// Skill 列表查询 REST 入口,扫描本机已安装的 skill 目录
//
// # 文件说明书
//
// ## 核心功能
// 暴露 GET / 端点,调用 skill-scanner.scanSkills 收集本机 user/app 目录下的 SKILL.md,返回 skill 列表(id、name、description、source、filePath、baseDir)供前端展示与选择。
//
// ## 输入
// - 无路径参数,无请求体
// - 实际依赖 skill-scanner 内置的扫描路径(~/.claude/skills、~/.agents/skills、~/.zero-core/skills)
//
// ## 输出
// - GET / 返回 DiscoveredSkill[];失败返回 500 + { error }
//
// ## 定位
// src/server/ 服务层,挂载于 /api/skills,服务于渲染进程的 skill 选择/查看面板。
//
// ## 依赖
// - express Router
// - ./skill-scanner(scanSkills)
//
// ## 维护规则
// - 本路由只做读;skill 的安装/卸载由外部工具完成。
// - 若未来支持工作区级 skill,需在 scanner 增加扫描路径,不要在本路由硬编码目录。
//

import { Router } from "express";
import { scanSkills } from "./skill-scanner.js";

export function createSkillRouter(): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		try {
			const skills = scanSkills();
			res.json(skills);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
