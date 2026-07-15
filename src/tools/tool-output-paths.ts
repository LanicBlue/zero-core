// `[tool-outputs]/` 虚拟路径通道解析器(sub-5)
//
// # 文件说明书
//
// ## 核心功能
// 把 agent 看到的虚拟路径 `[tool-outputs]/<rel>` 解析成真实磁盘路径
// (`join(ZERO_CORE_DIR, "tool-outputs", rel)`),并保证解析结果仍落在 tool-outputs
// 目录内(路径沙箱)。镜像 [skill-paths.ts](./skill-paths.ts) 的 `[skills]/` 模式
// (sub-2):Read 工具识别 `[tool-outputs]/` 前缀 → 本解析器 → 真实路径。
//
// ## 由来
// sub-2 外部化把超阈值 tool result 写到 `<ZERO_CORE_DIR>/tool-outputs/<sha256>.txt`,
// 早期指针串嵌的是 `.zero-core/tool-outputs/<hash>.txt`(相对 ZERO_CORE_DIR≈homedir)。
// agent 把它误读为 workspace 相对路径,找不到文件(实在 dataDir)。sub-5 改用虚拟
// 前缀 `[tool-outputs]/<hash>.txt`,agent 一看就知道是虚拟通道,不与 workspace 路径
// 混淆;绝对真实路径不泄露(home 不暴露给 agent)。
//
// ## 输入
// - 虚拟路径字符串(以 `[tool-outputs]/` 开头)。
//
// ## 输出
// - tryParseToolOutputPath → { rest } | null(非 `[tool-outputs]/` 前缀)。
// - resolveToolOutputPath → { ok, realPath, baseDir } | { ok:false, error } | null。
//   - `null` = 入参不是 `[tool-outputs]/` 通道(交回原 readScope / 真实路径流程)。
//   - `{ ok:false, error }` = 是 `[tool-outputs]/` 通道但路径越界(`../` 逃逸)。
//   - `{ ok:true, realPath, baseDir }` = 解析成功。
//
// ## 定位
// src/tools/ —— 中立工具层共用 helper,与 skill-paths.ts 平行;被 Read 复用。
//
// ## 依赖
// - node:path(resolve/normalize/sep)
// - ../core/config.js (ZERO_CORE_DIR)
//
// ## 维护规则
// - 路径沙箱是关键护栏:resolve 后必须仍在 tool-outputs baseDir 前缀内;`../` 越界
//   (如 `[tool-outputs]/../../etc/passwd`)→ `{ ok:false, error }`。守卫只挡字面 `../`
//   越界;symlink 逃逸不在本 sub 范围(由 OS 层 + 后续沙盒 issue 处理)。
// - TOOL_OUTPUTS_VIRTUAL_PREFIX 常量被 tool-result-externalizer.ts 复用(指针串产出),
//   改前缀必须同步改 externalizer + 旧格式向后兼容解析。
// - TOOL_OUTPUTS_SUBDIR 与 tool-result-externalizer.ts 的常量保持同名同值(子目录名)。

import { resolve, normalize, sep } from "node:path";
import { ZERO_CORE_DIR } from "../core/config.js";

/** 虚拟路径前缀。Read 用它做"是否走 tool-outputs 通道"判断;externalizer 用它产指针串。 */
export const TOOL_OUTPUTS_VIRTUAL_PREFIX = "[tool-outputs]/";

/** 外置文件子目录名(相对 ZERO_CORE_DIR)。与 tool-result-externalizer.ts 的同名常量一致。 */
const TOOL_OUTPUTS_SUBDIR = "tool-outputs";

/**
 * 轻量前缀判定:入参是否以 `[tool-outputs]/`(或 win32 `[tool-outputs]\`)起头。
 *
 * 仅供调用方做"是否进入 tool-outputs 通道分支"的早判;真正解析用 tryParseToolOutputPath /
 * resolveToolOutputPath。
 */
export function isToolOutputVirtualPath(p: string): boolean {
	if (typeof p !== "string") return false;
	const norm = p.replace(/\\/g, "/");
	return norm.startsWith(TOOL_OUTPUTS_VIRTUAL_PREFIX);
}

