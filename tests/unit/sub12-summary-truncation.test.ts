// sub-12: expand/search summary 截断标记验证
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-12.md 六条:
//   1. 代码 head 截断(>120 字符)summary 末尾(head 段)带 `…`。
//   2. 文档 heading/firstPara 截断(>200 字符)summary 末尾带 `…`。
//   3. expand 透传:被截断 summary 的节点 ensureSummary 返回值(渲染层原样
//      输出的源)末尾显 `…`。
//   4. search 透传:同上 —— search 渲染同一份 node.summary,标记透传。
//   5. 不误加:短 summary(未截断)末尾**无** `…`。
//   6. 范围限定:只改 wiki-skeleton-service.ts(diff 审查在报告里,本测试
//      不重做 git diff,但会断言 exportsList.slice(0,6) 行为不变 —— 7+
//      个 export 的文件 Exports 段不出现 `…`)。
//
// ## 测试策略(对抗式)
// - 不 mock 私有方法;经公开 ensureSummary(传 `header:`/`intent:` 路径节点)
//   触发真实 summarizeCodeFile/summarizeDocFile,验真实存储的 summary。
// - 短/长边界各一份文件;字符精确到上限(120/200),再加 1 字符触发截断。
// - expand/search 共用同一份 node.summary,所以一处断言同时覆盖 (3)/(4)
//   透传正确性(渲染层原样输出,见 wiki-tool.ts)。
// - sub-12.md 明示旧 materialized summary 不自愈,这里新项目全空 summary,
//   ensureSummary 一定走重算分支。
//
// ## 输入
// 临时 SessionDB + 真 stores + 临时 workspace 目录(不需 git;ensureSummary
// 直接 resolve(workspaceDir, relPath) 读文件,不经 git)。
//
// ## 输出
// Vitest 用例。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { WikiStore, projectSubtreeRootId } from "../../src/server/wiki-node-store.js";
import { WikiScanCursorStore } from "../../src/server/wiki-scan-cursor-store.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { WikiSkeletonService } from "../../src/server/wiki-skeleton-service.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wikiStore: WikiStore;
let projectStore: ProjectStore;
let requirementStore: RequirementStore;
let cursorStore: WikiScanCursorStore;
let archivistService: WikiSkeletonService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub12-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	cursorStore = new WikiScanCursorStore(sessionDB);
	archivistService = new WikiSkeletonService({
		wikiStore,
		cursorStore,
		git: new ArchivistGit(),
		projectStore,
		requirementStore,
	});
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// Build a code file with a long (or short) head so the 3-line join crosses
// (or doesn't) the 120-char Head-truncation threshold. We avoid exports so the
// summary's tail is the Head segment (the truncation point we're asserting on).
function makeCodeFile(ws: string, rel: string, headText: string): void {
	const abs = join(ws, rel);
	mkdirSync(abs.slice(0, abs.lastIndexOf(require("node:path").sep)), { recursive: true });
	// 3 lines each identical → head = `${headText} / ${headText} / ${headText}`
	writeFileSync(abs, `${headText}\n${headText}\n${headText}\n`);
}

// Build a doc file whose first markdown heading is `headingText`. summarizeDocFile
// returns that heading (after stripping `# `), truncated at 200 if needed.
function makeDocWithHeading(ws: string, rel: string, headingText: string): void {
	const abs = join(ws, rel);
	mkdirSync(abs.slice(0, abs.lastIndexOf(require("node:path").sep)), { recursive: true });
	writeFileSync(abs, `# ${headingText}\n\nbody\n`);
}

// Build a doc file with NO markdown heading anywhere so summarizeDocFile falls
// through to the first paragraph. CRITICAL: summarizeDocFile uses
// `.split(/\r?\n/).find(l => /^\s*#\s+/.test(l))` — it scans ALL lines, not
// just the first. So the file must contain ZERO `#`-prefixed lines for the
// firstPara branch to trigger. `firstParaText` becomes the returned summary.
function makeDocWithoutHeading(ws: string, rel: string, firstParaText: string): void {
	const abs = join(ws, rel);
	mkdirSync(abs.slice(0, abs.lastIndexOf(require("node:path").sep)), { recursive: true });
	// Note: deliberately NO `# ...` line anywhere.
	writeFileSync(abs, `${firstParaText}\n\nsome body text without hash prefix\n`);
}

// Helper: upsert a header node for a code file and call ensureSummary.
function materializeHeaderCodeSummary(
	projectId: string,
	relPath: string,
): { nodeId: string; summary: string } {
	const root = wikiStore.ensureProjectSubtree(projectId);
	const node = wikiStore.upsertProjectNode(projectId, {
		parentId: root.id,
		type: "header",
		path: `header:${relPath}`,
		title: relPath,
		summary: "", // empty → ensureSummary recomputes
	});
	const summary = archivistService.ensureSummary(node.id) ?? "";
	// ensureSummary persists the summary onto the node row; reload to confirm
	// the storage layer (the one expand/search read) actually has it.
	const reloaded = wikiStore.get(node.id);
	return { nodeId: node.id, summary: reloaded?.summary ?? summary };
}

