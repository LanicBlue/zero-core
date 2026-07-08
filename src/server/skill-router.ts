// Skill 列表查询 + 本软件 skill CRUD REST 入口
//
// # 文件说明书
//
// ## 核心功能
// - GET /                       :scanSkills 列表(只读,含 user+app,合并去重)。
// - GET /:id/body               :按需读取某 skill 的 SKILL.md 正文(F4 —— scanner
//                                  不持有 body,详情视图经此端点读真实文件)。
// - POST /                      :新建 **仅 `~/.zero-core/skills/`** 下的 skill
//                                  (id path-safe + 不与已有冲突)。
// - PUT /:id                    :更新本软件 skill 的 frontmatter display name /
//                                  description + body。**id=目录名不可改**。
// - DELETE /:id                 :删除本软件 skill 目录(整个目录)。
//
// ## 写路径安全护栏(关键)
// 所有写端点 resolve 后必须落在 `~/.zero-core/skills/`(由 ZERO_CORE_DIR 派生)
// 之内。`assertWithinAppSkillsRoot()` 拒绝任何越界:`../` 跨出、绝对外部路径、
// 不可信 id(含路径分隔符 / 非 path-safe 字符)。绝不写 ~/.claude / ~/.agents。
//
// ## 输入
// - GET /:id/body、PUT /:id、DELETE /:id 接 path 参数 id(skill 目录名)。
// - POST /、PUT /:id 接 JSON body({ id?, name, description, body })。
//
// ## 输出
// - GET /          → DiscoveredSkill[]
// - GET /:id/body  → { body: string } 或 404
// - POST /         → DiscoveredSkill(新建后)或 400/409/500
// - PUT /:id       → DiscoveredSkill(更新后)或 400/404/500
// - DELETE /:id    → { success: true } 或 404/500
//
// ## 定位
// src/server/ 服务层,挂载于 /api/skills。
//
// ## 依赖
// - express Router
// - ./skill-scanner(scanSkills)
// - node:fs / node:path
// - ../core/config.js(ZERO_CORE_DIR —— E2E 可重写,生产= ~/.zero-core)
//
// ## 维护规则
// - 写端点绝不放开到 ~/.zero-core/skills 之外;新增来源目录改 scanner,不改本路由。
// - v1 CRUD 只管 SKILL.md 入口;兄弟文件/脚本的新建编辑留后续 sub(标注边界)。
//

