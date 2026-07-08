// `[skills]/` 虚拟路径通道解析器(sub-2)
//
// # 文件说明书
//
// ## 核心功能
// 把 agent 看到的虚拟路径 `[skills]/<id>/<rel>` 解析成真实磁盘路径,并保证解析
// 结果仍落在该 skill 的 baseDir 内(路径沙箱)。是 progressive disclosure selection
// 段的核心 helper:Read/Glob/Grep 都经它识别 `[skills]/` 前缀 → 真实路径。
//
// ## 输入
// - 虚拟路径字符串(以 `[skills]/` 开头)。
// - 可选 home 目录(测试注入 tmp;生产不传 → os.homedir())。
//
// ## 输出
// - tryParseSkillPath → { skillId, rel } | null(非 `[skills]/` 前缀)。
// - resolveSkillPath → { ok, realPath, skillId, baseDir } | { ok:false, error } | null。
// - mapRealToVirtual → 真实路径在 baseDir 下时回映射成 `[skills]/<id>/...`,否则原样返回。
//
// ## 定位
// src/tools/ —— 中立工具层共用 helper,被 Read/Glob/Grep 复用;sub-3(Shell)/ sub-8
// (Write/Edit) 同样复用本解析器,接口稳定不为本 sub 改。
//
// ## 依赖
// - node:path(resolve/normalize/relative)
// - ../server/skill-scanner.js(resolveSkillByName)
//
// ## 维护规则
// - 路径沙箱是关键护栏:resolve 后必须仍在 baseDir 前缀内;裸 `[skills]/` 不指名
//   skill 的访问由调用方(Read/Glob/Grep)在前缀判断时拦截,本解析器只负责"指名
//   了 skill"后的解析 + 沙箱。
// - 回映射必须保证一条真实路径都不漏:Glob/Grep 的结果路径在返给 agent 前都要过
//   mapRealToVirtual。
// - 单测覆盖:前缀识别 / 越界 / 不存在 / 回映射无泄露(见 tests/unit/skill-paths.test.ts)。
//

import { resolve, normalize, relative, sep } from "node:path";
import { resolveSkillByName } from "../server/skill-scanner.js";

/** 虚拟路径前缀。Read/Glob/Grep 都用它做"是否走 skill 通道"判断。 */
export const SKILL_VIRTUAL_PREFIX = "[skills]/";

/**
 * 轻量前缀判定:入参是否以 `[skills]/`(或 win32 `[skills]\`)起头。
 *
 * 仅供调用方做"是否进入 skill 通道分支"的早判;真正解析用 tryParseSkillPath /
 * resolveSkillPath。裸 `[skills]/`(不指名 skill)本函数返 true,调用方据此拒
 * (单 skill 限定)。
 */
export function isSkillVirtualPath(p: string): boolean {
	if (typeof p !== "string") return false;
	const norm = p.replace(/\\/g, "/");
	return norm.startsWith(SKILL_VIRTUAL_PREFIX);
}

/** 解析 `[skills]/` 通道出错的统一返回形态。 */
export type SkillPathError = { ok: false; error: string };

/** 解析成功的形态:真实路径 + 回映射所需的 skillId/baseDir。 */
export type SkillPathResolved = {
	ok: true;
	/** 真实磁盘绝对路径(已 resolve + normalize)。 */
	realPath: string;
	/** skill id(目录名,回映射 key)。 */
	skillId: string;
	/** skill 真实 baseDir(回映射前缀)。 */
	baseDir: string;
};

/**
 * 解析 `[skills]/<id>/<rel>` 虚拟路径。
 *
 * 返回:
 * - `null` —— 入参不以 `[skills]/` 开头(交回原 readScope / 真实路径流程)。
 * - `{ ok:false, error }` —— 是 `[skills]/` 通道但解析失败(skill 不存在 / 路径越界)。
 * - `{ ok:true, realPath, skillId, baseDir }` —— 解析成功。
 *
 * **路径沙箱**:`<rel>` 经 `resolve(baseDir, rel)` + `normalize` 后必须仍在 baseDir
 * 前缀内;`../` 越界(如 `[skills]/a/../../etc/passwd`)→ `{ ok:false, error }`。
 *
 * @param home 可选 home 目录;省略时 scanner 用 os.homedir()。仅测试注入 tmp。
 */
