// WikiEditService —— 局部正文编辑（wiki-system-redesign plan-02 §5 / design.md §8.7）
//
// # 文件说明书
//
// ## 核心功能
// 把 `update` action 的 `operations[]` 应用到 TEXT 正文,返回修改后的正文。本服务
// 是纯函数（不读 DB / 不开 transaction）;由 WikiService.update 在 transaction 内
// 调用,把新正文写回 wiki_nodes.content 并同步 FTS。
//
// ## Operations（design.md §8.7）
//   - replace_text     —— 替换 N 次出现的子串;区分 0 / 1 / 多次命中
//   - insert_before    —— 在 anchor 文本或 section 之前插入
//   - insert_after     —— 在 anchor 文本或 section 之后插入
//   - append           —— 追加到正文末尾
//   - prepend          —— 插到正文开头
//   - replace_section  —— 按 heading name 替换整段 section
//   - append_to_section—— 把 text 追加到指定 section 末尾（next heading 前）
//   - delete_section   —— 删除整段 section（含 heading）
//
// ## 错误码（plan-02 §5）
//   - EDIT_TARGET_NOT_FOUND —— anchor / section 找不到
//   - EDIT_TARGET_AMBIGUOUS —— 同名 anchor / section 多次出现且未消歧
//   - WRITE_CONFLICT        —— expected_occurrences 不匹配实际命中数
//
// ## Markdown 解析（design.md §8.7 + acceptance-02 §A「parser 是直接依赖」）
//   - 使用项目直接依赖 `unified` + `remark-parse`（package.json dependencies）。
//   - 同时支持 ATX（`# Heading`）和 Setext（`Heading\\n===`）heading。
//   - Section = 目标 heading 起,到下一个同级或更高级 heading 前结束。
//   - Fenced code block 内的 `#` **不**参与 heading 解析（CommonMark AST 自动保证）。
//   - 同名 heading 用 `level` / `occurrence` 消歧;否则 EDIT_TARGET_AMBIGUOUS。
//
// ## 不做
//   - 不读 DB / 不写 DB / 不开 transaction。
//   - 不实现 inline Markdown 渲染（只做 source-text AST 分析 + 字符串 replace）。
//   - 不引入 sections 表（design.md §8.7「第一版仍整体读写单个 TEXT」）。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-02-core-service-address-auth.md §5
//   - docs/archive/wiki-system-redesign/design.md §8.7

import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Heading, Root } from "mdast";
import type { WikiEditOperation } from "../../shared/wiki-types.js";
import { wikiError } from "./wiki-errors.js";

/**
 * 懒编译的 unified parser。模块级单例（pure 函数,无副作用）。
 *
 * `unified().use(remarkParse)` 返回一个 frozen Processor;`.parse()` 是同步纯函数
 * （remark-parse 是 sync parser）。本服务不调用 `.run()`（不转 mdast → hast）。
 */
const parser = unified().use(remarkParse);

/**
 * Section 命中（来自 AST 分析）。
 */
interface SectionHit {
	/** Heading 在原文中的起始字节偏移（含 ATX `#` / Setext 下划线行）。 */
	start: number;
	/** Section 结束字节偏移（exclusive = 下一个同级或更高级 heading 起 / 文档末尾）。 */
	end: number;
	/** Heading 级别（1–6）。 */
	level: number;
	/** Heading 文本（已展平 children 的 text 内容）。 */
	name: string;
	/** 同名 + 同级中的 1-based occurrence。 */
	occurrence: number;
}

/**
 * WikiEditService —— 局部正文编辑纯函数实现。
 */
export class WikiEditService {
	/**
	 * 按序应用 operations 到 content,返回新 content。任意 op 失败则抛
	 * (EDIT_TARGET_NOT_FOUND / EDIT_TARGET_AMBIGUOUS / WRITE_CONFLICT) 且不应用
	 * 后续 op（由调用方在 transaction 中回滚整批）。
	 *
	 * 注意:`operations` 顺序应用 —— 前一个 op 修改后的 content 是下一个 op 的输入。
	 */
	applyOperations(content: string, operations: WikiEditOperation[]): string {
		let current = content;
		for (const op of operations) {
			current = this.applyOne(current, op);
		}
		return current;
	}

