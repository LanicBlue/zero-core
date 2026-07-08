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
import { isPathSafeId, appSkillDir } from "../server/skill-router.js";

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

// ─── Shell 命令 token 解析(sub-3,resource 段:脚本执行) ────────────────
//
// # 文件说明书(段)
//
// ## 核心功能
// 把 Shell 命令里的 `[skills]/<id>/<rel>` 虚拟路径 token + `${SKILL_DIR}` /
// `${CLAUDE_SKILL_DIR}` 自引用 token 解析成**真实磁盘路径**(要真跑,不是虚拟形态
// —— 与 Read 那边替换成 `[skills]/<id>` 不同,见 design「`${SKILL_DIR}` 替换」段
// + 决策 4)。
//
// ## 输入
// - 命令字符串(可能含 0..N 个 `[skills]/<id>/<rel>` token,0..N 个 `${SKILL_DIR}`)。
// - 可选 home(测试注入 tmp;生产 scanner 用 os.homedir())。
//
// ## 输出
// - `{ ok:true, command, skillDirs }` —— 全部 token 解析成功,命令里所有 skill
//   虚拟路径 / 自引用变量已替换成引号包裹的真实路径;`skillDirs` 是被解析到的
//   skill 的 baseDir 集合(供调用方注入 `SKILL_DIR` env)。
// - `{ ok:false, error }` —— 任一 `[skills]/` token 解析失败(skill 不存在 / `../`
//   越界)。整条命令拒(不部分替换,防半解析后执行意外路径)。
//
// ## 路径沙箱
// 复用 resolveSkillPath:`<rel>` resolve 后必须仍在该 skill baseDir 内,`../` 越
// 界 → `{ ok:false }`。`${SKILL_DIR}` 的 skillId 上下文来自同命令里已解析成功
// 的 `[skills]/<id>/` token(无 `[skills]/` 锚点 → 保留字面 `${SKILL_DIR}`,交
// shell 自行展开,不阻塞执行)。
//
// ## Windows 安全(F3)
// 解析出的真实路径在 win32 带反斜杠,直接塞进 bash 命令会被当转义;统一**正斜杠
// 化 + 双引号包裹**(`"C:/Users/.../x.py"`)。引号包裹同时防路径含空格/特殊字符
// 被当命令分隔符(命令注入防护,acceptance 用例 6)。
//
// ## 维护规则
// - 命令注入面:替换进命令的路径**必须**引号包裹,绝不裸插(防 `;rm -rf` 之类)。
// - 半解析拒:任一 token 失败整条命令拒(不部分替换),防 agent 看到混合形态。
// - token 识别用非贪婪正则 + 字符类限定(`<id>` 限 `[A-Za-z0-9._-]`,`<rel>` 限非
//   空白/非引号),避免误吞命令其他部分。
//
// ## 定位
// src/tools/skill-paths.ts —— 解析器家族;被 sub-3 Shell(bash.ts)复用。sub-8
// (Write/Edit)不复用本函数(那是写类,语义不同)。

/** Shell 命令 token 解析结果。 */
export type ShellTokenResolution =
	| { ok: true; command: string; skillDirs: string[] }
	| { ok: false; error: string };

/**
 * 把引号包裹 + 正斜杠化的真实路径"安全地"插回命令(Windows 反斜杠 + 注入防护)。
 *
 * win32 真实路径形如 `C:\Users\foo bar\x.py`,裸塞进 bash 命令:反斜杠被转义 +
 * 空格被当参数分隔。统一处理:正斜杠化 + 双引号包裹。
 *
 * posix 路径无反斜杠问题,但仍引号包裹(防空格/特殊字符,统一注入防护)。
 */
function quoteRealPath(realPath: string): string {
	const fwd = realPath.replace(/\\/g, "/");
	return `"${fwd}"`;
}

/**
 * 解析 Shell 命令里的 `[skills]/<id>/<rel>` 与 `${SKILL_DIR}` token → 真实路径。
 *
 * 见上文段头文件说明书。返回 `{ ok:false }` 时整条命令拒(不部分替换)。
 *
 * @param command 待解析的 shell 命令。
 * @param home    可选 home 目录;省略时 scanner 用 os.homedir()。仅测试注入。
 */
