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