	/**
	 * 应用单个 operation。
	 */
	private applyOne(content: string, op: WikiEditOperation): string {
		switch (op.op) {
			case "replace_text":
				return this.applyReplaceText(content, op);
			case "insert_before":
				return this.applyInsertBefore(content, op);
			case "insert_after":
				return this.applyInsertAfter(content, op);
			case "append":
				return this.applyAppend(content, op);
			case "prepend":
				return this.applyPrepend(content, op);
			case "replace_section":
				return this.applyReplaceSection(content, op);
			case "append_to_section":
				return this.applyAppendToSection(content, op);
			case "delete_section":
				return this.applyDeleteSection(content, op);
			default:
				throw wikiError("INVALID_REQUEST", `unknown edit op: ${(op as { op?: string }).op}`);
		}
	}

	// -------------------------------------------------------------------------
	// text-based ops
	// -------------------------------------------------------------------------

	private applyReplaceText(
		content: string,
		op: Extract<WikiEditOperation, { op: "replace_text" }>,
	): string {
		if (op.old_text.length === 0) {
			throw wikiError(
				"INVALID_REQUEST",
				"replace_text.old_text must be non-empty",
			);
		}
		const occurrences = countOccurrences(content, op.old_text);
		const expected = op.expected_occurrences ?? 1;
		if (occurrences === 0) {
			throw wikiError(
				"EDIT_TARGET_NOT_FOUND",
				"replace_text: old_text not found in content",
			);
		}
		if (occurrences !== expected) {
			// 多次命中且未声明 expected_occurrences → AMBIGUOUS;命中数与 expected 不符 → CONFLICT。
			if (expected === 1 && occurrences > 1) {
				throw wikiError(
					"EDIT_TARGET_AMBIGUOUS",
					`replace_text: old_text matched ${occurrences} times; pass expected_occurrences or make anchor unique`,
				);
			}
			throw wikiError(
				"WRITE_CONFLICT",
				`replace_text: expected ${expected} occurrences but found ${occurrences}`,
			);
		}
		return splitJoinReplace(content, op.old_text, op.new_text);
	}

	private applyInsertBefore(
		content: string,
		op: Extract<WikiEditOperation, { op: "insert_before" }>,
	): string {
		const idx = this.locateAnchor(content, op.anchor, op.anchor_section ?? null);
		return content.slice(0, idx) + op.text + content.slice(idx);
	}

	private applyInsertAfter(
		content: string,
		op: Extract<WikiEditOperation, { op: "insert_after" }>,
	): string {
		const idx = this.locateAnchor(content, op.anchor, op.anchor_section ?? null);
		const end = idx + op.anchor.length;
		return content.slice(0, end) + op.text + content.slice(end);
	}

	private applyAppend(
		content: string,
		op: Extract<WikiEditOperation, { op: "append" }>,
	): string {
		const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		return content + sep + op.text;
	}

	private applyPrepend(
		content: string,
		op: Extract<WikiEditOperation, { op: "prepend" }>,
	): string {
		const sep = content.length > 0 && !content.startsWith("\n") ? "\n" : "";
		return op.text + sep + content;
	}

	// -------------------------------------------------------------------------
	// section ops
	// -------------------------------------------------------------------------

	private applyReplaceSection(
		content: string,
		op: Extract<WikiEditOperation, { op: "replace_section" }>,
	): string {
		const hit = this.findSection(content, op.section, op.level ?? null, op.occurrence ?? null);
		return content.slice(0, hit.start) + op.new_text + content.slice(hit.end);
	}

	private applyAppendToSection(
		content: string,
		op: Extract<WikiEditOperation, { op: "append_to_section" }>,
	): string {
		const hit = this.findSection(content, op.section, op.level ?? null, op.occurrence ?? null);
		const insertIdx = hit.end; // section 末尾 = 下一 heading 前 / 文档末尾
		const sep = !content.slice(0, insertIdx).endsWith("\n") ? "\n" : "";
		return content.slice(0, insertIdx) + sep + op.text + content.slice(insertIdx);
	}