export function resolveSkillTokensInShellCommand(
	command: string,
	home?: string,
): ShellTokenResolution {
	if (typeof command !== "string" || command.length === 0) {
		return { ok: true, command: command ?? "", skillDirs: [] };
	}

	// 第一遍:扫 `[skills]/<id>/<rel>` token,逐个 resolveSkillPath。
	// token 形态:`[skills]/<id>/<rel>` —— **要求至少一个 `/<rel>` 段**(rel 非空),
	// 避免 `[skills]/foo`(裸 skill id、无 rel)被解析成 baseDir 后紧接命令分隔符
	// (`python [skills]/foo;a.py` → baseDir + `;a.py`,误执行注入面)。
	// `<id>` 限 path-safe 字符 `[A-Za-z0-9._-]`;`<rel>` 限非空白 / 非引号 / 非命令
	// 分隔符(`;&|<>$`)——避免吞到命令其他部分(命令注入防护,acceptance 用例6)。
	// 容错:已被双引号包裹的 token(`"[skills]/foo/x.py"`)也识别 —— strip 引号后解析。
	const skillDirs = new Set<string>();
	let resolved = command;
	const tokenRe = /"\[skills\]\/[A-Za-z0-9._-]+\/[^\s"|';&<>$]*"|\[skills\]\/[A-Za-z0-9._-]+\/[^\s"|';&<>$]*/g;
	let tokenError: string | null = null;

	resolved = resolved.replace(tokenRe, (raw) => {
		// strip 包裹引号(resolveSkillPath 内部也 strip,但显式 strip 让 token 边界清晰)。
		let tok = raw;
		if (tok.startsWith('"') && tok.endsWith('"')) tok = tok.slice(1, -1);
		const r = resolveSkillPath(tok, home);
		if (r === null) return raw; // 不该发生(正则已限定前缀),兜底原样
		if (!r.ok) {
			tokenError = r.error;
			return raw; // 占位,外层检测 tokenError 后整条拒
		}
		skillDirs.add(r.baseDir);
		return quoteRealPath(r.realPath);
	});

	if (tokenError) {
		return { ok: false, error: tokenError };
	}

	// 第二遍:`${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 自引用 token。
	// skillId 上下文:同命令里已解析到的 `[skills]/<id>/` token 的 baseDir。
	// - 有锚点 → 用第一个锚点的 baseDir 替换 `${SKILL_DIR}` 成真实路径。
	//   **整段 `${SKILL_DIR}/rest/of/path` 一起引号包裹**(不能只包 baseDir —— 否则
	//   `"...base"/rest` 的 `/rest` 裸露在引号外,反斜杠/空格仍会破坏命令)。
	//   多锚点歧义时取第一个(skill 自引用典型场景是单 skill 命令,多 skill 命令里
	//   `${SKILL_DIR}` 本就歧义,取第一个保守可用)。
	// - 无锚点 → 保留字面(交 shell 自行展开,不阻塞;符合"防御性 best-effort"语义)。
	if (/\$\{(?:CLAUDE_)?SKILL_DIR\}/.test(resolved) && skillDirs.size > 0) {
		const baseDir = [...skillDirs][0];
		const baseFwd = baseDir.replace(/\\/g, "/");
		// token 形态:`${SKILL_DIR}` 或 `${CLAUDE_SKILL_DIR}` 后跟可选 `/rest`(rest 限
		// 非空白/非引号/非命令分隔符,与第一遍 token rel 字符类一致 —— 防注入)。
		// 替换成 `"<baseFwd>[/rest]"`(整段引号包裹)。
		const expandVar = (varName: string) => {
			const re = new RegExp(
				`\\$\\{${varName}\\}(\\/[^\\s"|';&<>$]*)?`,
				"g",
			);
			return resolved.replace(re, (_m, rest: string | undefined) => {
				const full = rest ? `${baseFwd}${rest}` : baseFwd;
				return `"${full}"`;
			});
		};
		// 先替换长变量名(CLAUDE_SKILL_DIR),再替换短的 —— 两者正则互不包含,顺序仅
		// 为可读性(不互相吃)。
		resolved = expandVar("CLAUDE_SKILL_DIR");
		resolved = expandVar("SKILL_DIR");
	}

	return { ok: true, command: resolved, skillDirs: [...skillDirs] };
}

