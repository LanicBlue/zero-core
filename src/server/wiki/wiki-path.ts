// Wiki canonical path 单一权威实现（wiki-system-redesign plan-01 §3 / design.md §4.2）
//
// # 文件说明书
//
// ## 核心功能
// Wiki 规范路径的**唯一**字符串处理实现。repository / service / tool 不得
// 各自拼字符串 —— 必须通过本模块（acceptance-01 §B「canonical path 逻辑只有
// 一个权威实现」）。
//
// ## 路径模型（design.md §4.2）
//   - 根路径唯一为 `wiki-root`。
//   - 分隔符统一 `/`;不接受 `\`、`.` 或 `..` 段。
//   - 去除重复 `/` 和末尾 `/`。
//   - 路径段不得为空,并执行长度 + 非法字符校验。
//   - 数据库存储规范路径;Agent 输入的逻辑地址(memory:// / project://)只在
//     调用边界由 resolver 解析（plan-02）。
//
// ## Edge cases（acceptance-01 §A）
//   - 段基匹配:`isSameOrDescendant("wiki-root/a", "wiki-root/ab") === false`。
//     实现按 `/`-split 后逐段比较,不做字符串前缀匹配。
//   - 非法输入:空段 / `.` / `..` / 反斜线 / 控制字符 / 逻辑地址 scheme / 越界长度
//     全部抛 INVALID_PATH 或 INVALID_NAME。
//   - 大小写:保留 Git 路径大小写;大小写策略不依赖 Windows 文件系统行为
//     （design.md §4.2）。比较按精确字符串(区分大小写)。
//
// ## 不做
//   - 不解析 `memory://` / `project://`（那是 plan-02 address resolver 的职责）。
//   - 不读写文件系统(纯字符串逻辑)。
//   - 不查数据库(纯函数)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/design.md §4.2（路径规范）
//   - docs/plan/wiki-system-redesign/plan-01-database-contracts.md §3（API 形状）

import type { WikiErrorCode } from "../../shared/wiki-types.js";

/**
 * Wiki 根路径常量。所有合法 Wiki 路径都以它开头。
 */
export const WIKI_ROOT_PATH = "wiki-root";

/**
 * 路径分隔符（design.md §4.2：统一 `/`）。
 */
export const WIKI_PATH_SEPARATOR = "/";

/**
 * 单段 name 的最大长度（UTF-8 字节数近似;按 JS 字符串长度裁剪,设计 §4.2
 * 「路径段执行长度和非法字符校验」)。256 是 v1 合理上限。
 */
export const WIKI_NAME_MAX_LENGTH = 256;

/**
 * 整路径的最大段数（防止 DoS;v1 合理上限 = 32）。
 */
export const WIKI_PATH_MAX_SEGMENTS = 32;

/**
 * 保留的动态地址 scheme 前缀。这些不应出现在 canonical path 里
 * （canonical path 永远以 `wiki-root` 开头）;若在输入中检测到,拒绝并要求
 * 调用方先经 resolver 解析（plan-02）。
 */
const RESERVED_ADDRESS_SCHEMES = ["memory://", "project://", "runtime://"];

/**
 * 抛出带 code 的 path/name 校验错误。调用方捕获后映射为 WikiError。
 */
function pathError(code: WikiErrorCode, message: string): Error {
	const err = new Error(message);
	(err as Error & { code?: WikiErrorCode }).code = code;
	return err;
}

/**
 * 判断字符是否为 ASCII 控制字符（U+0000–U+001F 或 U+007F）。规范路径段
 * 不得包含控制字符（design.md §4.2：「拒绝控制字符」）。
 */
function isControlChar(ch: string): boolean {
	const code = ch.codePointAt(0);
	if (code === undefined) return false;
	return code <= 0x1f || code === 0x7f;
}

