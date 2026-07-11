// summary 内容策略 + 截断验证(原 sub-12,重写适配新策略)
//
// # 文件说明书
//
// ## 核心功能
// 验证新 summary 策略:
//   1. 代码文件 rule-based summary = `<relPath> — <首条有意义注释>` 或
//      `<relPath> — <N> 行代码`(无 Head/Exports 段 —— 那些属于 detail)。
//   2. 文档文件 summarizeDocFile:heading/firstPara 截断(>200 字符)带 `…`(不变)。
//   3. 截断标记透传到存储行(expand/search 读的就是这行)。
//   4. 短 summary(未截断)末尾无 `…`。
//   5. store 层 summary 字节上限:写入 > SUMMARY_MAX_BYTES(512)→ 截到 512 + `…`,
//      UTF-8 安全(不截断多字节字符)。
//
// ## 测试策略
// - 代码/文档 summary 经公开 ensureSummary(传 header:/intent: 路径节点)触发真实
//   summarizeCodeFile/summarizeDocFile,验真实存储的 summary。
// - store 字节上限直接 upsert 一个超长 summary,验持久化结果。
//
// ## 输入
// 临时 SessionDB + 真 stores + 临时 workspace 目录。
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
import { WikiStore, SUMMARY_MAX_BYTES } from "../../src/server/wiki-node-store.js";
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

function ensureParentDir(abs: string): void {
	mkdirSync(abs.slice(0, abs.lastIndexOf(require("node:path").sep)), { recursive: true });
}

function makeCodeFile(ws: string, rel: string, content: string): void {
	const abs = join(ws, rel);
	ensureParentDir(abs);
	writeFileSync(abs, content);
}

function makeDocWithHeading(ws: string, rel: string, headingText: string): void {
	const abs = join(ws, rel);
	ensureParentDir(abs);
	writeFileSync(abs, `# ${headingText}\n\nbody\n`);
}

function makeDocWithoutHeading(ws: string, rel: string, firstParaText: string): void {
	const abs = join(ws, rel);
	ensureParentDir(abs);
	writeFileSync(abs, `${firstParaText}\n\nsome body text without hash prefix\n`);
}

function materializeHeaderCodeSummary(projectId: string, relPath: string): { nodeId: string; summary: string } {
	const root = wikiStore.ensureProjectSubtree(projectId);
	const node = wikiStore.upsertProjectNode(projectId, {
		parentId: root.id,
		type: "header",
		path: `header:${relPath}`,
		title: relPath,
		summary: "",
	});
	const summary = archivistService.ensureSummary(node.id) ?? "";
	const reloaded = wikiStore.get(node.id);
	return { nodeId: node.id, summary: reloaded?.summary ?? summary };
}

function materializeIntentDocSummary(projectId: string, relPath: string): { nodeId: string; summary: string } {
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

const ELLIPSIS = "…";

// ─── code file summary: relPath — firstComment | N 行代码 ─────────

describe("code file summary: relPath — firstComment | N 行代码 (no Head/Exports)", () => {
	test("file with a leading description comment → summary = relPath — comment", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeCodeFile(tmpDir, "foo.ts", "// Foo module: does foo things\nexport const x = 1;\n");

		const { summary } = materializeHeaderCodeSummary(proj.id, "foo.ts");
		expect(summary).toBe("foo.ts — Foo module: does foo things");
		// No Head/Exports segments (those belong in detail now).
		expect(summary).not.toContain("Head:");
		expect(summary).not.toContain("Exports:");
	});

	test("file with no usable comment → summary = relPath — N 行代码", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeCodeFile(tmpDir, "bare.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");

		const { summary } = materializeHeaderCodeSummary(proj.id, "bare.ts");
		expect(summary).toBe("bare.ts — 3 行代码");
		expect(summary).not.toContain("Exports:");
	});

	test("summary persisted on the row (expand/search read this)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeCodeFile(tmpDir, "persist.ts", "// persisted desc\n");
		const { nodeId, summary } = materializeHeaderCodeSummary(proj.id, "persist.ts");
		expect(wikiStore.get(nodeId)!.summary).toBe(summary);
	});
});

// ─── doc file: heading/firstPara truncation (>200) ──────────────

