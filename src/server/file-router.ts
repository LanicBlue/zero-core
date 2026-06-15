// 文件浏览/读写 REST 入口,给前端文件树与编辑器提供后端能力
//
// # 文件说明书
//
// ## 核心功能
// 暴露工作区文件树读取、文本内容读取、路径解析(含 ~ 展开)与文本文件保存四个端点,带根目录越权保护(防止路径逃逸出 workspace 根)与体积/二进制限制。
//
// ## 输入
// - query.root 或 workspaceConfig.workspaceDir 作为根目录(支持 ~ 展开)
// - query.path / body.filePath 指定相对或绝对文件路径
// - PUT /save 请求体 { filePath, content, root? }
//
// ## 输出
// - GET /tree 返回 buildTree 生成的目录树 JSON
// - GET /content 返回 { content } 或错误码(404 / 403 / 400)
// - GET /resolve-path 返回绝对路径 { path }
// - PUT /save 返回 { success: true } 或 500 错误
//
// ## 定位
// src/server/ 服务层,挂载于 /api/files,服务于渲染进程的文件资源管理器与代码编辑面板。
//
// ## 依赖
// - express Router、node:fs、node:path、node:os
// - ../shared/file-utils.ts(TEXT_EXTS、buildTree)
// - workspaceConfig
//
// ## 维护规则
// - 任何路径访问前必须先经过 startsWith(root) 校验,避免越权读写工作区之外。
// - 文本扩展名白名单或单文件体积上限(500KB)调整时同步修改。
// - 涉及二进制/大文件场景请保持只读或不实现,不要绕过限制。
//

import { Router } from "express";
import { resolve, extname } from "path";
import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { TEXT_EXTS, buildTree } from "../shared/file-utils.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function createFileRouter(deps: { workspaceConfig: any }): Router {
	const router = Router();

	const getRoot = (req: any) => expandHome((req.query.root as string) || deps.workspaceConfig.workspaceDir);

	router.get("/tree", (req, res) => {
		const dir = getRoot(req);
		try {
			const s = statSync(dir);
			if (!s.isDirectory()) return res.status(400).json({ error: "not a directory" });
		} catch {
			return res.status(404).json({ error: "directory not found" });
		}
		res.json(buildTree(dir, ""));
	});

	router.get("/content", (req, res) => {
		const filePath = req.query.path as string;
		if (!filePath) return res.status(400).json({ error: "path required" });

		const ext = extname(filePath);
		if (!TEXT_EXTS.has(ext) && ext !== "") {
			return res.json({ content: "(binary file)" });
		}

		const root = getRoot(req);
		const full = resolve(root, filePath);
		if (!full.startsWith(resolve(root))) {
			return res.status(403).json({ error: "access denied" });
		}

		try {
			const s = statSync(full);
			if (s.size > 500_000) return res.json({ content: "(file too large, > 500KB)" });
			res.json({ content: readFileSync(full, "utf-8") });
		} catch {
			res.status(404).json({ error: "file not found" });
		}
	});

	router.get("/resolve-path", (req, res) => {
		const filePath = req.query.path as string;
		if (!filePath) return res.status(400).json({ error: "path required" });

		const root = getRoot(req);
		const full = resolve(root, filePath);
		if (!full.startsWith(resolve(root))) {
			return res.status(403).json({ error: "access denied" });
		}
		res.json({ path: full });
	});

	router.put("/save", (req, res) => {
		const { filePath, content, root: reqRoot } = req.body;
		if (!filePath) return res.status(400).json({ error: "path required" });

		const root = expandHome(reqRoot || deps.workspaceConfig.workspaceDir);
		const full = resolve(root, filePath);
		if (!full.startsWith(resolve(root))) {
			return res.status(403).json({ error: "access denied" });
		}

		try {
			writeFileSync(full, content, "utf-8");
			res.json({ success: true });
		} catch (err: any) {
			res.status(500).json({ error: err.message });
		}
	});

	return router;
}
