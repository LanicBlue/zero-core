// Tool result externalization (steps-overhaul sub-2 / 阶段1)
//
// # 文件说明书
//
// ## 核心功能
// 当一条 tool result 体积超过阈值(默认 16K bytes)时,把完整字节落到
// `~/.zero-core/tool-outputs/<sha256>.txt` 外置文件,并返回一个**自描述指针串**
// 给调用方(TurnRecorder),让 `steps` 表只存指针 + 摘要,永不存原始大字节。
//
// ## 阈值
// TOOL_RESULT_EXTERNALIZE_THRESHOLD = 16384 bytes(16 KiB)。design 阶段1 已定。
// 超过即外置;≤ 阈值原样返回(不外置、不指针化)。无差别按体积外置——按 tool
// 类型的策略("昂贵/不可重跑的保留")留成 TODO/配置点,本 sub 不实现。
//
// ## 外置文件
// - 位置:`<ZERO_CORE_DIR>/tool-outputs/<sha256>.txt`(与 `~/.zero-core/archives/`、
//   `~/.zero-core/wiki/` 同根,见 core/config.ts 的 ZERO_CORE_DIR)。
// - 命名:内容 sha256(十六进制,64 字符)+ `.txt` 扩展名。内容相同 → hash 相同 →
//   同一文件不重复写(幂等,跨 session/跨 turn 稳定)。
// - 编码:UTF-8 文本。result 标准化为字符串(string 原样;对象/其他 JSON.stringify)。
// - 扩展名:统一 `.txt`(内容已标准化为字符串;按 tool 类型挑扩展名属"按 tool 类型
//   策略",留给后续 sub/配置点)。
//
// ## 指针格式(steps.content 里 tool 块的 `result` 字段)
// 外置后 `result` 放一个**自描述指针串**,格式固定:
//
//     [externalized: <REL_PATH> (<N> bytes)] <SUMMARY>
//
// - `<REL_PATH>`:相对 ZERO_CORE_DIR 的路径,如 `.zero-core/tool-outputs/<hash>.txt`。
//   带 `.zero-core/` 前缀 → agent/人一眼看出根;绝对路径在 `os.homedir()` 因机器而异,
//   相对路径稳定可移植。完整绝对路径 = join(ZERO_CORE_DIR, "tool-outputs", "<hash>.txt")。
// - `<N>`:原始字节数(整数),供体积感知/调试。
// - `<SUMMARY>`:一句话摘要(见 makeSummary),默认 result 头部若干字符 + `…(truncated)`。
//
// 设计要点:① 自描述(前缀 `[externalized:` 一看就知道是指针不是真结果)② 含路径
// ③ 含摘要 ④ 后续 sub-3 fresh tail 渲染、按需寻回能解析(正则提取 REL_PATH → 拼
// 绝对路径 → 读回完整字节)。
//
// ## 不变量(steps-overhaul design 阶段1)
// - 完整字节**只在 externalizeToolResult 那一刻落盘**外置文件;steps 永远存指针;
//   无原始字节窗口(第一次进 recorder 就是指针)。
// - 不依赖 hook 顺序 / PostToolUse modifiedResult 传播(modifiedResult 是返回值,
//   到不了持久化 handler turn-hooks,它读 ctx.result 原始先跑 → 破不变量)。
// - cache-safe:完整版从没进过 cache(steps 存指针,messages 不存 step 内容)。
//
// ## 定位
// src/runtime/ — 被 TurnRecorder.updateToolResult 这个唯一 choke point 调用。
//
// ## 依赖
// node:crypto (sha256)、node:fs (写文件)、node:path、core/config.ts (ZERO_CORE_DIR)
//
// ## 维护规则
// - 阈值/摘要长度若调,同步改本文件常量 + sub-2 测试 + design.md 阈值表。
// - 指针格式若改,必须能被既有 steps 行(已落盘的指针)兼容解析,否则需迁移。
//

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "../core/config.js";

/** 体积阈值(字节)。超过即外置。design 阶段1 已定 16K。 */
export const TOOL_RESULT_EXTERNALIZE_THRESHOLD = 16 * 1024;

/** 摘要最大字符数(指针串里 SUMMARY 段的长度上限)。 */
const SUMMARY_MAX_CHARS = 240;

/** 外置文件子目录名(相对 ZERO_CORE_DIR)。 */
const TOOL_OUTPUTS_SUBDIR = "tool-outputs";

/**
 * 把任意 result 标准化为字符串 + 其 UTF-8 字节长度。
 * - string 原样。
 * - 其他类型 JSON.stringify(与 transcript-delta.ts / session.ts 既有的 result 序列化
 *   口径一致,保证字节数与后续 rebuild 看到的字符串一致)。
 */
function normalizeResult(result: unknown): { text: string; bytes: number } {
	const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
	// UTF-8 字节长度(Buffer.byteLength 默认 utf8)。比 .length(UTF-16 码元数)更贴近
	// 真实体积,且对含多字节字符的中文/emoji 结果判断更准。
	const bytes = Buffer.byteLength(text, "utf8");
	return { text, bytes };
}

