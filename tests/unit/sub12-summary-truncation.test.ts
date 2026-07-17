// summary store-layer byte cap (SUMMARY_MAX_BYTES) — legacy WikiStore.
//
// # 文件说明书
//
// ## 核心功能
// 验证 legacy WikiStore (wiki-node-store.ts) 的 summary 字节上限:
//   - 写入 > SUMMARY_MAX_BYTES(512)→ 截到 512 + `…`,UTF-8 安全(不截断多字节)。
//   - 写入 ≤ 512 → 原样,无标记。
//
// ## 上下文(为何只剩这一块)
// sub-03 (wiki-system-redesign) 把 archivist 扫描职责迁到 WikiProjectIndexer
// (写新 wiki.db)。旧的 readdir 扫描 + summarizeCodeFile / summarizeDocFile /
// ensureSummary lazy-materialization 全部移除:
//   - WikiSkeletonService.ensureSummary 现在是只读 no-op(返回 undefined)。
//   - summarizeCodeFile / summarizeDocFile 已从 src/ 删除(grep 0 matches)。
// 所以原 sub12 中"经 ensureSummary 触发真实 summarize\* 验内容策略"的用例
// 全部 dead —— 由 wiki-v2-indexer/sync 测试覆盖新确定性 summary。
//
// 唯一仍 live 的是 legacy WikiStore 的 store-layer 字节上限(在 wiki-node-store.ts
// upsertProjectNode + update 路径强制,SUMMARY_MAX_BYTES 仍被 wiki-anchor-injection /
// wiki-tool / wiki-node-store 使用)。保留这块避免 coverage 丢失。
//
// ## BLOCKER 6 fix (round-2 架构 lens)
// 原 sub12 import 了被删除的 wiki-scan-cursor-store + 用旧 deps 形状({wikiStore,
// cursorStore,...})构造 WikiSkeletonService → npm run test:unit import error。
// 本文件移除所有 cursorStore / archivistService 依赖,只保留 byte-cap 直测 WikiStore。
//
// ## 输入 / 输出
// 临时 CoreDatabase + 真 WikiStore。Vitest 用例。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { WikiStore, SUMMARY_MAX_BYTES } from "../../src/server/wiki-node-store.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: CoreDatabase;
let wikiStore: WikiStore;
let projectStore: ProjectStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub12-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

const ELLIPSIS = "…";

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
