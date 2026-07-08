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
	parseSkillFrontmatter,
} from "./skill-scanner.js";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	readdirSync,
	statSync,
} from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { symlinkSync, readlinkSync } from "node:fs";

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

	// sub-7:从 git URL 安装第三方 skill。
	// 流程:clone 到临时目录 → auto-detect(只根 + 一层子目录)→ scanner 校验
	// 每个 skill 合法 → 重名原子性检查(任一冲突整批拒)→ 移到 ~/.zero-core/skills/<id>/。
	// 任一步失败 → 删临时 clone,不落盘。落盘保留 .git(为未来 pull,虽 v1 不做)。
	//
	// **关键设计**(对齐 design 决策 10):
	// - auto-detect 只根 + 一层子目录,不递归(避免误装深层)。
	// - 任一 id 与现有同名 → **整批拒绝**(对齐 A2,多 skill 时一个冲突全拒)。
	// - 走系统 git(用户凭证/SSH key),不内置 token;系统无 git → 明确报错。
	// - 落盘仅 ~/.zero-core/skills/(复用 sub-6 写路径护栏)。保留 .git。
	router.post("/install-git", async (req, res) => {
		let tmpCloneDir: string | null = null;
		try {
			const url = req.body?.url;
			if (typeof url !== "string" || url.trim() === "") {
				res.status(400).json({ error: "Invalid url: non-empty string required" });
				return;
			}

			// 1. 系统 git 可用性检查(友好报错,而不是把 spawn ENOENT 透传)。
			if (!(await isGitAvailable())) {
				res.status(500).json({ error: "git not found on PATH — install git to use this feature" });
				return;
			}

			// 2. clone 到临时目录(mkdtemp 给一个唯一父目录;git clone 创建最终一层)。
			const repoName = deriveRepoName(url);
			tmpCloneDir = mkdtempSync(join(tmpdir(), "zc-skill-git-"));
			const cloneTarget = join(tmpCloneDir, repoName);

			try {
				await runGit(["clone", "--", url, cloneTarget]);
			} catch (e) {
				cleanupTmp(tmpCloneDir);
				tmpCloneDir = null;
				res.status(400).json({ error: `git clone failed: ${(e as Error).message}` });
				return;
			}

			// 3. auto-detect(只根 + 一层子目录,不递归)。
			const detected = detectSkillsInClone(cloneTarget, repoName);
			if (detected.length === 0) {
				cleanupTmp(tmpCloneDir);
				tmpCloneDir = null;
				res.status(400).json({ error: "未检测到合法 skill (no SKILL.md at repo root or in direct subdirectories)" });
				return;
			}

			// 4. 校验每个 skill:合法 SKILL.md + 合法 frontmatter(name+description)。
			//    任一失败 → 整批回滚(删临时 clone,不落盘)。
			for (const d of detected) {
				const validation = validateDetectedSkill(d);
				if (!validation.ok) {
					cleanupTmp(tmpCloneDir);
					tmpCloneDir = null;
					res.status(400).json({ error: `skill "${d.id}" invalid: ${validation.error}` });
					return;
				}
			}

			// 5. 重名原子性检查(对齐 A2):任一目标 id 已存在 → 整批拒绝 + 清理临时 clone。
			const existingIds = new Set(scanSkills().map((s) => s.id));
			const conflict = detected.find((d) => existingIds.has(d.id));
			if (conflict) {
				cleanupTmp(tmpCloneDir);
				tmpCloneDir = null;
				res.status(409).json({ error: `skill already exists: ${conflict.id} (整个批次已拒绝)` });
				return;
			}

			// 6. 落盘:逐个移到 ~/.zero-core/skills/<id>/。
			//    id 已通过 isPathSafeId + detectSkillsInClone 双重护栏;dest 在 appSkillsRoot 内。
			const installed: { id: string; name: string; description: string; source: "app" | "user" }[] = [];
			for (const d of detected) {
				const dest = appSkillDir(d.id);
				assertWithinAppSkillsRoot(dest);
				if (existsSync(dest)) {
					// 防御性:扫描时不存在但磁盘上有 → 回滚已落盘的 + 删临时 clone。
					for (const done of installed) {
						try { rmSync(appSkillDir(done.id), { recursive: true, force: true }); } catch {}
					}
					cleanupTmp(tmpCloneDir);
					tmpCloneDir = null;
					res.status(409).json({ error: `skill directory already exists: ${d.id}` });
					return;
				}
				// rename 跨设备会失败;这里同机 tmp → home,通常同盘。失败回退 copy+rm。
				try {
					renameSync(d.srcDir, dest);
				} catch {
					try {
						copyDirSync(d.srcDir, dest);
						rmSync(d.srcDir, { recursive: true, force: true });
					} catch (e2) {
						// 回滚已落盘的 + 报错。
						for (const done of installed) {
							try { rmSync(appSkillDir(done.id), { recursive: true, force: true }); } catch {}
						}
						try { if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); } catch {}
						cleanupTmp(tmpCloneDir);
						tmpCloneDir = null;
						res.status(500).json({ error: `failed to move skill ${d.id}: ${(e2 as Error).message}` });
						return;
					}
				}
				installed.push({
					id: d.id,
					name: d.frontmatter!.name!,
					description: d.frontmatter!.description!,
					source: "app",
				});
			}

			// 7. 清理临时 clone 父目录(rename 已搬走 skill 目录,残留空 clone 目录删掉)。
			cleanupTmp(tmpCloneDir);
			tmpCloneDir = null;

			// 8. 重扫确认落盘成功 + 返回新装的 skill 列表。
			const allSkills = scanSkills();
			const installedIds = new Set(installed.map((i) => i.id));
			const installedSkills = allSkills.filter((s) => installedIds.has(s.id));
			res.status(201).json({ installed: installedSkills });
		} catch (e) {
			if (tmpCloneDir) { try { cleanupTmp(tmpCloneDir); } catch {} }
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

// ─── sub-7: git URL 安装辅助 ─────────────────────────────────────

/**
 * 从 git URL 推导 repo 名(用作单 skill 布局下的 id 候选)。
 * 处理 https://host/owner/repo(.git)、git@host:owner/repo.git、file:///path/repo、本地路径。
 * 取最后一段,去 `.git` 后缀,path-safe 化(非法字符 → `-`);空 / 全非法 → "skill"。
 *
 * **注意**:返回值还要过 isPathSafeId 才能用(detectSkillsInClone 内部会校验)。
 */
export function deriveRepoName(url: string): string {
	const trimmed = url.trim();
	// 先切掉末尾斜杠,再切 .git 后缀(顺序重要:`.git/` 要两步都剥)。
	let s = trimmed.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
	// 取最后一段:按 / : \ 切分(覆盖 https/git@/file:// 三种)。
	const segs = s.split(/[\/:\\]/);
	let last = segs[segs.length - 1] ?? "";
	// path-safe 化:非法字符 → "-"。
	last = last.replace(/[^a-zA-Z0-9._-]/g, "-");
	// 去首尾的 . - 防止生成的 id 仍非法(如 leading dash)。
	last = last.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
	if (last.length === 0) return "skill";
	if (last.length > 64) last = last.slice(0, 64);
	return last;
}

/** 探测到的 skill 候选(单 skill 布局 = repo 根;多 skill 布局 = 各直接子目录)。 */
export interface DetectedSkill {
	id: string;
	/** skill 目录的绝对路径(repo 根 或 直接子目录)。 */
	srcDir: string;
	/** 已解析的 frontmatter(校验时填充);校验前为 undefined。 */
	frontmatter?: { name?: string; description?: string };
}

/**
 * auto-detect 多 skill 布局(只根 + 一层子目录,**不递归**)。
 *
 * 规则(对齐 design 决策 10 + A1):
 *   - repo 根有 SKILL.md → 单 skill 候选,id = repo 名(path-safe 化,过 isPathSafeId)。
 *   - 直接子目录各有 SKILL.md → 多 skill 候选,id = 子目录名(过 isPathSafeId;不过的跳过)。
 *   - 两者并存 → 都装(id 各自取)。
 *   - 一个都没 → 返回空(调用方报错「未检测到合法 skill」)。
 *
 * @param cloneRoot clone 后的 repo 根目录(临时目录内)。
 * @param repoName deriveRepoName(url) 的结果,用于单 skill 布局的 id。
 */
export function detectSkillsInClone(cloneRoot: string, repoName: string): DetectedSkill[] {
	const out: DetectedSkill[] = [];
	const rootSkillMd = join(cloneRoot, "SKILL.md");

	// 1. repo 根有 SKILL.md → 单 skill 候选(id = repoName)。
	if (existsSync(rootSkillMd)) {
		if (isPathSafeId(repoName)) {
			out.push({ id: repoName, srcDir: cloneRoot });
		}
		// repoName 非 path-safe(罕见,deriveRepoName 已清洗)→ 根 skill 装不了,跳过。
	}

	// 2. 直接子目录各有 SKILL.md → 多 skill 候选(id = 子目录名,过 isPathSafeId)。
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(cloneRoot, { withFileTypes: true });
	} catch {
		entries = [];
	}
	for (const ent of entries) {
		if (!ent.isDirectory()) continue;
		if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
		const sub = join(cloneRoot, ent.name);
		const subSkillMd = join(sub, "SKILL.md");
		if (!existsSync(subSkillMd)) continue;
		if (!isPathSafeId(ent.name)) continue; // 子目录名非法 → 跳过(不递归清洗,避免 id 漂移)。
		// 去重:若根 skill 的 id 与某子目录名同名(repoName == subdir name)→ 根已加,跳过。
		if (out.some((d) => d.id === ent.name)) continue;
		out.push({ id: ent.name, srcDir: sub });
	}

	return out;
}

/**
 * 校验单个 detected skill:SKILL.md 存在 + 可读 + 合法 frontmatter(name+description)。
 * 与 scanner.scanDir 的校验对齐(单文件 ≤ 256KB,frontmatter 有 description)。
 */
export function validateDetectedSkill(d: DetectedSkill): { ok: true } | { ok: false; error: string } {
	const skillMd = join(d.srcDir, "SKILL.md");
	if (!existsSync(skillMd)) {
		return { ok: false, error: "SKILL.md missing" };
	}
	let stat;
	try {
		stat = statSync(skillMd);
	} catch (e) {
		return { ok: false, error: `SKILL.md stat failed: ${(e as Error).message}` };
	}
	if (stat.size > 256_000) {
		return { ok: false, error: `SKILL.md too large (${stat.size} > 256000 bytes)` };
	}
	let raw: string;
	try {
		raw = readFileSync(skillMd, "utf-8");
	} catch (e) {
		return { ok: false, error: `SKILL.md read failed: ${(e as Error).message}` };
	}
	const fm = parseSkillFrontmatter(raw);
	d.frontmatter = fm;
	if (!fm.name || fm.name.trim() === "") {
		return { ok: false, error: "frontmatter missing name" };
	}
	if (!fm.description || fm.description.trim() === "") {
		return { ok: false, error: "frontmatter missing description" };
	}
	return { ok: true };
}

/**
 * 探测系统 git 是否可用(spawn `git --version`)。不抛错,不可用 → false。
 */
export async function isGitAvailable(): Promise<boolean> {
	try {
		await runGit(["--version"], /* ignoreExit */ false);
		return true;
	} catch {
		return false;
	}
}

/**
 * 跑一个 git 子进程,返回 Promise(exit≠0 或 spawn 失败 → reject,带 stderr 摘要)。
 *
 * **安全**:args 数组透传(不经 shell),URL 作为单个 argv 元素,避免 shell 注入。
 * `--` 分隔符放在 url 前防止它被解释为选项。
 */
function runGit(args: string[], ignoreExit = false): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c) => { stdout += c.toString(); });
		child.stderr?.on("data", (c) => { stderr += c.toString(); });
		child.on("error", (err) => {
			reject(new Error(`git spawn failed: ${err.message}`));
		});
		child.on("close", (code) => {
			if (code === 0 || ignoreExit) {
				resolve({ stdout, stderr });
			} else {
				const excerpt = stderr.length > 300 ? stderr.slice(0, 300) + "..." : stderr;
				reject(new Error(`git ${args.join(" ")} exit=${code}: ${excerpt.trim() || stdout.trim()}`));
			}
		});
	});
}

/** 清理临时 clone 父目录(rename 后通常空,残留 .git/ 配置等)。 */
function cleanupTmp(dir: string): void {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

/** 递归复制目录(rename 跨设备失败的回退)。 */
function copyDirSync(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });
	for (const ent of entries) {
		const s = join(src, ent.name);
		const d = join(dest, ent.name);
		if (ent.isDirectory()) {
			copyDirSync(s, d);
		} else if (ent.isFile()) {
			writeFileSync(d, readFileSync(s));
		} else if (ent.isSymbolicLink()) {
			// 符号链接:readlink + 重造(SKILL.md + 兄弟脚本是常规文件,链接少见)。
			try {
				symlinkSync(readlinkSync(s), d);
			} catch {
				// 失败 → 跳过。
			}
		}
	}
}
