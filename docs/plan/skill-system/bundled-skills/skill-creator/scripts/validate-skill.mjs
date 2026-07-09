// skill-creator 内置:skill 格式审查脚本(无外部依赖,纯 node:fs / node:path)
//
// # 文件说明书
//
// ## 核心功能
// 审查一个 skill 是否格式合格:目录/SKILL.md 存在 → 合法 frontmatter →
// name 非空 → description 非空(过短作 warning,不致命)→ SKILL.md ≤ 256KB →
// 目录名 path-safe → body 非空。逐条报错,全过才 exit 0。
//
// ## 怎么跑
//   node ${SKILL_DIR}/scripts/validate-skill.mjs <skill-dir-or-SKILL.md-path>
// sub-3 Shell 通道会把 `${SKILL_DIR}` 与 `[skills]/<id>/` 解析成真实路径。
//
// ## 核心 logic 是否可 import
// 是 —— 导出 `validateSkill(input)` 纯函数(不直接 IO),供单测直接 import。
// CLI 入口 `main()` 负责 fs IO + 把读到的字符串/路径喂给 `validateSkill`,
// 然后按 `problems`/`warnings` 打印 + 设 exit code。这样测函数不必 spawn node。
//
// ## 审查项(每项独立,逐条报错;warnings 不影响 exit code)
//   1. SKILL.md 存在
//   2. frontmatter 合法(`---` 包裹,且至少有一个 `key: value`)
//   3. frontmatter 有 name(非空)
//   4. frontmatter 有 description(非空)—— 它是触发主机制,缺了 scanner 直接跳过
//   5. description 不过短(< 10 字符)→ **warning**(可过严误伤,只提示)
//   6. SKILL.md 文件大小 ≤ 256_000 字节(scanner 上限,超了被跳过)
//   7. 目录名 path-safe(`/^[a-zA-Z0-9._-]+$/`,1-64,拒 `.`/`..`)—— 仅当入参是目录
//   8. body 非空(frontmatter 之后有内容)
//
// ## 定位
// skill-creator skill 的 scripts/ —— 由 skill-creator 在每次 draft 后强制跑。
// 不属于 zero-core runtime(不在 src/),只是 skill 自带的工具脚本。
//
// ## 依赖
// 仅 node:fs / node:path / node:process。无 npm 依赖,随处有 node 即可。
//

import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** SKILL.md scanner 上限(对齐 src/server/skill-scanner.ts 与 skill-router.ts)。 */
const MAX_SKILL_MD_BYTES = 256_000;

/** description 最小长度建议(过短 → warning,不致命)。 */
const MIN_DESCRIPTION_CHARS = 10;

/** id path-safe 正则(对齐 skill-router.ts 的 isPathSafeId)。 */
const PATH_SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * 轻量 YAML frontmatter 解析(对齐 scanner.parseSkillFrontmatterFull):
 * 仅 `---\n...\n---` 包裹的顶层 `key: value` 标量行;value 去配对引号。
 * 无 frontmatter → 返回 {}。不处理嵌套/数组/多行块。
 */