// ─── 写家族 `[skills]/` 适配(sub-8,决策 4 写 + 11)────────────────────────
//
// # 文件说明书(段)
//
// ## 核心功能
// 把 Write/Edit 的 `[skills]/<id>/<rel>` 虚拟路径解析成"可写的真实磁盘路径" +
// 标识"是否需要打 author 溯源标记"。**复用读家族解析器**(tryParseSkillPath +
// resolveSkillPath),区别在:
//   - 写**已存在** skill:resolveSkillPath 沙箱解析成功后,**额外判来源**(source
//     非 app → 拒,外部只读)。
//   - 写**新** skill(id 不存在):基目录 = appSkillDir(id)(`~/.zero-core/skills/<id>`),
//     校验 id path-safe + 重名(双重护栏,与 sub-6 同源)。
//
// ## 输入
// - virtualPath:`[skills]/<id>/<rel>` 虚拟路径(Write/Edit 的 path 参数)。
//
// ## 输出
// - `null` —— 入参不是 `[skills]/` 前缀(交回原写流程)。
// - `{ ok:false, error }` —— 是 skill 通道但解析失败:无权限场景 / 越界 / 外部只读 /
//   id 非法 / 重名。错误信息直接给 agent(返回权限错误,不落盘)。
// - `{ ok:true, realPath, markAuthor }` —— 解析成功。
//   - `markAuthor: true` = 这是**新** skill 或现有 app skill(agent 自建/编辑都打
//     frontmatter `author: agent:<id>` 溯源);调用方在写 SKILL.md 时按需补标记。
//
// ## 门禁(关键)
// **写门禁在调用方**(file-write/file-edit)查 callerCtx 关联 agent 的
// `skillPolicy.canAuthorSkills`。本函数**不做**门禁判定(它只做"路径/来源/id"静态
// 解析)。理由:门禁要拿当前 agent → 走 getAgentService() 单例,这是 host 注入语义
// 决策,与纯路径解析解耦。但本函数对**所有 `[skills]/` 写**都参与解析,调用方先查
// 门禁 flag = false 直接拒(不进本函数),确保无权限 agent 写 `[skills]/` 一定被拒。
//
// ## 维护规则
// - 外部来源只读:写已存在 skill 时判 `skill.source !== "app"` → 拒(对齐决策 8)。
// - 新 skill id 护栏:isPathSafeId + scanner 现有 id 查重(对齐 sub-6)。
// - 沙箱:复用 resolveSkillPath 的 `../` 越界拦截(已存在 skill 路径)。

/** 写家族 `[skills]/` 解析结果。 */
export type WriteSkillPathResolved =
	| { ok: true; realPath: string; markAuthor: boolean }
	| { ok: false; error: string };

/**
 * 解析 Write/Edit 的 `[skills]/<id>/<rel>` 写路径。
 *
 * 见上文段头文件说明书。返回 `null` = 非 `[skills]/` 前缀(交回原写流程)。
 * 失败(`{ ok:false }`)的 error 信息直接返回给 agent(权限错误,不落盘)。
 *
 * @param home 可选 home 目录;省略时 scanner 用 os.homedir()。仅测试注入。
 */