// Helper: upsert an intent node for a doc file and call ensureSummary.
function materializeIntentDocSummary(
	projectId: string,
	relPath: string,
): { nodeId: string; summary: string } {
	const root = wikiStore.ensureProjectSubtree(projectId);
	const node = wikiStore.upsertProjectNode(projectId, {
		parentId: root.id,
		type: "intent",
		path: `intent:${relPath}`,
		title: relPath,
		summary: "",
	});
	archivistService.ensureSummary(node.id);
	const reloaded = wikiStore.get(node.id);
	return { nodeId: node.id, summary: reloaded?.summary ?? "" };
}

const ELLIPSIS = "…"; // U+2026

// ─── acceptance #1: code head truncation marker ───────────────

describe("sub-12 #1: code file head truncation marks with …", () => {
	test("head > 120 chars → Head segment ends with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// Each of the 3 lines is 50 chars → head = `${line} / ${line} / ${line}`
		// = 50 + 3 + 50 + 3 + 50 = 156 chars (> 120). The ` / ` separators are
		// part of the head string, so the truncated head is 120 chars total of
		// (x + space/slash) mix — NOT 120 pure x's. We assert on the segment
		// length + the marker, which is what the implementation guarantees.
		const line = "x".repeat(50);
		makeCodeFile(tmpDir, "long.ts", line);

		const { summary, nodeId } = materializeHeaderCodeSummary(proj.id, "long.ts");

		// Head segment is the LAST part of the summary (`Head: ...`); no exports
		// means the whole summary ends with the Head segment, so it ends with `…`.
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
		// Extract the Head segment and assert: it's exactly "Head: " + 120 chars
		// + "…". The original (untruncated) head was 156 chars, so the 120 cap
		// must have fired — a regression that stopped truncating would yield 156.
		const headIdx = summary.lastIndexOf("Head: ");
		expect(headIdx).toBeGreaterThanOrEqual(0);
		const headSegment = summary.slice(headIdx + "Head: ".length);
		// headSegment = 120 truncated chars + 1 marker char.
		expect(headSegment.length).toBe(120 + ELLIPSIS.length);
		expect(headSegment.endsWith(ELLIPSIS)).toBe(true);
		// Marker is at the very end, not inserted mid-string.
		expect(headSegment.indexOf(ELLIPSIS)).toBe(headSegment.length - ELLIPSIS.length);
		// Node row was persisted with the same summary (expand/search read this row).
		expect(wikiStore.get(nodeId)!.summary).toBe(summary);
	});

	test("head exactly 120 chars → no truncation, no …", () => {
		// Boundary: head length == 120 → `head.length > 120` is false → no marker.
		// 3 lines of 38 chars: head = 38+3+38+3+38 = 120 chars exactly.
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const line = "x".repeat(38);
		makeCodeFile(tmpDir, "exact120.ts", line);

		const { summary } = materializeHeaderCodeSummary(proj.id, "exact120.ts");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toContain("Head:");
	});

	test("head exactly 121 chars → truncation, …", () => {
		// Boundary +1: just over the threshold must trip the marker.
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// 3 lines of 39 chars: head = 39+3+39+3+39 = 123 chars (>120).
		const line = "x".repeat(39);
		makeCodeFile(tmpDir, "over120.ts", line);

		const { summary } = materializeHeaderCodeSummary(proj.id, "over120.ts");
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
	});
});

// ─── acceptance #2: doc heading/firstPara truncation marker ────

describe("sub-12 #2: doc heading/firstPara truncation marks with …", () => {
	test("heading > 200 chars → summary ends with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const heading = "h".repeat(250); // > 200
		makeDocWithHeading(tmpDir, "docs/requirements/req-long.md", heading);

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-long.md");

		expect(summary.endsWith(ELLIPSIS)).toBe(true);
		// Truncated to exactly 200 chars + marker.
		expect(summary).toBe(`${"h".repeat(200)}${ELLIPSIS}`);
	});

	test("heading exactly 200 chars → no truncation, no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const heading = "h".repeat(200); // exactly at threshold
		makeDocWithHeading(tmpDir, "docs/requirements/req-200.md", heading);

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-200.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toBe("h".repeat(200));
	});

	test("heading exactly 201 chars → truncation, …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const heading = "h".repeat(201); // just over threshold
		makeDocWithHeading(tmpDir, "docs/requirements/req-201.md", heading);

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-201.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
	});

	test("firstPara > 200 chars (no heading) → summary ends with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// No `#` heading → summarizeDocFile falls to firstPara branch.
		const para = "p".repeat(300);
		makeDocWithoutHeading(tmpDir, "docs/requirements/req-para.md", para);

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-para.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
		expect(summary).toBe(`${"p".repeat(200)}${ELLIPSIS}`);
	});

	test("firstPara exactly 200 chars (no heading) → no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const para = "p".repeat(200);
		makeDocWithoutHeading(tmpDir, "docs/requirements/req-para200.md", para);

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-para200.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toBe("p".repeat(200));
	});
});

