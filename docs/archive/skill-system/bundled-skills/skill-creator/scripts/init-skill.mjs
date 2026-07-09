// skill-creator 内置:skill 脚手架脚本(无外部依赖,纯 node:fs / node:path)
//
// # 文件说明书
//
// ## 核心功能
// 生成一个新 skill 目录 + SKILL.md 模板(frontmatter 占位 name/description + body TODO),
// 可选预创建 resources/ 子目录(scripts / references / assets)。CLI:
//   node ${SKILL_DIR}/scripts/init-skill.mjs <skill-id> [--path <dir>] [--resources scripts,references,assets]
// 默认落到 ~/.zero-core/skills/<skill-id>/(app skills root,立即可发现/可编辑)。
//
// 对应 codex skill-creator 的 init_skill.py(我们用 Node 无依赖版,不引入 Python 依赖)。
//
// ## 怎么跑
//   node init-skill.mjs merge-pdfs
//   node init-skill.mjs merge-pdfs --path /tmp/staging --resources scripts,references
//   node init-skill.mjs plan-mode --resources assets
// 由 skill-creator SKILL.md「Initialize the skill」步骤推荐使用。
//
// ## 核心 logic 是否可 import
// 是 —— 导出 `scaffoldSkill(input)` 纯函数(不直接 IO,只算路径 + 模板内容),
// 供单测直接 import。CLI 入口 `main()` 负责 fs IO + 调用 scaffoldSkill + 打印结果。
//
// ## 校验
//   1. <skill-id> 非空 + path-safe(`/^[a-zA-Z0-9._-]+$/`,1-64,拒 `.`/`..`)
//   2. --path 目录可创建(不存在则 mkdir -p)
//   3. 目标 skill 目录不存在(防覆盖既有 skill)→ 否则 exit 1 + 明确报错
//   4. --resources 取值 ∈ {scripts, references, assets};非法项报错
//
// ## 不创建什么(对齐 SKILL.md「What not to include」)
// 不创建 README.md / CHANGELOG.md / INSTALLATION_GUIDE.md 等冗余文档;
// 不创建未请求的 resources 子目录(只创建 --resources 显式列出的)。
//
// ## 定位
// skill-creator skill 的 scripts/ —— 与 validate-skill.mjs 同目录。
// 不属于 zero-core runtime(不在 src/),只是 skill 自带的工具脚本。
//
// ## 依赖
// 仅 node:fs / node:path / node:process / node:os。无 npm 依赖,随处有 node 即可。
//

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

/** id path-safe 正则(对齐 skill-router.ts 的 isPathSafeId + validate-skill.mjs)。 */
const PATH_SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;
const MAX_ID_LENGTH = 64;

/** 允许的 resources 子目录(对齐 SKILL.md bundled resources)。 */
const ALLOWED_RESOURCES = new Set(["scripts", "references", "assets"]);

/**
 * id(目录名)path-safe 校验 —— 对齐 skill-router.isPathSafeId。
 */
export function isPathSafeId(id) {
	if (typeof id !== "string") return false;
	if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
	if (id === "." || id === "..") return false;
	return PATH_SAFE_ID_RE.test(id);
}

/**
 * 把 skill id 转成 frontmatter name 占位(标题化:hyphen→space,首字母大写)。
 * 仅作模板默认值,作者应改成更贴切的 display name。
 */