export function resolveSkillWritePath(
	virtualPath: string,
	home?: string,
): WriteSkillPathResolved | null {
	const parsed = tryParseSkillPath(virtualPath);
	if (!parsed) return null; // 非 skill 通道,交回原写流程。

	const { skillId, rel } = parsed;

	// id 含 glob 通配字符 → 跨 skill 意图,拒(与读家族 resolveSkillPath 一致)。
	if (/[*?\[\]{}]/.test(skillId)) {
		return { ok: false, error: "cross-skill access is not supported; name a single skill as [skills]/<id>/..." };
	}

	const existing = resolveSkillByName(skillId, home);

	if (existing) {
		// 已存在 skill:来源必须是 app(外部只读,决策 8)。
		if (existing.source !== "app") {
			return {
				ok: false,
				error: `Skill '${skillId}' is read-only (external source: ${existing.source}); only skills under ~/.zero-core/skills/ are writable.`,
			};
		}
		// 沙箱解析(复用读家族)。rel 越界 → ok:false。
		// 注意:resolveSkillPath 内部已 normalize + 沙箱判 baseDir 前缀,这里直接用它。
		const r = resolveSkillPath(virtualPath, home);
		// r === null 不该发生(前缀已识别);!r.ok = 越界/skill 不存在(已查存在,只剩越界)。
		if (!r || !r.ok) {
			return { ok: false, error: r && !r.ok ? r.error : `Cannot resolve ${virtualPath}` };
		}
		// 已存在 app skill 写:agent 编辑也打 author 溯源(markAuthor=true)。
		return { ok: true, realPath: r.realPath, markAuthor: true };
	}

	// 新 skill:id 护栏(path-safe + 长度)。
	if (!isPathSafeId(skillId)) {
		return {
			ok: false,
			error: `Invalid skill id '${skillId}': id must be path-safe (letters, digits, '.', '_', '-', 1-64 chars), no spaces or path separators.`,
		};
	}
	// 重名已查(scanner resolveSkillByName 返 undefined = 无现有);isPathSafeId 是第二道。

	// 新 skill 基目录 = appSkillDir(id)。rel 沙箱:resolve 后必须在 baseDir 内。
	const base = normalize(appSkillDir(skillId));
	const real = normalize(resolve(base, rel));
	if (!isInsideBaseDir(real, base)) {
		return {
			ok: false,
			error: `Access denied: path outside skill directory (${virtualPath})`,
		};
	}
	// 新 skill 一律打 author 溯源标记。
	return { ok: true, realPath: real, markAuthor: true };
}

/**
 * 给 SKILL.md 内容打 `author: agent:<agentId>` frontmatter 溯源标记。
 *
 * agent 自建/编辑 skill 时调用。行为:
 * - 内容无 frontmatter(不以 `---\n` 开头)→ 在最前插一个 `---\nname: <id>\ndescription: ''\nauthor: agent:<id>\n---\n\n`。
 * - 内容有 frontmatter 且无 author 行 → 在 frontmatter 内追加 `author: agent:<id>` 行。
 * - 内容已有 author 行 → 不动(尊重 agent 自填;agent 想表达"我创建"可自填,框架不覆盖)。
 *
 * 只处理 SKILL.md 文件名(调用方负责判断);非 SKILL.md 不调本函数。
 */
export function stampAuthorFrontmatter(content: string, agentId: string): string {
	const authorLine = `author: agent:${agentId}`;
	// 已有 author 行(frontmatter 内)→ 不覆盖,尊重 agent 自填。
	if (/^---\r?\n[\s\S]*?^author:\s.*$\r?\n[\s\S]*?^---\s*$/m.test(content)) {
		return content;
	}
	// 简化判定:frontmatter 内出现 `author:`(任意位置)→ 不覆盖。
	if (/^---\r?\n[\s\S]*?^---\s*$/m.test(content) && /^author:/m.test(content)) {
		return content;
	}

	// 有 frontmatter 但无 author → 插入 author 行(frontmatter 末行 `---` 之前)。
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/);
	if (fmMatch) {
		const fmBody = fmMatch[1];
		const after = content.slice(fmMatch[0].length);
		// 在 frontmatter body 末尾追加 author 行(确保 body 末尾无多余换行)。
		const newFmBody = fmBody.endsWith("\n") ? fmBody + authorLine : fmBody + "\n" + authorLine;
		return `---\n${newFmBody}\n---\n` + after;
	}

	// 无 frontmatter → 造最小 frontmatter(name 缺失时给占位;真实 name 应由 agent 提供)。
	return `---\nauthor: agent:${agentId}\n---\n\n` + content;
}