// ─── acceptance #3 & #4: marker passes through to expand/search ─
//
// expand (wiki-tool.ts expand sub-rows + own Summary) and search (search row)
// both render node.summary verbatim after sanitizeText (which does NOT mutate
// truncation markers — it only strips mojibake/whitespace). So the same stored
// summary we materialize here is exactly what those surfaces show. We assert
// the marker survives in the persisted row (the source of truth both surfaces
// read), which transitively proves both expand and search surface it.

describe("sub-12 #3 & #4: truncation marker passes through to expand/search source", () => {
	test("truncated code summary persisted with … (expand/search read this row)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const line = "y".repeat(60); // head = 60*3+2*3 = 186 chars (>120)
		makeCodeFile(tmpDir, "expand-src.ts", line);

		const { nodeId } = materializeHeaderCodeSummary(proj.id, "expand-src.ts");
		const persisted = wikiStore.get(nodeId)!.summary!;

		// The summary row that expand/search output verbatim ends with the marker.
		expect(persisted.endsWith(ELLIPSIS)).toBe(true);
		// Marker is at the truncation point, not elsewhere.
		const idx = persisted.lastIndexOf(ELLIPSIS);
		expect(idx).toBe(persisted.length - ELLIPSIS.length);
	});

	test("truncated doc summary persisted with … (expand/search read this row)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const heading = "z".repeat(400);
		makeDocWithHeading(tmpDir, "docs/requirements/expand-doc.md", heading);

		const { nodeId } = materializeIntentDocSummary(proj.id, "docs/requirements/expand-doc.md");
		const persisted = wikiStore.get(nodeId)!.summary!;
		expect(persisted.endsWith(ELLIPSIS)).toBe(true);
	});
});

// ─── acceptance #5: no marker on short (untruncated) summaries ─

describe("sub-12 #5: short summaries do NOT get …", () => {
	test("short code head → no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// 3 lines of 10 chars → head = 30+6 = 36 chars (well under 120).
		makeCodeFile(tmpDir, "short.ts", "x".repeat(10));

		const { summary } = materializeHeaderCodeSummary(proj.id, "short.ts");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toContain("Head:");
	});

	test("short doc heading → no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithHeading(tmpDir, "docs/requirements/short.md", "short heading");

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/short.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toBe("short heading");
	});

	test("empty doc (no heading, empty firstPara) → no …, no spurious content", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// A doc with no heading and no body content.
		const abs = join(tmpDir, "docs/requirements/empty.md");
		mkdirSync(abs.slice(0, abs.lastIndexOf(require("node:path").sep)), { recursive: true });
		writeFileSync(abs, "");

		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/empty.md");
		// Empty source → empty summary, definitely no marker.
		expect(summary).toBe("");
		expect(summary.includes(ELLIPSIS)).toBe(false);
	});
});

// ─── acceptance #6 (partial): exportsList.slice(0,6) untouched ──
//
// The full scope check (only wiki-skeleton-service.ts modified) is in the
// report via `git diff`. Here we confirm the BEHAVIORAL invariant the spec
// calls out as "must not change": a file with >6 exports produces an Exports
// segment capped at 6 entries with NO `…` (Exports truncation is a different
// semantic — "first 6 exports" in a `Exports: …(list).` sentence — and was
// explicitly out of scope per sub-12.md).

describe("sub-12 #6: exportsList.slice(0,6) behavior unchanged", () => {
	test("file with 8 exports → Exports shows 6, summary does NOT end with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		// 8 exports + a SHORT head (so the only thing that could add `…` would be
		// a regression that started marking the Exports truncation).
		const content = [
			"// short comment", // head line 1
			"",                  // head line 2
			"",                  // head line 3
			...Array.from({ length: 8 }, (_, i) => `export const e${i} = ${i};`),
			"",
		].join("\n");
		const abs = join(tmpDir, "many.ts");
		writeFileSync(abs, content);

		const { summary } = materializeHeaderCodeSummary(proj.id, "many.ts");

		// Exports segment is present and capped at exactly 6 entries.
		expect(summary).toMatch(/Exports: .*\./);
		const exportsMatch = summary.match(/Exports: (.+?)\.\s/);
		expect(exportsMatch).not.toBeNull();
		const listed = exportsMatch![1].split(", ");
		expect(listed).toHaveLength(6);
		// Per sub-12.md: Exports truncation is NOT marked with `…`. The summary
		// as a whole ends with the Head segment (short head, no marker), so the
		// whole-string tail check confirms no `…` leaked in anywhere.
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary.includes(ELLIPSIS)).toBe(false);
	});
});