function parseFrontmatter(content) {
	const normalized = String(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return {};
	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) return {};
	const block = normalized.slice(4, endIdx);
	const out = {};
	for (const line of block.split("\n")) {
		if (/^\s/.test(line)) continue; // 跳过缩进行(嵌套/列表)
		const m = line.match(/^([\w-]+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

/**
 * body 提取:frontmatter 之后的内容(去结尾分隔符 + 前导空行)。
 * 无 frontmatter → 整个 content 当 body。
 */
function extractBody(content) {
	const normalized = String(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return normalized.trim();
	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) return normalized.trim();
	return normalized.slice(endIdx + 4).trim();
}

/**
 * id(目录名)path-safe 校验 —— 对齐 skill-router.isPathSafeId。
 */
function isPathSafeId(id) {
	if (typeof id !== "string") return false;
	if (id.length === 0 || id.length > 64) return false;
	if (id === "." || id === "..") return false;
	return PATH_SAFE_ID_RE.test(id);
}

/**
 * 核心:审查一个 skill 是否格式合格(纯函数,不做 IO)。
 *
 * @param {object} input
 * @param {string} input.skillMdContent  SKILL.md 文件内容(已读入)
 * @param {number} [input.skillMdBytes]  SKILL.md 字节数(省略时按 utf8 长度估)
 * @param {string|null|undefined} [input.dirName]  目录名(id);省略/入参是 SKILL.md 路径 → 跳过 id 校验
 * @returns {{ problems: string[], warnings: string[] }}
 *   problems 非空 → 不合格(exit 1);warnings 非空 → 提示但仍合格(exit 0)。
 */
export function validateSkill(input) {
	const problems = [];
	const warnings = [];

	const { skillMdContent } = input;
	if (typeof skillMdContent !== "string") {
		problems.push("SKILL.md content is not a string (internal error).");
		return { problems, warnings };
	}

	// 字节数:优先用调用方给的 stat.size;否则用 utf8 字节长度估算(够审查用)。
	const bytes = typeof input.skillMdBytes === "number"
		? input.skillMdBytes
		: Buffer.byteLength(skillMdContent, "utf8");

	// 2. frontmatter 合法(--- 包裹)
	const fm = parseFrontmatter(skillMdContent);
	const looksLikeFrontmatter =
		String(skillMdContent).replace(/\r\n/g, "\n").replace(/\r/g, "\n").startsWith("---") &&
		/\r?\n---\s/.test(String(skillMdContent).slice(3));
	if (!looksLikeFrontmatter) {
		problems.push("SKILL.md has no valid YAML frontmatter (expected leading `---` ... closing `---`).");
	}
	if (looksLikeFrontmatter && Object.keys(fm).length === 0) {
		problems.push("Frontmatter block is empty (no `key: value` lines parsed).");
	}

	// 3. name 非空
	if (looksLikeFrontmatter && Object.keys(fm).length > 0) {
		const name = (fm.name ?? "").trim();
		if (!name) {
			problems.push("Frontmatter is missing non-empty `name`.");
		}
	}

	// 4 + 5. description 非空(error)+ 过短(warning)
	if (looksLikeFrontmatter && Object.keys(fm).length > 0) {
		const desc = (fm.description ?? "").trim();
		if (!desc) {
			// description 是触发主机制;scanner 跳过无 description 的 skill。
			problems.push("Frontmatter is missing non-empty `description` (this is the skill's primary trigger — scanner drops skills without it).");
		} else if (desc.length < MIN_DESCRIPTION_CHARS) {
			warnings.push(
				`description is very short (${desc.length} chars < ${MIN_DESCRIPTION_CHARS}). ` +
				`It's the primary trigger — prefer what-it-does + when-to-use-it.`
			);
		}
	}

	// 6. SKILL.md 大小 ≤ 256KB
	if (bytes > MAX_SKILL_MD_BYTES) {
		problems.push(
			`SKILL.md is too large (${bytes} bytes > ${MAX_SKILL_MD_BYTES} / 256KB). ` +
			`Scanner skips files over this limit — the skill would silently disappear.`
		);
	}

	// 7. 目录名 path-safe(仅当调用方给了 dirName,即入参是目录)
	if (input.dirName !== undefined && input.dirName !== null) {
		if (!isPathSafeId(input.dirName)) {
			problems.push(
				`Directory name (id) "${input.dirName}" is not path-safe. ` +
				`Allowed: [a-zA-Z0-9._-], 1-64 chars; reject ".", "..", spaces, path separators, special chars.`
			);
		}
	}

	// 8. body 非空(frontmatter 之后有内容)
	const body = extractBody(skillMdContent);
	if (!body) {
		problems.push("SKILL.md body is empty (need content after the frontmatter).");
	}

	return { problems, warnings };
}

// ─── CLI 入口 ───────────────────────────────────────────────

/**
 * 把 argv[2] 解析为 { skillMdPath, dirName }:
 *   - 入参是 SKILL.md → skillMdPath = 入参,dirName = 父目录名(供 id 校验)
 *   - 入参是目录 → skillMdPath = <dir>/SKILL.md,dirName = 入参目录名
 *   - 入参缺失 → 报 usage
 */
function resolveTarget(arg) {
	if (!arg) return { error: "Usage: node validate-skill.mjs <skill-dir | path/to/SKILL.md>" };
	const abs = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
	if (!existsSync(abs)) {
		return { error: `Not found: ${abs}` };
	}
	const st = statSync(abs);
	if (st.isDirectory()) {
		return { skillMdPath: join(abs, "SKILL.md"), dirName: basename(abs) };
	}
	// 文件:当作 SKILL.md 路径处理;父目录名作为 id(若父目录是 skills 根则 id 校验会被自然跳过——
	// 实际不会,因为我们仍取 basename。但如果父目录名不 path-safe,这恰好是个真问题,报出来对。)
	return { skillMdPath: abs, dirName: basename(dirname(abs)) };
}

function main() {
	const target = resolveTarget(process.argv[2]);
	if (target.error) {
		console.error(`✗ ${target.error}`);
		process.exit(2);
	}

	// 1. SKILL.md 存在
	if (!existsSync(target.skillMdPath)) {
		console.error(`✗ SKILL.md not found at: ${target.skillMdPath}`);
		process.exit(1);
	}

	let content;
	let bytes;
	try {
		const st = statSync(target.skillMdPath);
		bytes = st.size;
		content = readFileSync(target.skillMdPath, "utf-8");
	} catch (e) {
		console.error(`✗ Failed to read SKILL.md: ${e.message}`);
		process.exit(1);
	}

	const { problems, warnings } = validateSkill({
		skillMdContent: content,
		skillMdBytes: bytes,
		dirName: target.dirName,
	});

	for (const w of warnings) console.warn(`! warning: ${w}`);
	if (problems.length > 0) {
		for (const p of problems) console.error(`✗ ${p}`);
		console.error(`\nSkill invalid: ${problems.length} problem(s).`);
		process.exit(1);
	}

	console.log("✓ skill valid");
	process.exit(0);
}

// 仅在直接执行(不是 import)时跑 CLI。
// 跨平台:把 process.argv[1] 与 import.meta.url 都归一成 file:// URL 再比;
// 不依赖路径字符串匹配(Windows 盘符 / 大小写 / 正反斜杠都会让字符串比较失败)。
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