	private applyDeleteSection(
		content: string,
		op: Extract<WikiEditOperation, { op: "delete_section" }>,
	): string {
		const hit = this.findSection(content, op.section, op.level ?? null, op.occurrence ?? null);
		// 删除 [hit.start, hit.end),并吃掉前后多余的空行（保持 Markdown 视觉整洁）。
		let start = hit.start;
		let end = hit.end;
		// 向前吃掉紧邻的空行（直到上一非空行末尾的 \n）。
		while (start > 0 && content.charAt(start - 1) === "\n") {
			start--;
			if (start > 0 && content.charAt(start - 1) === "\n") break; // 保留一个分隔 \n
		}
		// 向后吃掉紧邻的空行。
		while (end < content.length && content.charAt(end) === "\n") {
			end++;
		}
		return content.slice(0, start) + content.slice(end);
	}

	// -------------------------------------------------------------------------
	// Anchor 定位（用于 insert_before / insert_after）
	// -------------------------------------------------------------------------

	/**
	 * 在 content 中定位 anchor 的字节偏移。如果 anchor_section 提供,先定位 section,
	 * 再在 section 内定位 anchor;section 不存在 → EDIT_TARGET_NOT_FOUND;anchor 在
	 * section 内多次出现且未消歧 → EDIT_TARGET_AMBIGUOUS;section 内 0 次 → NOT_FOUND。
	 *
	 * 如果 anchor_section 为 null:全文定位 anchor;规则同上。
	 */
	private locateAnchor(content: string, anchor: string, section: string | null): number {
		if (anchor.length === 0) {
			throw wikiError("INVALID_REQUEST", "anchor must be non-empty");
		}
		const searchIn = (haystack: string, label: string): number => {
			const occurrences = countOccurrences(haystack, anchor);
			if (occurrences === 0) {
				throw wikiError(
					"EDIT_TARGET_NOT_FOUND",
					`anchor not found in ${label}`,
				);
			}
			if (occurrences > 1) {
				throw wikiError(
					"EDIT_TARGET_AMBIGUOUS",
					`anchor matched ${occurrences} times in ${label}; make it unique`,
				);
			}
			return haystack.indexOf(anchor);
		};
		if (section === null || section.length === 0) {
			return searchIn(content, "content");
		}
		const hit = this.findSection(content, section, null, null);
		const sectionText = content.slice(hit.start, hit.end);
		const relativeIdx = searchIn(sectionText, `section '${section}'`);
		return hit.start + relativeIdx;
	}

	// -------------------------------------------------------------------------
	// Markdown section analysis（unified + remark-parse）
	// -------------------------------------------------------------------------

	/**
	 * 用 unified + remark-parse 解析 content,枚举所有 heading,按
	 * (name, level?, occurrence?) 定位 section。**public 暴露给 WikiService.read()**
	 * 用于按 section 切片读取（design.md §8.4 read.section）。
	 *
	 * 行为：
	 *   - 若提供 level:只匹配该 level 的同名 heading。
	 *   - 若提供 occurrence:取同名（同级,如有 level）第 occurrence 个（1-based）。
	 *   - 否则:若同名（同级）唯一 → 命中;若多次 → EDIT_TARGET_AMBIGUOUS。
	 *
	 * Section 范围：[heading 起, 下一个同级或更高级 heading 起 / 文档末尾)。
	 */
	findSectionPublic(
		content: string,
		name: string,
		level: number | null,
		occurrence: number | null,
	): SectionHit {
		const hits = this.enumerateSections(content);
		const candidates = hits.filter((h) => {
			if (h.name !== name) return false;
			if (level !== null && h.level !== level) return false;
			return true;
		});
		if (candidates.length === 0) {
			throw wikiError(
				"EDIT_TARGET_NOT_FOUND",
				`section '${name}' not found${level ? ` at level ${level}` : ""}`,
			);
		}
		if (occurrence !== null) {
			const picked = candidates.find((h) => h.occurrence === occurrence);
			if (!picked) {
				throw wikiError(
					"EDIT_TARGET_NOT_FOUND",
					`section '${name}' occurrence ${occurrence} not found (have ${candidates.length})`,
				);
			}
			return picked;
		}
		if (candidates.length > 1) {
			throw wikiError(
				"EDIT_TARGET_AMBIGUOUS",
				`section '${name}' matched ${candidates.length} headings; pass level/occurrence`,
			);
		}
		return candidates[0];
	}

