// wiki-system-redesign sub-02 acceptance — 对抗 lens (edit + section edge cases).
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-02 §A.4 / §A.5 / §A.6 (replace_text 0/1/n 区分;
// section 操作同名不同层级 / 最后一节 / 空节 / fenced code block / nested /
// ATX vs Setext / occurrence 消歧 / ambiguous 拒绝)。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db (vi.hoisted,前缀 `zc-wiki-v2-edit-`)。
//   - 每个 test 在自己的 mkdtemp 子目录开 fresh wiki.db,无跨 test 状态污染。
//
// ## 输出
// Vitest 用例。每用例开真 SQLite temp DB,绝不读活跃 ~/.zero-core。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - parser 直接依赖断言:require('package.json') 检查 dependencies 含 unified/remark-parse。
//   - 跨 lens 隔离:vi.hoisted 用唯一前缀 `zc-wiki-v2-edit-`,wiki.db 路径每 test 独有。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR, PKG } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-edit-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	// 读 package.json 同步一次,断言 parser 是直接依赖(acceptance-02 §A.6)。
	const pkg = require(join(process.cwd(), "package.json"));
	return { UNIQUE_DIR: d, PKG: pkg };
});

import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import type {
	CompiledWikiAccess,
	WikiRequestContext,
	WikiAction,
} from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wideOpenAccess(): CompiledWikiAccess {
	const allActions: WikiAction[] = [
		"expand", "read", "search", "create", "update",
		"delete", "link", "unlink", "move",
	];
	return {
		agentId: "test-agent",
		grants: [{ canonicalScope: "wiki-root", actions: allActions }],
		policyRevision: 1,
	};
}

function makeCtx(): WikiRequestContext {
	return {
		access: wideOpenAccess(),
		agentId: "test-agent",
		activeProjectId: undefined,
		sessionId: "edit-session",
		requestId: null,
	};
}

function buildService(wikiDb: WikiDatabase): WikiService {
	const db = wikiDb.getDb();
	return new WikiService({
		wikiDb,
		nodeRepo: new WikiNodeRepository(db),
		linkRepo: new WikiLinkRepository(db),
		auditRepo: new WikiAuditRepository(db),
		repositoryStore: new WikiRepositoryStore(db),
		addressService: new WikiAddressService(
			new WikiRepositoryStore(db).addresses,
			new WikiNodeRepository(db),
		),
		authorizationService: new WikiAuthorizationService(),
		editService: new WikiEditService(),
	});
}

async function createDoc(
	svc: WikiService,
	name: string,
	content: string,
): Promise<string> {
	const r = await svc.create(
		{
			parent: "wiki-root/knowledge",
			name,
			kind: "knowledge",
			summary: "",
			content,
		},
		makeCtx(),
	);
	return r.path;
}

/**
 * 读节点正文(getActiveByPath)。
 */
function readContent(db: Database.Database, path: string): string {
	const repo = new WikiNodeRepository(db);
	const row = repo.getActiveByPath(path);
	if (!row) throw new Error(`node not found at ${path}`);
	return row.content;
}