import { Router } from "express";
import {
	scanSkills,
} from "./skill-scanner.js";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

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

	// 按需读 body(F4):scanner 不持有 body,详情视图经此端点读真实 SKILL.md 正文。
	// 外部来源 + 本软件都可读(只读展示)。
	router.get("/:id/body", (req, res) => {
		try {
			const id = req.params.id;
			const skill = scanSkills().find((s) => s.id === id);
			if (!skill) {
				res.status(404).json({ error: `Skill not found: ${id}` });
				return;
			}
			// skill.filePath 是 scanner resolve 出的真实路径,只读。
			if (!existsSync(skill.filePath)) {
				res.status(404).json({ error: `SKILL.md missing: ${id}` });
				return;
			}
			const raw = readFileSync(skill.filePath, "utf-8");
			res.json({ body: stripFrontmatter(raw), source: skill.source });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// 新建本软件 skill。仅落 ~/.zero-core/skills/<id>/SKILL.md。
	router.post("/", (req, res) => {
		try {
			const { id, name, description, body } = req.body ?? {};
			if (typeof id !== "string" || !isPathSafeId(id)) {
				res.status(400).json({ error: "Invalid id: must be path-safe (letters, digits, dash, underscore, dot) and non-empty" });
				return;
			}
			if (typeof name !== "string" || name.trim() === "") {
				res.status(400).json({ error: "Invalid name: non-empty string required" });
				return;
			}
			if (typeof description !== "string" || description.trim() === "") {
				res.status(400).json({ error: "Invalid description: non-empty string required" });
				return;
			}
			if (typeof body !== "string") {
				res.status(400).json({ error: "Invalid body: string required" });
				return;
			}

			// 重名拒绝(任何来源已存在该 id 都拒——避免与 user 源冲突)。
			const existing = scanSkills().find((s) => s.id === id);
			if (existing) {
				res.status(409).json({ error: `Skill already exists: ${id}` });
				return;
			}

			const skillDir = appSkillDir(id);
			// 二次护栏:目录已存在(可能 user 源被覆盖语义里不可见,但磁盘上有)。
			if (existsSync(skillDir)) {
				res.status(409).json({ error: `Skill directory already exists: ${id}` });
				return;
			}

			mkdirSync(skillDir, { recursive: true });
			const skillMd = join(skillDir, "SKILL.md");
			// 写后校验路径(防御性——id 已 path-safe,这里再断言一次)。
			assertWithinAppSkillsRoot(skillMd);
			writeFileSync(skillMd, buildSkillMd({ name, description, body }), "utf-8");

			const created = scanSkills().find((s) => s.id === id);
			if (!created) {
				res.status(500).json({ error: "Created but not discovered (frontmatter invalid?)" });
				return;
			}
			res.status(201).json(created);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// 更新本软件 skill 的 frontmatter display name / description + body。
	// id=目录名不可改(只改 SKILL.md 内容)。外部来源不可编辑(403)。
	router.put("/:id", (req, res) => {
		try {
			const id = req.params.id;
			const { name, description, body } = req.body ?? {};

			// 必须是本软件来源(app)才能编辑。
			const skill = scanSkills().find((s) => s.id === id);
			if (!skill) {
				res.status(404).json({ error: `Skill not found: ${id}` });
				return;
			}
			if (skill.source !== "app") {
				res.status(403).json({ error: `Skill is read-only (source=${skill.source}): ${id}` });
				return;
			}

			if (typeof name !== "string" || name.trim() === "") {
				res.status(400).json({ error: "Invalid name: non-empty string required" });
				return;
			}
			if (typeof description !== "string" || description.trim() === "") {
				res.status(400).json({ error: "Invalid description: non-empty string required" });
				return;
			}
			if (typeof body !== "string") {
				res.status(400).json({ error: "Invalid body: string required" });
				return;
			}

			// 写回 skill.filePath(scanner 已 resolve,本软件来源 = ~/.zero-core/skills/<id>/SKILL.md)。
			// 二次护栏:再断言路径在 app 根内。
			assertWithinAppSkillsRoot(skill.filePath);
			writeFileSync(skill.filePath, buildSkillMd({ name, description, body }), "utf-8");

			const updated = scanSkills().find((s) => s.id === id);
			res.status(200).json(updated);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// 删除本软件 skill(整个目录 + 兄弟文件)。外部来源不可删(403)。
	router.delete("/:id", (req, res) => {
		try {
			const id = req.params.id;
			const skill = scanSkills().find((s) => s.id === id);
			if (!skill) {
				res.status(404).json({ error: `Skill not found: ${id}` });
				return;
			}
			if (skill.source !== "app") {
				res.status(403).json({ error: `Skill is read-only (source=${skill.source}): ${id}` });
				return;
			}
			// 删 baseDir(scanner resolve,本软件来源 = ~/.zero-core/skills/<id>)。
			assertWithinAppSkillsRoot(skill.baseDir);
			rmSync(skill.baseDir, { recursive: true, force: true });
			res.status(200).json({ success: true });
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}

// ─── 内部辅助 ─────────────────────────────────────────────

/**
 * 本软件 skill 根目录:`~/.zero-core/skills/`(与 scanner.getSkillRoots() 的 app 项一致)。
 *
 * **不读 ZERO_CORE_DIR** —— scanner 用 `os.homedir()` 解析 app 根,router 必须用同一处,
 * 否则 router 写的目录与 scanner 读的目录错位。E2E / 单测通过重定向 `os.homedir()`
 * (vi.mock "node:os" 或 USERPROFILE/HOME env)来隔离。
 */
export function appSkillsRoot(): string {
	return join(homedir(), ".zero-core", "skills");
}

/** 单个本软件 skill 的目录路径。 */
export function appSkillDir(id: string): string {
	return join(appSkillsRoot(), id);
}

/**
 * 路径安全护栏(关键):断言 `target` resolve 后位于 `appSkillsRoot()` 之内。
 * 拒绝 `../` 越界、绝对外部路径、符号链接逃逸(用 realpath 二次校验)。
 *
 * 注意:这里只断言"已 resolve 的路径字符串前缀",不依赖输入 id——
 * 调用方应先用 `isPathSafeId()` 把 id 字符白名单化,本函数是第二道防线。
 *
 * @throws Error 若 target 在 appSkillsRoot() 之外
 */
export function assertWithinAppSkillsRoot(target: string): void {
	const root = resolve(appSkillsRoot());
	const resolved = resolve(target);
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	// 必须等于 root 或位于 root/ 之下。
	if (resolved !== root && !resolved.startsWith(rootWithSep)) {
		throw new Error(`Refusing to write outside app skills root: ${target} (resolved: ${resolved}, root: ${root})`);
	}
}

/**
 * id(目录名)白名单:path-safe,不含路径分隔符 / 空格 / 特殊字符。
 * 允许 `[a-zA-Z0-9._-]`,长度 1-64。拒 `.`、`..`、含 `/`、`\`、`:`、空格等。
 */
export function isPathSafeId(id: string): boolean {
	if (typeof id !== "string") return false;
	if (id.length === 0 || id.length > 64) return false;
	if (id === "." || id === "..") return false;
	return /^[a-zA-Z0-9._-]+$/.test(id);
}

/**
 * 重组 SKILL.md:frontmatter(name + description)+ body。
 * 仅写这两个字段(决策 9);其他 frontmatter 字段 v1 不保留(本软件 skill 由本系统管理)。
 */
export function buildSkillMd(input: { name: string; description: string; body: string }): string {
	const fm = [
		"---",
		`name: ${yamlScalar(input.name)}`,
		`description: ${yamlScalar(input.description)}`,
		"---",
		"",
	].join("\n");
	// body 末尾保证单个换行收尾。
	const body = input.body.replace(/\s+$/,"") + "\n";
	return fm + body;
}

/** YAML scalar 序列化:含特殊字符(冒号/引号/换行/首尾空白)→ 双引号包裹 + 转义。 */
function yamlScalar(s: string): string {
	if (s === "") return '""';
	// 简单启发式:无特殊字符 → 裸写;否则双引号 + 转义双引号 + 反斜杠。
	const needsQuote = /[:#&*!|>'"%@`"'\\\n,{}\[\]]/.test(s) || /^\s|\s$/.test(s);
	if (!needsQuote) return s;
	const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

/**
 * 剥离 frontmatter,返回 body 正文。若无 frontmatter → 全文。
 * 与 scanner.parseSkillFrontmatter 对齐(但这里返回 body 而非 frontmatter 字段)。
 */
export function stripFrontmatter(raw: string): string {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized;
	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) return normalized;
	// 跳过结束 `---` 行本身 + 后续空行。
	let bodyStart = endIdx + 4; // "\n---".length
	// 吃掉 `---` 行的剩余到下一个 \n。
	const nextNl = normalized.indexOf("\n", bodyStart);
	if (nextNl === -1) return "";
	bodyStart = nextNl + 1;
	// 吃掉 body 开头的多余空行(最多 1 个,保留语义上的段落分隔)。
	return normalized.slice(bodyStart).replace(/^\n+/, "\n").replace(/^\n/, "");
}