	/**
	 * @deprecated 别名,内部用。外部请用 findSectionPublic。保留是为了与
	 * applyReplaceSection 等私有路径共享实现。
	 */
	private findSection(
		content: string,
		name: string,
		level: number | null,
		occurrence: number | null,
	): SectionHit {
		return this.findSectionPublic(content, name, level, occurrence);
	}

	/**
	 * 用 remark-parse 解析 content,枚举所有 section（每个 heading 对应一段 section,
	 * 终止于下一个同级或更高级 heading）。
	 *
	 * 字节偏移由 mdast node.position.start.offset / end.offset 提供（remark-parse 默认填）。
	 */
	private enumerateSections(content: string): SectionHit[] {
		const tree = parser.parse(content) as Root;
		const headings: Array<{
			start: number;
			level: number;
			name: string;
		}> = [];
		for (const child of tree.children) {
			if (child.type !== "heading") continue;
			const start = child.position?.start?.offset ?? 0;
			headings.push({
				start,
				level: child.depth,
				name: headingText(child),
			});
		}
		// occurrence（按 name + level 1-based）
		const counters = new Map<string, number>();
		const hits: SectionHit[] = [];
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			const key = `${h.name}@${h.level}`;
			const next = (counters.get(key) ?? 0) + 1;
			counters.set(key, next);
			// end = 下一个同级或更高级 heading 起;无则文档末尾。
			let end = content.length;
			for (let j = i + 1; j < headings.length; j++) {
				if (headings[j].level <= h.level) {
					end = headings[j].start;
					break;
				}
			}
			hits.push({
				start: h.start,
				end,
				level: h.level,
				name: h.name,
				occurrence: next,
			});
		}
		return hits;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 计算子串出现次数（不重叠,从左向右扫）。
 */
function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let n = 0;
	let idx = 0;
	while (true) {
		const found = haystack.indexOf(needle, idx);
		if (found < 0) break;
		n++;
		idx = found + needle.length;
	}
	return n;
}

/**
 * 把 haystack 中所有 needle 替换为 replacement（不重叠）。
 */
function splitJoinReplace(haystack: string, needle: string, replacement: string): string {
	if (needle.length === 0) return haystack;
	let out = "";
	let idx = 0;
	while (true) {
		const found = haystack.indexOf(needle, idx);
		if (found < 0) break;
		out += haystack.slice(idx, found) + replacement;
		idx = found + needle.length;
	}
	return out + haystack.slice(idx);
}

/**
 * 从 mdast heading node 展平 children 取文本。支持 text / strong / em / code /
 * link 等内联节点（取 children 中的 literal 文本）。
 *
 * Setext heading 由 remark-parse 自动识别并归一化为 depth=1/2 的 heading node;
 * 不需要单独处理 `===` / `---`。
 */
function headingText(node: Heading): string {
	let out = "";
	for (const child of node.children) {
		out += inlineText(child);
	}
	return out.trim();
}

/**
 * 内联节点展平。递归处理嵌套（如 link > text）。
 */
function inlineText(node: unknown): string {
	if (node === null || typeof node !== "object") return "";
	const n = node as {
		type?: string;
		value?: string;
		children?: unknown[];
	};
	if (typeof n.value === "string") return n.value;
	if (Array.isArray(n.children)) {
		let out = "";
		for (const c of n.children) out += inlineText(c);
		return out;
	}
	return "";
}

// 重新导出 mdast 类型子集,便于下游（如 sections 表未来引入时）使用。
export type { Heading, Root };
export type { SectionHit };