export function resolveSkillPath(
	virtualPath: string,
	home?: string,
): SkillPathResolved | SkillPathError | null {
	// null = 不是 skill 通道,交回原流程。
	const parsed = tryParseSkillPath(virtualPath);
	if (!parsed) return null;

	// skillId 含 glob 通配字符 → 跨 skill 意图,拒(单 skill 边界,与 Glob/Grep 一致)。
	if (/[*?\[\]{}]/.test(parsed.skillId)) {
		return { ok: false, error: `cross-skill access is not supported; name a single skill as [skills]/<id>/...` };
	}

	const skill = resolveSkillByName(parsed.skillId, home);
	if (!skill) {
		return { ok: false, error: `skill not found: ${parsed.skillId}` };
	}

	// 沙箱:resolve 后比对 baseDir 前缀。normalize 后比对避免 `..`/`.` 干扰。
	// 注意 baseDir 本身已经 absolute + normalized(scanner 里 resolve 过),
	// 这里仍 normalize 一道保证形态一致(尤其 win32 反斜杠)。
	const base = normalize(skill.baseDir);
	const real = normalize(resolve(base, parsed.rel));

	// 在 baseDir 前缀内 = real === base 或 real 以 `<base>/`(或 win32 `<base>\`)起头。
	if (!isInsideBaseDir(real, base)) {
		return {
			ok: false,
			error: `Access denied: path outside skill directory (${virtualPath})`,
		};
	}

	return { ok: true, realPath: real, skillId: parsed.skillId, baseDir: base };
}

/**
 * 识别 `[skills]/<id>/<rel>` 前缀,拆出 `<id>` 与 `<rel>`。
 *
 * 返回 `null` 表示入参不是 `[skills]/` 通道(交回原流程)。
 * 裸 `[skills]/`(不指名 skill)→ null(由调用方决定拒/不支持)。
 *
 * 注意:这里**不查 skill 是否存在**(只做字符串拆分);存在性由 resolveSkillPath 负责。
 * 这让 Glob/Grep 可以在"前缀识别"和"解析 + 沙箱"两步之间插入单 skill 限定判断。
 */
export function tryParseSkillPath(virtualPath: string): { skillId: string; rel: string } | null {
	if (typeof virtualPath !== "string") return null;
	// 容错:strip 包裹引号(与 file-read.ts resolvePath 一致行为)。
	let p = virtualPath.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	// 兼容 win32 反斜杠写法:`[skills]\foo\bar`。
	const norm = p.replace(/\\/g, "/");
	if (!norm.startsWith(SKILL_VIRTUAL_PREFIX)) return null;

	const rest = norm.slice(SKILL_VIRTUAL_PREFIX.length);
	if (!rest) return null; // 裸 `[skills]/`

	// 第一个 `/` 切分 skillId / rel。无 `/`(只有 `[skills]/foo`)→ rel = ""。
	const slashIdx = rest.indexOf("/");
	if (slashIdx === -1) {
		return { skillId: rest, rel: "" };
	}
	const skillId = rest.slice(0, slashIdx);
	const rel = rest.slice(slashIdx + 1);
	if (!skillId) return null; // `[skills]//...` 异形
	return { skillId, rel };
}

/**
 * 真实路径 → 虚拟路径回映射(Glob/Grep 结果防泄露核心)。
 *
 * 真实路径落在 `baseDir/` 下 → 替换成 `[skills]/<skillId>/...`;不在 baseDir 下
 * (理论不该发生,因 searchPath 已限 baseDir)→ 原样返回(保留可观测性,不吞错)。
 *
 * 路径分隔符统一成正斜杠输出(虚拟路径用 `/`),与 tryParseSkillPath 的 norm 一致。
 */
export function mapRealToVirtual(realPath: string, skillId: string, baseDir: string): string {
	const base = normalize(baseDir);
	const real = normalize(realPath);
	if (!isInsideBaseDir(real, base)) return realPath; // 不在 skill 内,原样返回

	const rel = relative(base, real).replace(/\\/g, "/");
	// rel === "" 表示路径就是 baseDir 本身(如 Glob 命中 skill 根)。
	return rel ? `${SKILL_VIRTUAL_PREFIX}${skillId}/${rel}` : `${SKILL_VIRTUAL_PREFIX}${skillId}`;
}

/**
 * 判断 `real` 是否在 `base` 前缀内(base 本身或其子路径)。
 *
 * 平台无关:normalize 后比 `<base>` 等值 或 `<base><sep>` 起头。
 * 不依赖 realpath(软链接逃逸在 sub-2 范围内不做 realpath 解析 —— 守卫层只挡 `../` 字面越界;
 * 真正的 symlink 逃逸由操作系统层 + 后续沙盒 issue 处理,见 design 安全段)。
 */