/**
 * 校验单个 name 段。合法时返回;非法时抛 INVALID_NAME。
 *
 * 规则（design.md §4.2 + plan-01 §3）：
 *   - 非空(去除首尾空白后)。
 *   - 不含分隔符 `/` 或反斜线 `\`。
 *   - 不是 `.` 或 `..`。
 *   - 不含控制字符。
 *   - 长度 ≤ WIKI_NAME_MAX_LENGTH。
 *   - 首尾无空白。
 *   - 不含逻辑地址 scheme 前缀。
 */
export function validateWikiName(name: string): void {
	if (typeof name !== "string") {
		throw pathError("INVALID_NAME", `name must be a string (got ${typeof name})`);
	}
	if (name.length === 0 || name.trim().length !== name.length || name.length === 0) {
		throw pathError("INVALID_NAME", `name must not be empty or have leading/trailing whitespace`);
	}
	if (name.includes("/") || name.includes("\\")) {
		throw pathError("INVALID_NAME", `name must not contain '/' or '\\' (got ${JSON.stringify(name)})`);
	}
	if (name === "." || name === "..") {
		throw pathError("INVALID_NAME", `name must not be '.' or '..' (got ${JSON.stringify(name)})`);
	}
	for (const ch of name) {
		if (isControlChar(ch)) {
			throw pathError(
				"INVALID_NAME",
				`name must not contain control characters (got ${JSON.stringify(name)})`,
			);
		}
	}
	if (name.length > WIKI_NAME_MAX_LENGTH) {
		throw pathError(
			"INVALID_NAME",
			`name too long: ${name.length} > ${WIKI_NAME_MAX_LENGTH}`,
		);
	}
	for (const scheme of RESERVED_ADDRESS_SCHEMES) {
		if (name.startsWith(scheme)) {
			throw pathError(
				"INVALID_NAME",
				`name must not start with reserved address scheme ${scheme} (got ${JSON.stringify(name)})`,
			);
		}
	}
}

/**
 * 把任意合法/接近合法的输入归一为 canonical form。
 *
 * - 去除首尾空白。
 * - 去除重复 `/` 和末尾 `/`。
 * - 拒绝空字符串、不含 `wiki-root` 开头、`.` / `..` 段、反斜线、控制字符、
 *   逻辑地址 scheme、越界长度。
 *
 * canonical form 保证：
 *   - 以 `wiki-root` 开头。
 *   - 段间单 `/`。
 *   - 无末尾 `/`（除根 `wiki-root` 自身）。
 *
 * 同一路径的两种写法（`wiki-root/a/`、`wiki-root//a`、` wiki-root/a `）归一后
 * 产生同一字符串（acceptance-01 §A「合法路径产生唯一 canonical form」）。
 */
export function normalizeWikiPath(input: string): string {
	if (typeof input !== "string") {
		throw pathError("INVALID_PATH", `path must be a string (got ${typeof input})`);
	}
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		throw pathError("INVALID_PATH", `path must not be empty`);
	}

	// 拒绝逻辑地址 scheme —— canonical path 永远以 wiki-root 开头。
	// memory:// / project:// 等需先经 resolver（plan-02）。
	for (const scheme of RESERVED_ADDRESS_SCHEMES) {
		if (trimmed.startsWith(scheme)) {
			throw pathError(
				"INVALID_PATH",
				`canonical path must not start with address scheme ${scheme} (got ${JSON.stringify(trimmed)}); resolver runs at call boundary, not here`,
			);
		}
	}

	// 拒绝反斜线（design.md §4.2：不接受 `\`）。
	if (trimmed.includes("\\")) {
		throw pathError(
			"INVALID_PATH",
			`path must not contain backslash (got ${JSON.stringify(trimmed)})`,
		);
	}

	// 拒绝控制字符。
	for (const ch of trimmed) {
		if (isControlChar(ch)) {
			throw pathError(
				"INVALID_PATH",
				`path must not contain control characters (got ${JSON.stringify(trimmed)})`,
			);
		}
	}

	// 按分隔符 split,过滤空段(同时处理重复 `/` 和首尾 `/`)。
	const rawSegments = trimmed.split(WIKI_PATH_SEPARATOR);
	const segments: string[] = [];
	for (const seg of rawSegments) {
		if (seg.length === 0) continue; // 重复 `/` 或首尾 `/`
		if (seg === "." || seg === "..") {
			throw pathError(
				"INVALID_PATH",
				`path must not contain '.' or '..' segments (got ${JSON.stringify(trimmed)})`,
			);
		}
		segments.push(seg);
	}

	if (segments.length === 0) {
		throw pathError("INVALID_PATH", `path must have at least one segment (got ${JSON.stringify(input)})`);
	}

	// 必须以 wiki-root 开头（design.md §4.2）。
	if (segments[0] !== WIKI_ROOT_PATH) {
		throw pathError(
			"INVALID_PATH",
			`path must start with '${WIKI_ROOT_PATH}' (got ${JSON.stringify(trimmed)})`,
		);
	}

	if (segments.length > WIKI_PATH_MAX_SEGMENTS) {
		throw pathError(
			"INVALID_PATH",
			`path too deep: ${segments.length} > ${WIKI_PATH_MAX_SEGMENTS} segments`,
		);
	}

	// 每个非根段都要通过 name 校验（首段 wiki-root 是系统保留字,跳过 name 校验）。
	for (let i = 1; i < segments.length; i++) {
		validateWikiName(segments[i]);
	}

	return segments.join(WIKI_PATH_SEPARATOR);
}