/** 解析 `[tool-outputs]/` 通道出错的统一返回形态。 */
export type ToolOutputPathError = { ok: false; error: string };

/** 解析成功的形态:真实路径 + baseDir(回映射/调试用)。 */
export type ToolOutputPathResolved = {
	ok: true;
	/** 真实磁盘绝对路径(已 resolve + normalize)。 */
	realPath: string;
	/** tool-outputs 真实 baseDir(`join(ZERO_CORE_DIR, "tool-outputs")` 已 normalize)。 */
	baseDir: string;
};

/**
 * 识别 `[tool-outputs]/<rel>` 前缀,拆出 `<rel>`。
 *
 * 返回 `null` 表示入参不是 `[tool-outputs]/` 通道(交回原流程)。
 * 裸 `[tool-outputs]/`(无 rel)→ null(由调用方决定拒/不支持)。
 *
 * 这里**不做沙箱**(只字符串拆分);沙箱由 resolveToolOutputPath 负责。
 */
export function tryParseToolOutputPath(virtualPath: string): { rest: string } | null {
	if (typeof virtualPath !== "string") return null;
	// 容错:strip 包裹引号(与 file-read.ts resolvePath / skill-paths.ts 一致行为)。
	let p = virtualPath.trim();
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		p = p.slice(1, -1);
	}
	// 兼容 win32 反斜杠写法:`[tool-outputs]\foo\bar`。
	const norm = p.replace(/\\/g, "/");
	if (!norm.startsWith(TOOL_OUTPUTS_VIRTUAL_PREFIX)) return null;

	const rest = norm.slice(TOOL_OUTPUTS_VIRTUAL_PREFIX.length);
	if (!rest) return null; // 裸 `[tool-outputs]/`

	return { rest };
}

/**
 * 解析 `[tool-outputs]/<rel>` 虚拟路径 → 真实磁盘路径。
 *
 * 返回:
 * - `null` —— 入参不以 `[tool-outputs]/` 开头(交回原 readScope / 真实路径流程)。
 * - `{ ok:false, error }` —— 是 `[tool-outputs]/` 通道但路径越界。
 * - `{ ok:true, realPath, baseDir }` —— 解析成功。
 *
 * **路径沙箱**:`<rel>` 经 `resolve(baseDir, rel)` + `normalize` 后必须仍在 baseDir
 * 前缀内;`../` 越界(如 `[tool-outputs]/../../etc/passwd`)→ `{ ok:false, error }`。
 *
 * 沙箱语义对齐 skill-paths.ts 的 isInsideBaseDir:normalize 后比 `real === base`
 * 或 `real` 以 `<base><sep>` 起头;不依赖 realpath(同 sub-2 范围约定)。
 */
export function resolveToolOutputPath(
	virtualPath: string,
): ToolOutputPathResolved | ToolOutputPathError | null {
	const parsed = tryParseToolOutputPath(virtualPath);
	if (!parsed) return null; // 非 `[tool-outputs]/` 通道,交回原流程。

	const base = normalize(resolve(ZERO_CORE_DIR, TOOL_OUTPUTS_SUBDIR));
	const real = normalize(resolve(base, parsed.rest));

	if (!isInsideBaseDir(real, base)) {
		return {
			ok: false,
			error: `Access denied: path outside tool-outputs directory (${virtualPath})`,
		};
	}

	return { ok: true, realPath: real, baseDir: base };
}

/**
 * 判断 `real` 是否在 `base` 前缀内(base 本身或其子路径)。
 *
 * 与 skill-paths.ts 的 isInsideBaseDir 同语义(私有 helper,平台无关:normalize 后
 * 比 `<base>` 等值 或 `<base><sep>` 起头)。
 */
function isInsideBaseDir(real: string, base: string): boolean {
	if (real === base) return true;
	// 跨平台:用 normalize 出来的分隔符(sep)拼接。win32 sep="\",posix sep="/"。
	return real.startsWith(base + sep);
}