function defaultDisplayName(id) {
	return id
		.split(/[-_.]/)
		.filter(Boolean)
		.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/**
 * 生成 SKILL.md 模板内容(frontmatter 占位 + body TODO)。
 * frontmatter description 用显式 [TODO: ...] 提醒作者补全(它是触发主机制,scanner 会跳过空 description)。
 */
function buildSkillMd(id) {
	const displayName = defaultDisplayName(id);
	return [
		"---",
		`name: ${displayName}`,
		"description: [TODO: Complete this description — what the skill does AND when to use it. This is the primary trigger; include specific scenarios, file types, or tasks that trigger it. Be a little \"pushy\" to combat under-triggering.]",
		"---",
		"",
		`# ${displayName}`,
		"",
		"## Overview",
		"",
		"[TODO: 1-2 sentences explaining what this skill enables the agent to do.]",
		"",
		"## When to use",
		"",
		"[TODO: Concrete triggering contexts. (All \"when to use\" info also belongs in the frontmatter description — this section is for the body, loaded after the skill triggers.)]",
		"",
		"## Procedure",
		"",
		"[TODO: The procedure, with examples. Prefer the imperative form; explain the *why* behind each step, not just the command.]",
		"",
	].join("\n");
}

/**
 * 核心:算出一个 skill 脚手架应创建的路径 + 文件内容(纯函数,不做 IO)。
 *
 * @param {object} input
 * @param {string} input.skillId           skill id(目录名);必须 path-safe
 * @param {string} [input.targetDir]       父目录;默认 ~/.zero-core/skills
 * @param {string[]} [input.resources]     要预创建的 resources 子目录(⊆ {scripts,references,assets})
 * @returns {{
 *   skillDir: string,
 *   files: Array<{ path: string, content: string }>,
 *   dirs: string[],
 * }}
 * @throws {Error} id 非法 / resources 非法(调用方 catch 转成 CLI 报错)
 */
export function scaffoldSkill(input) {
	const { skillId } = input;
	if (!isPathSafeId(skillId)) {
		throw new Error(
			`Invalid skill id "${skillId}". Allowed: [a-zA-Z0-9._-], 1-${MAX_ID_LENGTH} chars; reject ".", "..", spaces, path separators.`,
		);
	}

	const targetDir = input.targetDir && input.targetDir.length > 0
		? input.targetDir
		: join(homedir(), ".zero-core", "skills");

	const resources = input.resources ?? [];
	for (const r of resources) {
		if (!ALLOWED_RESOURCES.has(r)) {
			throw new Error(
				`Invalid resource "${r}". Allowed: ${Array.from(ALLOWED_RESOURCES).join(", ")}.`,
			);
		}
	}

	const skillDir = join(targetDir, skillId);
	const skillMdPath = join(skillDir, "SKILL.md");
	const files = [{ path: skillMdPath, content: buildSkillMd(skillId) }];
	const dirs = [skillDir];
	for (const r of resources) {
		dirs.push(join(skillDir, r));
	}

	return { skillDir, files, dirs };
}

// ─── CLI 入口 ───────────────────────────────────────────────

/**
 * 解析 argv:positional <skill-id> + flags --path / --resources。
 *   node init-skill.mjs merge-pdfs --path /tmp --resources scripts,references
 */
function parseArgs(argv) {
	const args = argv.slice(2);
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		return { help: true };
	}
	const skillId = args[0];
	let targetDir;
	let resources = [];
	for (let i = 1; i < args.length; i++) {
		const a = args[i];
		if (a === "--path") {
			targetDir = args[++i];
			if (!targetDir) return { error: "--path requires a value" };
		} else if (a.startsWith("--path=")) {
			targetDir = a.slice("--path=".length);
		} else if (a === "--resources") {
			const raw = args[++i];
			if (!raw) return { error: "--resources requires a value" };
			resources = raw.split(",").map((s) => s.trim()).filter(Boolean);
		} else if (a.startsWith("--resources=")) {
			resources = a.slice("--resources=".length).split(",").map((s) => s.trim()).filter(Boolean);
		} else {
			return { error: `Unknown argument: ${a}` };
		}
	}
	return { skillId, targetDir, resources };
}

const HELP = `Usage: node init-skill.mjs <skill-id> [--path <dir>] [--resources scripts,references,assets]

Scaffolds a new skill directory + SKILL.md template.

Arguments:
  <skill-id>                 Path-safe skill id (also the directory name).
                             Allowed: [a-zA-Z0-9._-], 1-64 chars. Verb-led, hyphen-case preferred.

Options:
  --path <dir>               Parent directory for the skill folder.
                             Defaults to ~/.zero-core/skills/ (app skills root).
  --resources <a,b,c>        Comma-separated bundled-resource subdirs to pre-create.
                             Allowed: scripts, references, assets. Omit for a minimal skill.

Examples:
  node init-skill.mjs merge-pdfs
  node init-skill.mjs merge-pdfs --path /tmp/staging --resources scripts,references
  node init-skill.mjs plan-mode --resources assets

Does NOT create README.md / CHANGELOG.md / etc. (see skill-creator SKILL.md "What not to include").`;

function main() {
	const parsed = parseArgs(process.argv);
	if (parsed.help) {
		console.log(HELP);
		process.exit(0);
	}
	if (parsed.error) {
		console.error(`✗ ${parsed.error}`);
		console.error("");
		console.error(HELP);
		process.exit(2);
	}

	let plan;
	try {
		plan = scaffoldSkill({
			skillId: parsed.skillId,
			targetDir: parsed.targetDir,
			resources: parsed.resources,
		});
	} catch (e) {
		console.error(`✗ ${e.message}`);
		process.exit(2);
	}

	// 防覆盖:目标 skill 目录已存在 → 拒绝(避免破坏既有 skill)。
	if (existsSync(plan.skillDir)) {
		console.error(`✗ Skill directory already exists: ${plan.skillDir}`);
		console.error(`  Refusing to overwrite. Remove it first or pick a different id/path.`);
		process.exit(1);
	}

	// 创建目录(父目录不存在则 mkdir -p)。
	for (const d of plan.dirs) {
		mkdirSync(d, { recursive: true });
	}

	// 写文件。
	for (const f of plan.files) {
		writeFileSync(f.path, f.content, "utf-8");
	}

	const rel = (p) => (isAbsolute(p) ? p : resolve(p));
	console.log(`✓ created skill: ${plan.skillDir}`);
	for (const f of plan.files) {
		console.log(`  ${rel(f.path)}`);
	}
	const createdDirs = plan.dirs.filter((d) => d !== plan.skillDir);
	if (createdDirs.length > 0) {
		console.log(`  resources:`);
		for (const d of createdDirs) {
			console.log(`    ${basename(d)}/`);
		}
	}
	console.log("");
	console.log(`Next: edit the [TODO] placeholders in SKILL.md, then run the validator:`);
	console.log(`  node ${process.argv[1].replace(/init-skill\.mjs$/, "validate-skill.mjs")} ${plan.skillDir}`);
	process.exit(0);
}

// 仅在直接执行(不是 import)时跑 CLI。跨平台 URL 比较(同 validate-skill.mjs)。
function isMainEntry() {
	if (!process.argv[1]) return false;
	try {
		return pathToFileURL(resolve(process.argv[1])).href === new URL(import.meta.url).href;
	} catch {
		return false;
	}
}
if (isMainEntry()) {
	main();
}