/**
 * 父路径 + name → 子路径。先 normalize parent,再校验 name,最后拼接。
 *
 * `joinWikiPath("wiki-root/knowledge", "topic")` → `"wiki-root/knowledge/topic"`。
 *
 * **单段 name only**:`name` 不允许含 `/`(会抛 INVALID_NAME)。要把一个多段
 * 仓库相对路径(如 `src/server/loop.ts`)挂到父路径下,用 {@link joinWikiPathMulti}。
 */
export function joinWikiPath(parent: string, name: string): string {
	const normalizedParent = normalizeWikiPath(parent);
	validateWikiName(name);
	return `${normalizedParent}${WIKI_PATH_SEPARATOR}${name}`;
}

/**
 * 父路径 + 一个或多个 segment(每个 segment 可以含 `/`) → 子路径。
 *
 * 用于把 Git 仓库相对路径(`src/server/loop.ts`、`config/app.json`)挂到
 * Wiki 节点路径下。每个 segment 会被 `/` split,空段跳过(与 normalizeWikiPath
 * 一致),每个非空段单独通过 {@link validateWikiName} 校验。
 *
 * 与 {@link joinWikiPath} 的区别:后者只接受单个不含 `/` 的 name 段。
 * 传多段路径给 joinWikiPath 会被 INVALID_NAME 拒绝(round-1 BLOCKER 1:
 * `validateWikiName` 拒绝含 `/` 的 name)。
 *
 * 行为示例:
 *   - `joinWikiPathMulti("wiki-root/projects/p", "src/server/loop.ts")` →
 *     `"wiki-root/projects/p/src/server/loop.ts"`
 *   - `joinWikiPathMulti("wiki-root/projects/p", "src", "server", "loop.ts")` →
 *     同上(等价)
 *   - `joinWikiPathMulti("wiki-root/projects/p", "")` →
 *     `"wiki-root/projects/p"`(空 segment 跳过)
 *   - `joinWikiPathMulti("wiki-root/projects/p", "a//b")` →
 *     `"wiki-root/projects/p/a/b"`(空段跳过)
 *
 * 入参约定:`segments` 应来自已校验的 Git 仓库相对路径(Git `/` 分隔 +
 * 原始大小写),不应来自 Agent 输入。每段仍走 `validateWikiName` 以拒绝
 * 控制字符、`.`、`..`、反斜线等。
 *
 * @throws INVALID_PATH / INVALID_NAME 当 parent 不合法或任一 segment 段非法时。
 */