describe("doc heading/firstPara truncation marks with …", () => {
	test("heading > 200 chars → summary ends with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithHeading(tmpDir, "docs/requirements/req-long.md", "h".repeat(250));
		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-long.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
		expect(summary).toBe(`${"h".repeat(200)}${ELLIPSIS}`);
	});

	test("heading exactly 200 chars → no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithHeading(tmpDir, "docs/requirements/req-200.md", "h".repeat(200));
		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-200.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toBe("h".repeat(200));
	});

	test("firstPara > 200 chars (no heading) → summary ends with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithoutHeading(tmpDir, "docs/requirements/req-para.md", "p".repeat(300));
		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/req-para.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(true);
		expect(summary).toBe(`${"p".repeat(200)}${ELLIPSIS}`);
	});
});

// ─── marker passes through to the stored row (expand/search) ─────

describe("truncation marker passes through to expand/search source row", () => {
	test("truncated doc summary persisted with …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithHeading(tmpDir, "docs/requirements/expand-doc.md", "z".repeat(400));
		const { nodeId } = materializeIntentDocSummary(proj.id, "docs/requirements/expand-doc.md");
		const persisted = wikiStore.get(nodeId)!.summary!;
		expect(persisted.endsWith(ELLIPSIS)).toBe(true);
	});
});

// ─── short summaries: no marker ──────────────────────────────────

describe("short summaries do NOT get …", () => {
	test("short doc heading → no …", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		makeDocWithHeading(tmpDir, "docs/requirements/short.md", "short heading");
		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/short.md");
		expect(summary.endsWith(ELLIPSIS)).toBe(false);
		expect(summary).toBe("short heading");
	});

	test("empty doc (no heading, empty firstPara) → empty summary, no marker", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const abs = join(tmpDir, "docs/requirements/empty.md");
		ensureParentDir(abs);
		writeFileSync(abs, "");
		const { summary } = materializeIntentDocSummary(proj.id, "docs/requirements/empty.md");
		expect(summary).toBe("");
		expect(summary.includes(ELLIPSIS)).toBe(false);
	});
});

// ─── store-layer summary byte cap (SUMMARY_MAX_BYTES) ────────────

describe("store summary byte cap (SUMMARY_MAX_BYTES)", () => {
	test("summary > 512 bytes → truncated to ≤512 + … (ASCII)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const root = wikiStore.ensureProjectSubtree(proj.id);
		const longSummary = "a".repeat(600); // 600 ASCII bytes
		const node = wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:big.ts",
			title: "big.ts",
			summary: longSummary,
		});
		const persisted = wikiStore.get(node.id)!.summary!;
		// Content portion ≤ SUMMARY_MAX_BYTES, plus the marker.
		expect(persisted.endsWith(ELLIPSIS)).toBe(true);
		expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(SUMMARY_MAX_BYTES + Buffer.byteLength(ELLIPSIS, "utf8"));
		// The non-marker portion is exactly SUMMARY_MAX_BYTES bytes.
		expect(Buffer.byteLength(persisted.slice(0, persisted.length - ELLIPSIS.length), "utf8")).toBe(SUMMARY_MAX_BYTES);
	});

	test("UTF-8 safe: does not split a multibyte (CJK) character", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const root = wikiStore.ensureProjectSubtree(proj.id);
		// 200 CJK chars ≈ 600 UTF-8 bytes; cap 512 lands mid-character set.
		// 512 / 3 = 170.67 → 170 full CJK chars (510 bytes) fit, the 171st (3 bytes
		// → 513) does NOT, so the cut is at 170 chars + marker, no replacement char.
		const cjk = "中".repeat(200);
		const node = wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:cjk.ts",
			title: "cjk.ts",
			summary: cjk,
		});
		const persisted = wikiStore.get(node.id)!.summary!;
		expect(persisted.endsWith(ELLIPSIS)).toBe(true);
		// No U+FFFD replacement char (would indicate a split multibyte sequence).
		expect(persisted.includes("�")).toBe(false);
		// All chars before the marker are intact CJK chars.
		const body = persisted.slice(0, persisted.length - ELLIPSIS.length);
		for (const ch of body) expect(ch).toBe("中");
		expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
	});

	test("summary ≤ 512 bytes → unchanged, no marker", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: tmpDir });
		const root = wikiStore.ensureProjectSubtree(proj.id);
		const shortSummary = "short summary".repeat(10); // 140 bytes
		const node = wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:small.ts",
			title: "small.ts",
			summary: shortSummary,
		});
		expect(wikiStore.get(node.id)!.summary).toBe(shortSummary);
	});
});