function countAudit(db: Database.Database, action: string): number {
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = ?`)
		.get(action) as { n: number };
	return row.n;
}

/**
 * 注入 source binding(模拟项目镜像 binding)—— 与 wiki-v2-move-link.test.ts 同名 helper 同语义。
 * 需要先建 repository(project_node_id RESTRICT)。
 */
function bindSource(db: Database.Database, nodeId: number): void {
	const store = new WikiRepositoryStore(db);
	const repoId = `fake-repo-edit-${nodeId}`;
	store.repositories.upsert({
		repository_id: repoId,
		project_node_id: nodeId,
		project_id: `fake-proj-edit-${nodeId}`,
	});
	store.sourceBindings.upsert({
		node_id: nodeId,
		repository_id: repoId,
		source_path: `fake/path/${nodeId}`,
		source_kind: "file",
		indexed_revision: "fake-sha-0001",
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wiki-v2 edit lens [对抗 lens — §A.4/5/6]", () => {
	let wiki: WikiDatabase;
	let db: Database.Database;
	let svc: WikiService;
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
		wiki = new WikiDatabase(join(tempDir, "wiki.db"));
		db = wiki.getDb();
		svc = buildService(wiki);
	});

	afterEach(() => {
		try { wiki.close(); } catch { /* idempotent */ }
	});

	// =========================================================================
	// §A.6 — parser 是直接依赖(acceptance-02 「parser 是直接依赖而非偶然 transitive dependency」)
	// =========================================================================

	test("parser is a DIRECT dependency: package.json lists `unified` + `remark-parse`", () => {
		// acceptance-02 §A.6:parser 是直接依赖,不是 transitive。
		// 直接断言 package.json.dependencies 含这两个包。
		expect(PKG.dependencies).toBeDefined();
		expect(PKG.dependencies.unified).toBeTruthy();
		expect(PKG.dependencies["remark-parse"]).toBeTruthy();
		// devDependencies 不算 direct runtime dep —— 必须在 dependencies。
		const inDevOnly =
			PKG.devDependencies?.unified && !PKG.dependencies?.unified;
		expect(inDevOnly).toBeFalsy();
		const inDevOnly2 =
			PKG.devDependencies?.["remark-parse"] && !PKG.dependencies?.["remark-parse"];
		expect(inDevOnly2).toBeFalsy();
	});

	// =========================================================================
	// §A.4 — replace_text 区分 0 / 1 / 多次
	// =========================================================================

	describe("§A.4 replace_text distinguishes 0 / 1 / n occurrences", () => {
		test("0 hits → EDIT_TARGET_NOT_FOUND; node untouched; audit has NO new update", async () => {
			const path = await createDoc(svc, "rt-empty", "hello world\nhello again");
			const auditBefore = countAudit(db, "update");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_text", old_text: "nope-not-here", new_text: "X" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_NOT_FOUND" });

			// node 完全不变
			expect(readContent(db, path)).toBe("hello world\nhello again");
			expect(new WikiNodeRepository(db).getActiveByPath(path)!.revision).toBe(revBefore);
			// audit 未新增 update
			expect(countAudit(db, "update")).toBe(auditBefore);
		});

		test("1 hit → success; content replaced; revision +1; audit row present", async () => {
			const path = await createDoc(svc, "rt-single", "alpha beta gamma");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;
			const auditBefore = countAudit(db, "update");

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_text", old_text: "beta", new_text: "BETA" },
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.revision).toBe(revBefore + 1);
			expect(readContent(db, path)).toBe("alpha BETA gamma");
			expect(countAudit(db, "update")).toBe(auditBefore + 1);
		});

		test("n hits WITHOUT expected_occurrences → EDIT_TARGET_AMBIGUOUS; content unchanged", async () => {
			const content = "todo: redo todo list and then todo again";
			const path = await createDoc(svc, "rt-multi", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;
			const auditBefore = countAudit(db, "update");

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_text", old_text: "todo", new_text: "DONE" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_AMBIGUOUS" });

			expect(readContent(db, path)).toBe(content);
			expect(new WikiNodeRepository(db).getActiveByPath(path)!.revision).toBe(revBefore);
			expect(countAudit(db, "update")).toBe(auditBefore);
		});

		test("n hits WITH expected_occurrences=n → all replaced", async () => {
			const path = await createDoc(svc, "rt-multi-ok", "x x x x");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_text", old_text: "x", new_text: "Y", expected_occurrences: 4 },
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(readContent(db, path)).toBe("Y Y Y Y");
		});

		test("expected_occurrences mismatch (declared 2, found 3) → WRITE_CONFLICT", async () => {
			const path = await createDoc(svc, "rt-mismatch", "k k k");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_text", old_text: "k", new_text: "Z", expected_occurrences: 2 },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
			// 整体 transaction 回滚 → content 不变
			expect(readContent(db, path)).toBe("k k k");
		});

		test("empty old_text → INVALID_REQUEST", async () => {
			const path = await createDoc(svc, "rt-empty-old", "anything");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [{ op: "replace_text", old_text: "", new_text: "X" }],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		});
	});

	// =========================================================================
	// §A.5/§A.6 — section 操作 oracle:同名不同层级 / 最后一节 / 空节 /
	//             fenced code block / nested heading / ATX vs Setext
	// =========================================================================

	describe("§A.5 section ops: same-name different-level, last section, empty section, fenced code", () => {
		test("replace_section handles same-name different-level via level disambiguation", async () => {
			// 两个同名 "Notes" 节,一个 H2 一个 H3 —— 必须用 level 消歧。
			// 注意:H3 nested 在 H2 节里(下一同级 H2 前),所以替换 H2 节会把
			// H3 内容一起换掉。此测试断言:用 level=3 单独定位 H3,只动 H3 节。
			const content = [
				"# Top",
				"",
				"## Notes",
				"",
				"top-level notes",
				"",
				"### Notes",
				"",
				"deeper notes",
				"",
				"## Other",
				"",
				"other body",
			].join("\n");
			const path = await createDoc(svc, "sec-samename-level", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			// 用 level=3 精确替换 H3 "Notes"(nested 那节)
			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{
							op: "replace_section",
							section: "Notes",
							level: 3,
							new_text: "### Notes\n\nREPLACED-DEEPER",
						},
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);

			const after = readContent(db, path);
			// H3 节被替换
			expect(after).toContain("REPLACED-DEEPER");
			expect(after).not.toContain("deeper notes");
			// H2 节未动(top-level notes 仍在)
			expect(after).toContain("top-level notes");
			// 后续同级 H2 "Other" 未动
			expect(after).toContain("other body");
		});

		test("replace_section same-name same-level multi-occurrence → occurrence disambiguates", async () => {
			// 同名同级的多个节,用 occurrence 取第 N 个。
			const content = [
				"# Doc",
				"",
				"## Item",
				"",
				"first item body",
				"",
				"## Item",
				"",
				"second item body",
				"",
				"## Item",
				"",
				"third item body",
			].join("\n");
			const path = await createDoc(svc, "sec-occurrence", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{
							op: "replace_section",
							section: "Item",
							occurrence: 2,
							new_text: "## Item\n\nSECOND-REPLACED",
						},
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			expect(after).toContain("first item body"); // 第 1 节未动
			expect(after).toContain("SECOND-REPLACED");
			expect(after).not.toContain("second item body");
			expect(after).toContain("third item body"); // 第 3 节未动
		});

		test("replace_section WITHOUT disambiguation when same-name ambiguous → EDIT_TARGET_AMBIGUOUS", async () => {
			const content = [
				"# Doc",
				"",
				"## Item",
				"",
				"one",
				"",
				"## Item",
				"",
				"two",
			].join("\n");
			const path = await createDoc(svc, "sec-ambig", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;
			const auditBefore = countAudit(db, "update");

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{
								op: "replace_section",
								section: "Item",
								new_text: "## Item\n\nX",
							},
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_AMBIGUOUS" });

			// 内容不变
			expect(readContent(db, path)).toBe(content);
			expect(countAudit(db, "update")).toBe(auditBefore);
		});

		test("replace_section NOT FOUND when section name absent → EDIT_TARGET_NOT_FOUND", async () => {
			const path = await createDoc(svc, "sec-notfound", "# A\n\ntext\n");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_section", section: "Missing", new_text: "## Missing\n\nx" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_NOT_FOUND" });
		});

		test("replace_section LAST section (no following heading) replaced to EOF", async () => {
			const content = "# A\n\nfirst\n\n# B\n\nlast section body\n";
			const path = await createDoc(svc, "sec-last", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_section", section: "B", new_text: "# B\n\nNEW LAST" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			expect(after).toContain("NEW LAST");
			expect(after).not.toContain("last section body");
			expect(after).toContain("first"); // A 节未动
		});

		test("replace_section EMPTY section body (just heading + next heading)", async () => {
			const content = "# A\n\n# B\n\nhas content\n";
			const path = await createDoc(svc, "sec-empty", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			// A 是空节(紧接 B)
			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_section", section: "A", new_text: "# A\n\nfilled in" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			expect(after).toContain("filled in");
			expect(after).toContain("has content"); // B 节未动
		});

		test("fenced code block '#' is NOT a heading (replace_section only touches real heading)", async () => {
			// 关键:```block 内的 `# NotAHeading` 不参与 heading 列表(acceptance-02 §A.5)。
			const content = [
				"# Real Heading",
				"",
				"Some text",
				"",
				"```",
				"# NotAHeading",
				"",
				"more code",
				"```",
				"",
				"trailing",
			].join("\n");
			const path = await createDoc(svc, "sec-fenced", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			// "NotAHeading" 不应被视为 section 名 —— 应 NOT_FOUND。
			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_section", section: "NotAHeading", new_text: "## NotAHeading\n\nX" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_NOT_FOUND" });

			// "Real Heading" 仍可定位 —— 证明 fenced 内的 # 没有把它"挤掉"
			// 或混淆 parser。我们用一个保守的 new_text,只替换 H1 节的开头部分
			// (section 范围到 EOF,所以 fenced block 也会被换掉 —— 这是预期行为;
			// 这里验证的目标是 parser 识别 Real Heading 为唯一 H1)。
			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_section", section: "Real Heading", new_text: "# Real Heading\n\nreplaced" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			expect(after).toContain("replaced");
			// 验证 parser 没有把 fenced block 内的 # NotAHeading 当 heading:
			// 如果它被当作 heading,那 NotAHeading 应在第一次 replace_section 时
			// 命中(上面已经断言 NOT_FOUND)。这里再次确认 Real Heading 是唯一 H1
			// section —— 解析后内容只剩 # Real Heading(因为 fenced 已被换掉)。
			expect(after.trim()).toBe("# Real Heading\n\nreplaced");
		});

		test("nested heading: deeper heading content stays within parent section", async () => {
			// parent section "A" 包含 child heading "B"。删除 A 时,B 也应随之被删
			// (因为 B 在 A 的 section 范围内:下一同级 H1 前)。
			const content = [
				"# A",
				"",
				"a intro",
				"",
				"## B",
				"",
				"b body",
				"",
				"# C",
				"",
				"c body",
			].join("\n");
			const path = await createDoc(svc, "sec-nested", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [{ op: "delete_section", section: "A" }],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			// 整个 A 节(含 nested B)被删
			expect(after).not.toContain("a intro");
			expect(after).not.toContain("## B");
			expect(after).not.toContain("b body");
			// C 节保留
			expect(after).toContain("c body");
		});

		test("ATX (#) and Setext (===) headings both recognized as level-1 sections", async () => {
			const content = [
				"ATX Style",
				"==========",
				"",
				"under atx",
				"",
				"# Hash Style",
				"",
				"under hash",
			].join("\n");
			const path = await createDoc(svc, "sec-atx-setext", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			// Setext 第一行 "ATX Style" 应被识别为 H1 heading,section name = "ATX Style"。
			const r1 = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_section", section: "ATX Style", new_text: "ATX Style\n==========\n\nREPLACED-SETTEXT" },
					],
				},
				makeCtx(),
			);
			expect(r1.success).toBe(true);

			const after1 = readContent(db, path);
			expect(after1).toContain("REPLACED-SETTEXT");
			expect(after1).not.toContain("under atx");
			expect(after1).toContain("under hash"); // Hash Style 节未动
		});
	});

	// =========================================================================
	// §A.5 — append_to_section / insert_before / insert_after oracles
	// =========================================================================

	describe("§A.5 append_to_section / insert_before / insert_after", () => {
		test("append_to_section inserts text at end of section (before next heading)", async () => {
			const content = [
				"# A",
				"",
				"a body line 1",
				"",
				"# B",
				"",
				"b body",
			].join("\n");
			const path = await createDoc(svc, "ats-basic", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "append_to_section", section: "A", text: "appended to A" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);

			const after = readContent(db, path);
			// appended content 应位于 A 节末尾(# B 之前)
			const aIdx = after.indexOf("a body line 1");
			const appendedIdx = after.indexOf("appended to A");
			const bIdx = after.indexOf("# B");
			expect(aIdx).toBeGreaterThan(-1);
			expect(appendedIdx).toBeGreaterThan(aIdx);
			expect(bIdx).toBeGreaterThan(appendedIdx);
		});

		test("append_to_section LAST section appends to EOF", async () => {
			const content = "# A\n\nintro\n\n# B\n\nlast body\n";
			const path = await createDoc(svc, "ats-last", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "append_to_section", section: "B", text: "tail content" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toContain("tail content");
		});

		test("insert_before anchor 1 hit → inserted before anchor", async () => {
			const path = await createDoc(svc, "ib-1", "alpha bravo charlie bravo delta");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "insert_before", anchor: "charlie", text: "INSERTED-" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toBe("alpha bravo INSERTED-charlie bravo delta");
		});

		test("insert_after anchor 1 hit → inserted after anchor", async () => {
			const path = await createDoc(svc, "ia-1", "alpha bravo charlie");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "insert_after", anchor: "bravo", text: "-AFTER" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toBe("alpha bravo-AFTER charlie");
		});

		test("insert_before anchor 0 hits → EDIT_TARGET_NOT_FOUND", async () => {
			const path = await createDoc(svc, "ib-0", "alpha bravo");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "insert_before", anchor: "zulu", text: "X" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_NOT_FOUND" });
		});

		test("insert_before anchor n hits → EDIT_TARGET_AMBIGUOUS", async () => {
			const path = await createDoc(svc, "ib-n", "x x x");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "insert_before", anchor: "x", text: "Y" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_AMBIGUOUS" });
		});

		test("insert_after anchor within section resolves correctly", async () => {
			const content = "# Sec\n\nthe cat sat on the mat\n";
			const path = await createDoc(svc, "ia-sec", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			// 在 Sec section 内 insert_after "cat"
			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{
							op: "insert_after",
							anchor: "cat",
							anchor_section: "Sec",
							text: "-FOUND",
						},
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toContain("cat-FOUND sat");
		});
	});

	// =========================================================================
	// §A.5/§A.6 — append / prepend ops + 多 op 同 transaction
	// =========================================================================

	describe("append/prepend + multi-op transactional semantics", () => {
		test("append adds to EOF with newline separator", async () => {
			const path = await createDoc(svc, "ap-basic", "line1\nline2");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [{ op: "append", text: "line3" }],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toBe("line1\nline2\nline3");
		});

		test("prepend adds at BOF with newline separator", async () => {
			const path = await createDoc(svc, "pp-basic", "line2\nline3");
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [{ op: "prepend", text: "line1" }],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			expect(readContent(db, path)).toBe("line1\nline2\nline3");
		});

		test("multi-op: replace_text + append_to_section in ONE revision-bump transaction", async () => {
			const content = "# A\n\na body OLD\n";
			const path = await createDoc(svc, "multi-op", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_text", old_text: "OLD", new_text: "NEW" },
						{ op: "append_to_section", section: "A", text: "extra line" },
					],
				},
				makeCtx(),
			);
			expect(result.success).toBe(true);
			// 同 transaction 内 revision 只 +1 一次
			expect(result.revision).toBe(revBefore + 1);

			const after = readContent(db, path);
			expect(after).toContain("a body NEW");
			expect(after).toContain("extra line");
		});

		test("multi-op: 2nd op fails → entire transaction rolled back, NO partial update", async () => {
			const content = "# A\n\na body\n";
			const path = await createDoc(svc, "multi-op-fail", content);
			const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;
			const auditBefore = countAudit(db, "update");

			// 1st op 会成功,2nd op 引用不存在的 section → NOT_FOUND → 整体回滚。
			await expect(
				svc.update(
					{
						address: path,
						expected_revision: revBefore,
						operations: [
							{ op: "replace_text", old_text: "a body", new_text: "WAS-CHANGED" },
							{ op: "append_to_section", section: "Missing", text: "x" },
						],
					},
					makeCtx(),
				),
			).rejects.toMatchObject({ code: "EDIT_TARGET_NOT_FOUND" });

			// 完全回滚:content 不变,revision 不 bump,audit 不新增
			expect(readContent(db, path)).toBe(content);
			expect(new WikiNodeRepository(db).getActiveByPath(path)!.revision).toBe(revBefore);
			expect(countAudit(db, "update")).toBe(auditBefore);
		});
	});

	// =========================================================================
	// §A.4/§A.5 — FTS 在 edit 后同步(transactional index update)
	// =========================================================================

	test("edit operations sync FTS within the same transaction (NEW tokens queryable, OLD gone)", async () => {
		const path = await createDoc(svc, "fts-edit", "old alphaTokenHere");
		const repo = new WikiNodeRepository(db);
		const id = repo.getActiveByPath(path)!.id;
		const revBefore = repo.getActiveByPath(path)!.revision;

		// 旧 token 可查(用 FTS5 phrase 语法,避免 token 被 split)
		expect(repo.searchFts('"alphaTokenHere"', 10).some((r) => r.id === id)).toBe(true);

		await svc.update(
			{
				address: path,
				expected_revision: revBefore,
				operations: [
					{ op: "replace_text", old_text: "alphaTokenHere", new_text: "betaTokenFresh" },
				],
			},
			makeCtx(),
		);

		// 新 token 可查
		expect(repo.searchFts('"betaTokenFresh"', 10).some((r) => r.id === id)).toBe(true);
		// 旧 token 不再可查(FTS resynced in same transaction)
		expect(repo.searchFts('"alphaTokenHere"', 10).some((r) => r.id === id)).toBe(false);
	});

	// =========================================================================
	// §A.4 — expected_revision mismatch on edit ops → WRITE_CONFLICT, no partial update
	// =========================================================================

	test("edit ops with WRONG expected_revision → WRITE_CONFLICT, no write", async () => {
		const path = await createDoc(svc, "edit-conflict", "anchor-target");
		const auditBefore = countAudit(db, "update");
		const revBefore = new WikiNodeRepository(db).getActiveByPath(path)!.revision;

		await expect(
			svc.update(
				{
					address: path,
					expected_revision: revBefore + 99, // wrong
					operations: [
						{ op: "replace_text", old_text: "anchor-target", new_text: "changed" },
					],
				},
				makeCtx(),
			),
		).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

		expect(readContent(db, path)).toBe("anchor-target");
		expect(countAudit(db, "update")).toBe(auditBefore);
	});

	// =========================================================================
	// FIX 3 (round-2) — source-bound 节点的 summary/content/attributes/局部 edit
	//                     SUCCEED(design §6.3「普通 Agent 可以更新 summary/content/links」)
	//                     仅 structural(parent_id/path/name/kind)→ SOURCE_MANAGED。
	//                     update() patch 当前只承载 summary/content/attributes_json,
	//                     所以正常路径不触发 SOURCE_MANAGED —— 此 block 锁定该放松语义。
	// =========================================================================

	describe("FIX 3 source-bound node: summary/content/attributes/section edits SUCCEED", () => {
		test("replace_text on source-bound node SUCCEEDS (content enrichment allowed)", async () => {
			const path = await createDoc(svc, "sb-edit-rt", "alpha beta gamma");
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			bindSource(db, row.id);
			const revBefore = row.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_text", old_text: "beta", new_text: "BETA" },
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.revision).toBe(revBefore + 1);
			expect(readContent(db, path)).toBe("alpha BETA gamma");
		});

		test("replace_section on source-bound node SUCCEEDS", async () => {
			const content = "# A\n\nbody OLD\n";
			const path = await createDoc(svc, "sb-edit-sec", content);
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			bindSource(db, row.id);
			const revBefore = row.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_section", section: "A", new_text: "# A\n\nbody NEW" },
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(readContent(db, path)).toContain("body NEW");
			expect(readContent(db, path)).not.toContain("body OLD");
		});

		test("summary / content / attributes patch on source-bound node SUCCEEDS (all non-structural)", async () => {
			const path = await createDoc(svc, "sb-edit-patch", "orig content");
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			bindSource(db, row.id);
			const revBefore = row.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					changes: {
						summary: "new summary",
						content: "new content",
						attributes: { display_name: "New Name", tag: "x" },
					},
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.revision).toBe(revBefore + 1);

			const after = repo.getActiveByPath(path)!;
			expect(after.summary).toBe("new summary");
			expect(after.content).toBe("new content");
			const attrs = JSON.parse(after.attributes_json ?? "{}");
			expect(attrs.display_name).toBe("New Name");
			expect(attrs.tag).toBe("x");
		});

		test("multi-op (replace_text + append_to_section) on source-bound node SUCCEEDS atomically", async () => {
			const path = await createDoc(svc, "sb-edit-multi", "# A\n\na body\n");
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			bindSource(db, row.id);
			const revBefore = row.revision;

			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					operations: [
						{ op: "replace_text", old_text: "a body", new_text: "A BODY" },
						{ op: "append_to_section", section: "A", text: "extra" },
					],
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			expect(result.revision).toBe(revBefore + 1);
			const after = readContent(db, path);
			expect(after).toContain("A BODY");
			expect(after).toContain("extra");
		});

		test("attributes null-clear on source-bound node SUCCEEDS (attributes is non-structural)", async () => {
			// attributes patch 用 null 删 key —— 应该 work on source-bound。
			const path = await createDoc(svc, "sb-edit-attr-null", "x");
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			// 先注入一个 attribute
			await svc.update(
				{
					address: path,
					expected_revision: row.revision,
					changes: { attributes: { keep: "k", drop: "d" } },
				},
				makeCtx(),
			);
			const row2 = repo.getActiveByPath(path)!;
			bindSource(db, row2.id);
			const revBefore = row2.revision;

			// null 删 drop key —— source-bound 上应成功
			const result = await svc.update(
				{
					address: path,
					expected_revision: revBefore,
					changes: { attributes: { drop: null } },
				},
				makeCtx(),
			);

			expect(result.success).toBe(true);
			const attrs = JSON.parse(repo.getActiveByPath(path)!.attributes_json ?? "{}");
			expect(attrs.keep).toBe("k");
			expect(attrs.drop).toBeUndefined();
		});

		test("FTS synced after edit on source-bound node (NEW token queryable, OLD gone)", async () => {
			const path = await createDoc(svc, "sb-edit-fts", "old sbFtsTokenHere");
			const repo = new WikiNodeRepository(db);
			const row = repo.getActiveByPath(path)!;
			const id = row.id;
			bindSource(db, id);
			expect(repo.searchFts('"sbFtsTokenHere"', 10).some((r) => r.id === id)).toBe(true);

			await svc.update(
				{
					address: path,
					expected_revision: row.revision,
					operations: [
						{ op: "replace_text", old_text: "sbFtsTokenHere", new_text: "sbFtsFreshToken" },
					],
				},
				makeCtx(),
			);

			expect(repo.searchFts('"sbFtsFreshToken"', 10).some((r) => r.id === id)).toBe(true);
			expect(repo.searchFts('"sbFtsTokenHere"', 10).some((r) => r.id === id)).toBe(false);
		});
	});
});