export function joinWikiPathMulti(parent: string, ...segments: string[]): string {
	const normalizedParent = normalizeWikiPath(parent);
	if (segments.length === 0) return normalizedParent;
	const allSegs = normalizedParent.split(WIKI_PATH_SEPARATOR);
	for (const seg of segments) {
		if (typeof seg !== "string") {
			throw pathError(
				"INVALID_NAME",
				`segment must be a string (got ${typeof seg})`,
			);
		}
		// 按 `/` split(Git 路径用 `/`;也允许调用方传反斜线?——不允许,
		// validateWikiName 会拒绝)。空段(连续 `/` 或首尾)直接跳过,与
		// normalizeWikiPath 行为一致。
		const subSegs = seg.split(WIKI_PATH_SEPARATOR);
		for (const sub of subSegs) {
			if (sub.length === 0) continue; // 重复 `/` 或首尾 `/`
			validateWikiName(sub);
			allSegs.push(sub);
		}
	}
	if (allSegs.length > WIKI_PATH_MAX_SEGMENTS) {
		throw pathError(
			"INVALID_PATH",
			`path too deep: ${allSegs.length} > ${WIKI_PATH_MAX_SEGMENTS} segments`,
		);
	}
	return allSegs.join(WIKI_PATH_SEPARATOR);
}

/**
 * 取父路径。根 `wiki-root` 返回 null;否则返回去除最后一段的 canonical 父路径。
 *
 * `parentWikiPath("wiki-root/a/b")` → `"wiki-root/a"`。
 * `parentWikiPath("wiki-root")` → `null`。
 */
export function parentWikiPath(path: string): string | null {
	const normalized = normalizeWikiPath(path);
	const idx = normalized.lastIndexOf(WIKI_PATH_SEPARATOR);
	if (idx < 0) return null; // 根 `wiki-root` 无父
	return normalized.slice(0, idx);
}

/**
 * 段基 `scope ⊇ path` 判断（含自身和后代）。
 *
 * **段基匹配**(acceptance-01 §A 关键 edge case):按 `/`-split 后逐段比较,
 * 不做字符串前缀匹配 —— 因此 `isSameOrDescendant("wiki-root/a", "wiki-root/ab")`
 * 返回 **false**(不是 true)。
 *
 * - 自身：`isSameOrDescendant("wiki-root/a", "wiki-root/a")` → true。
 * - 后代：`isSameOrDescendant("wiki-root/a", "wiki-root/a/b")` → true。
 * - 兄弟/无关节点：`isSameOrDescendant("wiki-root/a", "wiki-root/ab")` → false。
 *
 * @param scope 已规范化的 scope 路径
 * @param path  待判定的路径(自身或后代)
 */
export function isSameOrDescendant(scope: string, path: string): boolean {
	const normalizedScope = normalizeWikiPath(scope);
	const normalizedPath = normalizeWikiPath(path);
	if (normalizedScope === normalizedPath) return true;

	const scopeSegs = normalizedScope.split(WIKI_PATH_SEPARATOR);
	const pathSegs = normalizedPath.split(WIKI_PATH_SEPARATOR);
	// path 必须严格比 scope 深(否则不是后代)。
	if (pathSegs.length <= scopeSegs.length) return false;
	// 逐段精确匹配(区分大小写,Git 路径保留原 case)。
	for (let i = 0; i < scopeSegs.length; i++) {
		if (scopeSegs[i] !== pathSegs[i]) return false;
	}
	return true;
}

/**
 * 拆分路径为段数组。已规范化。根返回 `["wiki-root"]`。
 */
export function splitWikiPath(path: string): string[] {
	return normalizeWikiPath(path).split(WIKI_PATH_SEPARATOR);
}

/**
 * 取路径最后一段 name。根返回 `WIKI_ROOT_PATH`。
 */
export function lastSegmentOfWikiPath(path: string): string {
	const normalized = normalizeWikiPath(path);
	const idx = normalized.lastIndexOf(WIKI_PATH_SEPARATOR);
	return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/**
 * 判断路径是否为根 `wiki-root`。
 */
export function isWikiRoot(path: string): boolean {
	return normalizeWikiPath(path) === WIKI_ROOT_PATH;
}