function isInsideBaseDir(real: string, base: string): boolean {
	if (real === base) return true;
	// 跨平台:用 normalize 出来的分隔符(sep)拼接。win32 sep="\",posix sep="/"。
	return real.startsWith(base + sep);
}

/**
 * 真实路径是否落在 skill baseDir 内(沙箱判定,导出供 Glob/Grep 结果白名单过滤)。
 *
 * Glob/Grep 在 skill 通道下,即便 glob/ripgrep 因 pattern 含 `..` 等跑出 baseDir,
 * 用本函数做最终白名单过滤即可保证一条越界结果都不返(沙箱的兜底)。
 */
export function isPathInSkillBase(realPath: string, baseDir: string): boolean {
	return isInsideBaseDir(normalize(realPath), normalize(baseDir));
}

/**
 * Grep 结果回映射:把输出文本里的 skill 内真实路径(rel 形态)重写成虚拟形态。
 *
 * Grep 在 skill 通道下,searchPath = baseDir,nativeGrepSearch / rg 输出 path 段
 * 相对 baseDir(rel)。本函数逐行识别行首 path 段并加 `[skills]/<id>/` 前缀。
 * 支持四种输出格式(对齐 grep.ts 的 nativeGrepSearch):
 * - content 单行:`rel:ln:content`
 * - content context: `rel-ln-content`
 * - files_with_matches: `rel`
 * - count: `rel:N`
 *
 * 无匹配行(`No matches found.`、`... (truncated...)`、空行)原样返回。
 *
 * path 段提取:`:` 分隔(content/count)或 `-<digit>` 分隔(context)。rel 本身含 `-`
 * 时(`my-skill/f.md`),context 模式 `-<digit>` 判定保证不在 rel 内部误切。
 */
export function remapGrepOutputLines(text: string, skillId: string): string {
	if (!text) return text;
	const prefix = `${SKILL_VIRTUAL_PREFIX}${skillId}/`;
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		out.push(remapGrepLine(line, prefix));
	}
	return out.join("\n");
}

// 单行回映射:识别行首 path 段并加虚拟前缀。无 path 段(空行/已知元信息)原样返回。
function remapGrepLine(line: string, prefix: string): string {
	if (!line) return line;
	// 已知非匹配行原样返回。
	if (line === "No matches found.") return line;
	if (line.startsWith("... ") || line.startsWith("Invalid regex")) return line;
	// path 段 = 行首到第一个 `:` 或 `-<digit>`。
	// 优先 `:`(content/count/files_with_matches 都用 `:` 或无分隔);
	// context 用 `-<digit>`,正则 `-?\d` 避免误切 rel 内 `-`。
	const m = line.match(/^([^\n:]*?)(?::|-\d)/);
	if (!m) {
		// 无 `:` 也无 `-<digit>`:整行可能是纯 path(files_with_matches)或纯文本。
		// files_with_matches 整行就是 rel(无空格、有 .);含空格或不像 path 的原样返回。
		// 简化:有 `.` 或 `/` 当 path,否则原样。
		if (line.includes(".") || line.includes("/")) {
			return prefix + line;
		}
		return line;
	}
	const pathSeg = m[1];
	if (!pathSeg) return line; // 行首就是 `:` 异形
	return prefix + line;
}

/**
 * 读 skill md 内容时把自引用变量替换成虚拟路径(可移植自引用)。
 *
 * 协议(Claude 生态)用 `${CLAUDE_SKILL_DIR}/reference.md`;我们通用形式用 `${SKILL_DIR}`。
 * 两者都替换成 `[skills]/<skillId>`,这样 agent 看到的全是具体虚拟路径,可直接寻址。
 *
 * 只在读 **skill md 正文**时调用;非 md / 真实路径文件不做替换。
 */
export function replaceSkillDirVars(content: string, skillId: string): string {
	const replacement = `${SKILL_VIRTUAL_PREFIX}${skillId}`;
	// 顺序无要求(两变量名互不包含),但先把长变量名替换避免短前缀吃掉长名 ——
	// ${SKILL_DIR} 不是 ${CLAUDE_SKILL_DIR} 的前缀,正则互不干扰,直接两次替换。
	return content
		.replace(/\$\{CLAUDE_SKILL_DIR\}/g, replacement)
		.replace(/\$\{SKILL_DIR\}/g, replacement);
}