/**
 * 由内容生成稳定文件名(`<sha256>.txt`)。相同结果 → 相同 hash → 同一文件,幂等。
 */
function hashFilename(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex") + ".txt";
}

/**
 * 生成一句话摘要:取 result 头部若干字符,超长则截断 + 标记。单行化(换行→空格),
 * 避免指针串里混入换行让 steps.content JSON 难读。
 */
function makeSummary(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= SUMMARY_MAX_CHARS) return oneLine;
	return oneLine.slice(0, SUMMARY_MAX_CHARS) + "…(truncated)";
}

/**
 * 外置文件的绝对路径(`<ZERO_CORE_DIR>/tool-outputs/<hash>.txt`)。
 */
function externalFilePath(filename: string): string {
	return join(ZERO_CORE_DIR, TOOL_OUTPUTS_SUBDIR, filename);
}

/**
 * 指针串里嵌的相对路径,带 `.zero-core/` 前缀(自描述根)。
 * ZERO_CORE_DIR 末段按约定就是 `.zero-core`(或用户自定义的 ZERO_CORE_DIR env)。
 */
function relPathForPointer(filename: string): string {
	// 取 ZERO_CORE_DIR 的basename 作为前缀,使指针自描述根目录(默认 `.zero-core`)。
	// 不假设 ZERO_CORE_DIR 一定是 `.zero-core`(用户可经 env 改),故取 basename。
	const rootBasename = ZERO_CORE_DIR.split(/[\\/]/).filter(Boolean).pop() ?? ".zero-core";
	return `${rootBasename}/${TOOL_OUTPUTS_SUBDIR}/${filename}`;
}

/**
 * 指针串解析:从 `[externalized: <REL_PATH> (<N> bytes)] ...` 提取 REL_PATH。
 * 供后续 sub-3 fresh tail 渲染 / 按需寻回用。当前 sub 不消费(只产出),但导出以固契约。
 * 返回 null 表示不是指针串(原样 result)。
 */
export function parseExternalizedPointer(resultString: string): { relPath: string; bytes: number; summary: string } | null {
	if (typeof resultString !== "string") return null;
	const m = resultString.match(/^\[externalized:\s+(.+?)\s+\((\d+)\s+bytes\)\]\s?([\s\S]*)$/);
	if (!m) return null;
	return { relPath: m[1], bytes: Number(m[2]), summary: m[3] ?? "" };
}

/**
 * 由 REL_PATH(指针串里的)还原绝对路径。join(ZERO_CORE_DIR,去掉前缀 basename 后的剩余)。
 */
export function resolvePointerRelPath(relPath: string): string {
	// relPath 形如 `.zero-core/tool-outputs/<hash>.txt`;去掉首段 basename 后拼到 ZERO_CORE_DIR。
	const segs = relPath.split(/[\\/]/).filter(Boolean);
	if (segs.length <= 1) return join(ZERO_CORE_DIR, relPath);
	// 去掉首段(它是 ZERO_CORE_DIR 的 basename,仅作自描述),其余接到 ZERO_CORE_DIR 下。
	return join(ZERO_CORE_DIR, ...segs.slice(1));
}

/**
 * 阶段1 choke point:判断 result 体积,>阈值则外置 + 返回指针串;否则返回 null(不外置)。
 *
 * 调用方(TurnRecorder.updateToolResult)据此决定:
 * - 返回非 null → tool 块的 `result` 字段放指针串。
 * - 返回 null → result 原样存(≤阈值,未外置)。
 *
 * 幂等:相同内容 → 相同 hash → 同一文件,不重复写(写前 existsSync 短路)。
 * 失败容忍:外置写失败时**回退为不外置**(返回 null),让 result 原样进 steps——
 * 避免因外置写盘失败把整条 tool 链路打断。失败记一条 warn 即可(本 sub 不引日志依赖,
 * 静默回退;调用方拿不到指针就用原始 result,体积破不变量但功能不挂)。
 */
export function maybeExternalizeToolResult(result: unknown): string | null {
	const { text, bytes } = normalizeResult(result);
	if (bytes <= TOOL_RESULT_EXTERNALIZE_THRESHOLD) return null;

	const filename = hashFilename(text);
	const absPath = externalFilePath(filename);
	try {
		if (!existsSync(absPath)) {
			mkdirSync(join(ZERO_CORE_DIR, TOOL_OUTPUTS_SUBDIR), { recursive: true });
			writeFileSync(absPath, text, "utf8");
		}
	} catch {
		// 外置写失败 → 回退为不外置(见上)。完整字节进 steps,体积破不变量但功能不挂。
		return null;
	}

	const relPath = relPathForPointer(filename);
	const summary = makeSummary(text);
	// 指针串格式(见文件头注释):
	//   [externalized: <REL_PATH> (<N> bytes)] <SUMMARY>
	return `[externalized: ${relPath} (${bytes} bytes)] ${summary}`;
}
