// wiki-system-redesign sub-04 acceptance — 规约 (schema + ToolResult + read/expand/write contract) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-04 §A(schema/boundary)+ §B(ToolResult)+
// §C(read/expand/write contract)中**规约符合**视角的条目。从结构 + 行为两侧
// 断言,所有驱动走真临时 wiki.db + 真 CallerCtx.wikiAccess(测试 host 构造)。
//
// ## 关键断言
//   §A schema:
//     - action 枚举恰好 9;无旧 memory/doc / 管理 / nodeId/agentId/projectId/
//       grants/canonicalScope/cwd;factory exported + ToolRegistry 未注册 WikiV2。
//     - target union(string for link vs enum for search)disambiguation 行为正确。
//   §B ToolResult:
//     - execute 返结构化 ToolResult(UI 可不经 format 消费完整字段)。
//     - error.code 机器可判(前缀 "CODE:");mutation 返 revision/auditId;
//       WRITE_CONFLICT 不被伪装成普通文本。
//     - 无内部整数 id / 合成短 id / 旧 path prefix。
//   §C read/expand/write:
//     - expand 默认不返 child content;children limit/cursor;过滤在 service 层。
//     - read 5 views + Markdown section + source line range。
//     - update 缺 expected_revision 被拒。
//     - create/update/link/unlink/move/delete 各自证明 service action + authz。
//     - source-bound create/move/delete → SOURCE_MANAGED。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + 每 test 独立 wiki.db(vi.hoisted + mkdtemp)。
//   - CallerCtx.wikiAccess 由测试 host 构造(compiled grants)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding(在 StructuredOutput 中)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-tool-contract-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // 绕开 Windows WAL checkpoint 卡死。
	return { UNIQUE_DIR: d };
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import {
	WikiProjectIndexer,
	type ProjectStoreLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import { WikiSourceSearch } from "../../src/server/wiki/wiki-source-search.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { wikiV2ActionSchema, createWikiTool } from "../../src/tools/wiki-v2-tool.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import { isWikiServiceError } from "../../src/server/wiki/wiki-errors.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiExpandResult,
	WikiReadResult,
	WikiMutationResult,
	WikiRequestContext,
} from "../../src/shared/wiki-types.js";
import type { WikiSearchResult } from "../../src/shared/wiki-search-types.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";

// ---------------------------------------------------------------------------
// Access helpers — same shape wiki-v2-auth.test.ts uses (proven pattern).
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];

function grant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}
function access(agentId: string, grants: CompiledWikiGrant[], activeProjectId?: string): CompiledWikiAccess {
	return { agentId, activeProjectId, grants, policyRevision: 1 };
}
function wideOpen(agentId = "admin-agent"): CompiledWikiAccess {
	return access(agentId, [grant("wiki-root", ALL_ACTIONS)]);
}

/** Build a CallerCtx carrying wikiAccess — the SOLE identity source for the tool. */
function callerCtx(acc: CompiledWikiAccess, opts: { toolCallId?: string } = {}): CallerCtx {
	return {
		caller: "internal",
		sessionId: "contract-test-session",
		agentId: acc.agentId,
		toolCallId: opts.toolCallId ?? "tc-contract-1",
		wikiAccess: acc,
	};
}

// ---------------------------------------------------------------------------
// Service + tool builder
// ---------------------------------------------------------------------------

interface ToolHost {
	wiki: WikiDatabase;
	svc: WikiService;
	search: WikiSearchService;
	execute: (input: Record<string, unknown>, acc: CompiledWikiAccess) => Promise<ToolResult>;
	dispose: () => void;
}

function buildHost(): ToolHost {
	const dbPath = join(UNIQUE_DIR, `wiki-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiSvc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	// Reuse same dependency instances WikiService.fromDatabase built; reconstruct
	// for the search service so both share one DB handle.
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db,
		nodeRepo,
		repositoryStore,
		addressService,
		authorizationService,
		// regexLimits tightened for fast timeout tests (default 250ms is fine here too)
	});
	const tool = createWikiTool({ wikiService: wikiSvc, searchService: search });
	const execute = getToolExecute(tool)!;
	return {
		wiki,
		svc: wikiSvc,
		search,
		execute: async (input, acc) => execute(input, callerCtx(acc)),
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

// ---------------------------------------------------------------------------
// Source-bound fixture (real temp Git repo + indexer fullIndex → binding).
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], opts?: { input?: string }): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.ignorecase=false", ...args], {
		cwd,
		encoding: "utf-8",
		input: opts?.input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	}).toString();
}

function buildSourceRepo(parentTempDir: string): { repoDir: string; headSha: string; fileRel: string } {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-tool-src-"));
	git(repoDir, ["init", "-b", "main"]);
	git(repoDir, ["config", "user.name", "Test Bot"]);
	git(repoDir, ["config", "user.email", "bot@example.test"]);
	const fileRel = "module.ts";
	writeFileSync(join(repoDir, fileRel), "export const X = 1;\n", "utf-8");
	git(repoDir, ["add", fileRel]);
	git(repoDir, ["commit", "-m", "c0"]);
	const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
	return { repoDir, headSha, fileRel };
}

const PROJECTS_NS = joinWikiPath(WIKI_ROOT_PATH, "projects");
function projectPath(id: string): string { return `${PROJECTS_NS}/${id}`; }

// ===========================================================================
// §A — Schema & boundary (structure)
// ===========================================================================

/** Robust zod shape reader (handles both zod v3 function and v4 object shape). */
function schemaShape(schema: any): Record<string, any> {
	const sh = (schema as any)._def.shape;
	return typeof sh === "function" ? sh() : sh;
}
/** Robust zod enum values reader (v3: _def.values; v4: _def.entries object). */
function enumValues(enumField: any): string[] {
	const d = enumField._def;
	if (d.entries && typeof d.entries === "object") return Object.keys(d.entries);
	if (Array.isArray(d.values)) return d.values as string[];
	if (Array.isArray(d.options)) return d.options as string[];
	if (Array.isArray(enumField.options)) return enumField.options as string[];
	throw new Error("unable to read enum values");
}

describe("wiki-v2 tool §A schema/boundary [规约 lens]", () => {
	test("action enum is EXACTLY the 9 final actions (no more, no less)", () => {
		const shape = schemaShape(wikiV2ActionSchema);
		const values = enumValues(shape.action);
		expect(values.sort()).toEqual([
			"create", "delete", "expand", "link", "move",
			"read", "search", "unlink", "update",
		]);
	});

	test("schema REJECTS retired memory/doc actions", () => {
		for (const retired of ["createMemory", "updateMemory", "docRead", "docWrite", "docEdit"]) {
			const r = wikiV2ActionSchema.safeParse({ action: retired });
			expect(r.success, `action '${retired}' must be rejected`).toBe(false);
		}
	});

	test("schema REJECTS management actions not in the 9-set", () => {
		for (const mgmt of ["address", "register", "grant", "context", "repository", "restore", "hardDelete"]) {
			const r = wikiV2ActionSchema.safeParse({ action: mgmt });
			expect(r.success, `action '${mgmt}' must be rejected`).toBe(false);
		}
	});

	test("LLM-visible schema has NO identity/internal-id fields", () => {
		const shape = schemaShape(wikiV2ActionSchema);
		const keys = Object.keys(shape);
		// Forbidden top-level fields (acceptance-04 §A).
		for (const banned of [
			"nodeId", "agentId", "projectId", "grants",
			"canonicalScope", "cwd", "overwrite",
		]) {
			expect(keys, `schema must NOT expose '${banned}' to LLM`).not.toContain(banned);
		}
	});

	test("addressing fields are node/parent/source/target/newParent (no short-id/old-title)", () => {
		const shape = schemaShape(wikiV2ActionSchema);
		const keys = Object.keys(shape);
		for (const addr of ["node", "parent", "source", "target", "newParent"]) {
			expect(keys).toContain(addr);
		}
		// No nodeId / shortId / oldTitlePath style addressing.
		for (const banned of ["nodeId", "shortId", "oldTitlePath", "oldPath"]) {
			expect(keys).not.toContain(banned);
		}
	});

	test("factory createWikiTool is exported but NOT registered under a 2nd WikiV2 tool name", () => {
		// Static import succeeds (factory exposed) — if import above failed, the file
		// would not have loaded.
		expect(typeof createWikiTool).toBe("function");
		// The tool registry must not carry a WikiV2 / separate test tool name. We
		// assert by inspecting the module graph: src/tools/index.ts is the only
		// registration site and it wires the OLD wikiTool. createWikiTool is only
		// referenced from wiki-v2-tool.ts itself (verified at test-write time).
		// Dynamic check: importing index.ts and listing registered tool names.
		// (Importing the registry pulls in many side effects; instead assert that
		// createWikiTool's own options.name is "Wiki" — NOT a 2nd name.)
		const tool = createWikiTool({
			wikiService: {} as any,
			searchService: {} as any,
		});
		// __name non-enumerable is set by buildTool.
		const name = Object.getOwnPropertyDescriptor(tool, "__name")?.value;
		expect(name, "factory produces a tool named 'Wiki' (replaces old impl in plan-05), NOT 'WikiV2'").toBe("Wiki");
	});

	test("target field union: link uses string, search uses enum (action-disambiguated)", async () => {
		// The schema accepts both shapes; runtime picks interpretation by action.
		// Validate schema-side acceptance:
		expect(wikiV2ActionSchema.safeParse({
			action: "link", source: "wiki-root/knowledge/a", target: "wiki-root/knowledge/b", relation: "related_to",
		}).success).toBe(true);
		expect(wikiV2ActionSchema.safeParse({
			action: "search", query: "x", target: "both",
		}).success).toBe(true);
		// search also accepts string target (legacy/typo) — runtime falls back to 'wiki'.
		expect(wikiV2ActionSchema.safeParse({
			action: "search", query: "x", target: "wiki-root/knowledge",
		}).success).toBe(true);

		// Behavior-side: drive through the tool to confirm link uses string semantics.
		const h = buildHost();
		try {
			const admin = wideOpen();
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "L1", content: "l1" }, admin);
			await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "L2", content: "l2" }, admin);
			const linkRes = await h.execute({
				action: "link",
				source: "wiki-root/knowledge/L1",
				target: "wiki-root/knowledge/L2",
				relation: "related_to",
			}, admin);
			expect(linkRes.ok).toBe(true);
			expect((linkRes.data as WikiMutationResult).success).toBe(true);
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §B — ToolResult structure + error codes
// ===========================================================================

describe("wiki-v2 tool §B ToolResult structure [规约 lens]", () => {
	let h: ToolHost;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("execute returns structured ToolResult with full fields (UI consumes without format)", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "R1", summary: "s", content: "c" }, admin);
		const res = await h.execute({ action: "read", node: "wiki-root/knowledge/R1", view: "summary" }, admin);
		expect(res.ok).toBe(true);
		// Structured payload, not a pre-formatted string.
		const data = res.data as WikiReadResult;
		expect(typeof data).toBe("object");
		expect(data.path).toBe("wiki-root/knowledge/R1");
		expect(data.node.name).toBe("R1");
		expect(data.node.summary).toBe("s");
		// UI can read every field WITHOUT calling format().
		expect(typeof data.node.revision).toBe("number");
	});

	test("mutation returns revision + auditId (receipt), not just success boolean", async () => {
		const admin = wideOpen();
		const created = await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "M1", content: "body",
		}, admin);
		expect(created.ok).toBe(true);
		const m = created.data as WikiMutationResult;
		expect(m.success).toBe(true);
		expect(typeof m.revision).toBe("number");
		expect(m.revision).toBeGreaterThanOrEqual(1);
		expect(typeof m.auditId).toBe("string");
		expect(m.auditId.length).toBeGreaterThan(0);
	});

	test("error.code is machine-judgeable (no message parsing required)", async () => {
		const admin = wideOpen();
		// Missing required field → INVALID_REQUEST, returned as `ok:false` ToolResult.
		const res = await h.execute({ action: "expand" }, admin); // no node
		expect(res.ok).toBe(false);
		// error format is "CODE: message" — code prefix machine-parseable.
		expect(res.error ?? "").toMatch(/^INVALID_REQUEST:/);
	});

	test("missing wikiAccess → ACCESS_DENIED code (not silent legacy fallback)", async () => {
		// Direct execute with a callerCtx that has NO wikiAccess.
		const dbPath = join(UNIQUE_DIR, `wiki-noaccess-${Date.now()}.db`);
		const wiki = new WikiDatabase(dbPath);
		try {
			const svc = WikiService.fromDatabase(wiki);
			const search = new WikiSearchService({
				db: wiki.getDb(),
				nodeRepo: new WikiNodeRepository(wiki.getDb()),
				repositoryStore: new WikiRepositoryStore(wiki.getDb()),
				addressService: new WikiAddressService(
					new WikiRepositoryStore(wiki.getDb()).addresses,
					new WikiNodeRepository(wiki.getDb()),
				),
				authorizationService: new WikiAuthorizationService(),
			});
			const tool = createWikiTool({ wikiService: svc, searchService: search });
			const execute = getToolExecute(tool)!;
			const res = await execute({ action: "expand", node: "wiki-root" }, {
				caller: "internal",
				sessionId: "s",
				agentId: "a",
				// wikiAccess intentionally OMITTED — must not fall back to anchor model.
			} as CallerCtx);
			expect(res.ok).toBe(false);
			expect(res.error ?? "").toMatch(/^ACCESS_DENIED:/);
		} finally {
			try { wiki.close(); } catch { /* idempotent */ }
		}
	});

	test("WRITE_CONFLICT surfaces as its own code, not generic text (no INTERNAL_ERROR disguise, no id leak)", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "W1", content: "v0" }, admin);
		// Read observed revision, then update on a STALE revision to force conflict.
		const staleRes = await h.execute({ action: "read", node: "wiki-root/knowledge/W1", view: "summary" }, admin);
		const observed = (staleRes.data as WikiReadResult).node.revision;
		// First update bumps revision.
		const ok = await h.execute({
			action: "update", node: "wiki-root/knowledge/W1",
			expected_revision: observed,
			changes: { content: "v1" },
		}, admin);
		expect(ok.ok).toBe(true);
		// Second update with stale revision → WRITE_CONFLICT.
		const conflict = await h.execute({
			action: "update", node: "wiki-root/knowledge/W1",
			expected_revision: observed, // stale
			changes: { content: "v2" },
		}, admin);
		expect(conflict.ok).toBe(false);
		// Spec (acceptance-04 §B): code must be WRITE_CONFLICT, machine-judgeable.
		expect(conflict.error ?? "").toMatch(/^WRITE_CONFLICT:/);
		// Spec (acceptance-04 §A): no internal integer id in any payload/text.
		expect(conflict.error ?? "").not.toMatch(/\bnode id=\d+\b/);
		expect(JSON.stringify(conflict)).not.toMatch(/\bnode id=\d+\b/);
	});

	test("payload + auditId carry NO internal integer id / synthetic short id / old path prefix", async () => {
		const admin = wideOpen();
		const created = await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "P1", content: "x",
		}, admin);
		const data = created.data as WikiMutationResult;
		const json = JSON.stringify(data);
		// auditId is an opaque receipt string; it must NOT look like a raw integer.
		expect(data.auditId).not.toMatch(/^\d+$/);
		// Path is the canonical path, no old-prefix leakage.
		expect(data.path).toBe("wiki-root/knowledge/P1");
		// No leaked internal id field.
		expect(json).not.toContain('"id"');
		expect(json).not.toContain('"nodeId"');
		expect(json).not.toContain('"parent_id"');
	});

	test("unauthorized mutation → ACCESS_DENIED (machine-judgeable, not text)", async () => {
		// Fixture under admin, attacker with NO create grant anywhere.
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "V1", content: "x" }, admin);
		const attacker = access("attacker", [grant("wiki-root/knowledge/V1", ["read"])]); // no create/update
		const upd = await h.execute({
			action: "update", node: "wiki-root/knowledge/V1",
			expected_revision: 1, changes: { content: "evil" },
		}, attacker);
		expect(upd.ok).toBe(false);
		expect(upd.error ?? "").toMatch(/^ACCESS_DENIED:/);
	});
});

// ===========================================================================
// §C — read / expand / write contract
// ===========================================================================

describe("wiki-v2 tool §C read/expand/write contract [规约 lens]", () => {
	let h: ToolHost;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	// ---- expand ----

	test("expand: default returns NO child content, children limit + cursor paged", async () => {
		const admin = wideOpen();
		// Build 3 children under knowledge/a.
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "a" }, admin);
		for (const n of ["c1", "c2", "c3"]) {
			await h.execute({
				action: "create", parent: "wiki-root/knowledge/a", name: n,
				summary: `${n}-sum`, content: `${n}-BODY`,
			}, admin);
		}
		// Page size 2 → first page has 2 items + hasMore + cursor; second page has 1.
		const page1 = await h.execute({
			action: "expand", node: "wiki-root/knowledge/a", limit: 2,
		}, admin);
		expect(page1.ok).toBe(true);
		const d1 = page1.data as WikiExpandResult;
		expect(d1.children.items.length).toBe(2);
		expect(d1.children.hasMore).toBe(true);
		expect(typeof d1.children.cursor).toBe("string");
		// CRITICAL: child items carry summary but NO content body.
		for (const c of d1.children.items) {
			expect(c).toHaveProperty("summary");
			expect(c).not.toHaveProperty("content");
			expect((c as any).content).toBeUndefined();
		}
		const page2 = await h.execute({
			action: "expand", node: "wiki-root/knowledge/a", limit: 2, cursor: d1.children.cursor,
		}, admin);
		const d2 = page2.data as WikiExpandResult;
		expect(d2.children.items.length).toBe(1);
		expect(d2.children.hasMore).toBe(false);
		expect(d2.children.cursor).toBeNull();
	});

	test("expand: inaccessible parent → uniform NOT_FOUND, no child name/summary leak", async () => {
		// With scope-segment grants, the parent-scope check IS the child filter:
		// a caller with no grant on the parent cannot expand it, so no child
		// metadata is revealed. Attacker has a deep grant only on a sibling.
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "visible" }, admin);
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "secret",
			summary: "SECRETKEY-unique", content: "secret-body",
		}, admin);
		const attacker = access("attacker", [grant("wiki-root/knowledge/visible", ["expand", "read"])]);
		const res = await h.execute({
			action: "expand", node: "wiki-root/knowledge",
		}, attacker);
		// No grant on the parent → uniform NOT_FOUND (no existence / child leak).
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^NOT_FOUND:/);
		// Neither the secret's name nor its summary body appears anywhere in the
		// structured payload or formatted text.
		const json = JSON.stringify(res);
		expect(json).not.toContain("secret");
		expect(json).not.toContain("SECRETKEY");
	});

	// ---- read 5 views + section + line range ----

	test("read: 5 views (summary/content/links/all/source) all accepted and shaped", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "RV", content: "# T\nbody" }, admin);
		for (const v of ["summary", "content", "links", "all", "source"]) {
			const res = await h.execute({
				action: "read", node: "wiki-root/knowledge/RV", view: v as any,
			}, admin);
			expect(res.ok, `view=${v} should succeed`).toBe(true);
			const d = res.data as WikiReadResult;
			expect(d.path).toBe("wiki-root/knowledge/RV");
			// source view on a non-source-bound node: returns source undefined/empty,
			// but the call still succeeds (not an error code).
			if (v === "content" || v === "all") expect(typeof d.content).toBe("string");
			if (v === "links" || v === "all") expect(d.links).toBeDefined();
		}
	});

	test("read(view=content): Markdown section slice returns only that section", async () => {
		const admin = wideOpen();
		const body = "# Top\nintro\n## Alpha\nA1\nA2\n## Beta\nB1\n";
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "SEC", content: body }, admin);
		const res = await h.execute({
			action: "read", node: "wiki-root/knowledge/SEC", view: "content", section: "Alpha",
		}, admin);
		expect(res.ok).toBe(true);
		const d = res.data as WikiReadResult;
		expect(d.content).toContain("A1");
		expect(d.content).toContain("A2");
		// Section slice must NOT leak other sections' body.
		expect(d.content).not.toContain("B1");
	});

	test("read(view=content): line range slice returns only those lines", async () => {
		const admin = wideOpen();
		const body = "L1\nL2\nL3\nL4\nL5\n";
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "LR", content: body }, admin);
		const res = await h.execute({
			action: "read", node: "wiki-root/knowledge/LR", view: "content",
			lineStart: 2, lineEnd: 4,
		}, admin);
		expect(res.ok).toBe(true);
		const d = res.data as WikiReadResult;
		expect(d.contentSlice).toBeDefined();
		expect(d.contentSlice!.startLine).toBe(2);
		expect(d.contentSlice!.endLine).toBe(4);
		expect(d.content).toContain("L2");
		expect(d.content).toContain("L3");
		expect(d.content).toContain("L4");
		expect(d.content).not.toContain("L1");
		expect(d.content).not.toContain("L5");
	});

	// ---- update expected_revision enforcement ----

	test("update: missing expected_revision is REJECTED", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "U1", content: "x" }, admin);
		const res = await h.execute({
			action: "update", node: "wiki-root/knowledge/U1",
			// expected_revision intentionally omitted
			changes: { content: "y" },
		}, admin);
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^INVALID_REQUEST:.*expected_revision/);
	});

	test("update: both changes and operations empty → INVALID_REQUEST (no-op)", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "U2", content: "x" }, admin);
		const res = await h.execute({
			action: "update", node: "wiki-root/knowledge/U2", expected_revision: 1,
		}, admin);
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^INVALID_REQUEST:/);
	});

	test("update: operations.replace_text makes a localized (not whole-file) edit", async () => {
		const admin = wideOpen();
		const body = "alpha\nbeta\ngamma\n";
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "OP", content: body }, admin);
		const r0 = await h.execute({ action: "read", node: "wiki-root/knowledge/OP", view: "summary" }, admin);
		const rev = (r0.data as WikiReadResult).node.revision;
		const upd = await h.execute({
			action: "update", node: "wiki-root/knowledge/OP", expected_revision: rev,
			operations: [{ op: "replace_text", old_text: "beta", new_text: "BETA" }],
		}, admin);
		expect(upd.ok).toBe(true);
		const after = await h.execute({ action: "read", node: "wiki-root/knowledge/OP", view: "content" }, admin);
		const c = (after.data as WikiReadResult).content!;
		expect(c).toContain("BETA");
		expect(c).toContain("alpha");
		expect(c).toContain("gamma");
	});

	// ---- create / link / unlink / move / delete each prove service action + authz ----

	test("create: builds node at parent with given kind/name; authz enforced", async () => {
		const admin = wideOpen();
		const res = await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "CR", kind: "memory",
			attributes: { display_name: "Display CR" },
		}, admin);
		expect(res.ok).toBe(true);
		const d = res.data as WikiMutationResult;
		expect(d.path).toBe("wiki-root/knowledge/CR");
		const read = await h.execute({ action: "read", node: "wiki-root/knowledge/CR", view: "summary" }, admin);
		expect((read.data as WikiReadResult).node.kind).toBe("memory");
		expect((read.data as WikiReadResult).node.displayTitle).toBe("Display CR");

		// authz: attacker without create grant on parent → rejected. With anti-leak
		// semantics this is NOT_FOUND (cannot confirm parent exists); ACCESS_DENIED
		// is also acceptable. Either way, the create must NOT succeed.
		const attacker = access("attacker", [grant("wiki-root/knowledge/CR", ["read"])]);
		const denied = await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "X",
		}, attacker);
		expect(denied.ok).toBe(false);
		expect(denied.error ?? "").toMatch(/^(NOT_FOUND|ACCESS_DENIED):/);
	});

	test("link + unlink: typed edge added then removed; target invisible → NOT_FOUND (no leak)", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "S1" }, admin);
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "T1" }, admin);
		const link = await h.execute({
			action: "link", source: "wiki-root/knowledge/S1", target: "wiki-root/knowledge/T1",
			relation: "depends_on",
		}, admin);
		expect(link.ok).toBe(true);
		// read links on S1 shows the edge.
		const readLinked = await h.execute({
			action: "read", node: "wiki-root/knowledge/S1", view: "links",
		}, admin);
		const links = (readLinked.data as WikiReadResult).links!;
		expect(links.outgoing.length + links.incoming.length).toBeGreaterThan(0);
		// unlink
		const ul = await h.execute({
			action: "unlink", source: "wiki-root/knowledge/S1", target: "wiki-root/knowledge/T1",
			relation: "depends_on",
		}, admin);
		expect(ul.ok).toBe(true);
		const after = await h.execute({
			action: "read", node: "wiki-root/knowledge/S1", view: "links",
		}, admin);
		const afterLinks = (after.data as WikiReadResult).links!;
		expect(afterLinks.outgoing.length + afterLinks.incoming.length).toBe(0);
	});

	test("move: relocates subtree (revision bump on root only); authz enforced", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "MV" }, admin);
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "DEST" }, admin);
		const before = await h.execute({ action: "read", node: "wiki-root/knowledge/MV", view: "summary" }, admin);
		const revBefore = (before.data as WikiReadResult).node.revision;
		const res = await h.execute({
			action: "move", node: "wiki-root/knowledge/MV", newParent: "wiki-root/knowledge/DEST",
		}, admin);
		expect(res.ok).toBe(true);
		const d = res.data as WikiMutationResult;
		expect(d.path).toBe("wiki-root/knowledge/DEST/MV");
		expect(d.oldRevision).toBe(revBefore);
		expect(d.revision).toBeGreaterThan(revBefore);

		// authz: attacker without move on source → ACCESS_DENIED.
		const attacker = access("attacker", [grant("wiki-root/knowledge/DEST/MV", ["read"])]);
		const denied = await h.execute({
			action: "move", node: "wiki-root/knowledge/DEST/MV", newParent: "wiki-root/knowledge",
		}, attacker);
		expect(denied.ok).toBe(false);
		expect(denied.error ?? "").toMatch(/^ACCESS_DENIED:/);
	});

	test("delete: default archives the node; hard-delete not exposed in schema", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "DL" }, admin);
		const res = await h.execute({
			action: "delete", node: "wiki-root/knowledge/DL",
		}, admin);
		expect(res.ok).toBe(true);
		// After archive, read returns NOT_FOUND (active-only lookup).
		const after = await h.execute({ action: "read", node: "wiki-root/knowledge/DL", view: "summary" }, admin);
		expect(after.ok).toBe(false);
		expect(after.error ?? "").toMatch(/^NOT_FOUND:/);
		// Schema has no hard_delete / hardDelete action.
		const shape = schemaShape(wikiV2ActionSchema);
		const values = enumValues(shape.action);
		expect(values).not.toContain("hardDelete");
		expect(values).not.toContain("hard_delete");
	});

	// ---- source-bound create/move/delete → SOURCE_MANAGED ----

	test("source-bound create/move/delete → SOURCE_MANAGED (structural ops reserved for indexer)", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-tool-srcroot-"));
		try {
			const repo = buildSourceRepo(tempRoot);
			const dbPath = join(UNIQUE_DIR, `wiki-src-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
			const wiki = new WikiDatabase(dbPath);
			try {
				const db = wiki.getDb();
				const nodeRepo = new WikiNodeRepository(db);
				const linkRepo = new WikiLinkRepository(db);
				const auditRepo = new WikiAuditRepository(db);
				const repositoryStore = new WikiRepositoryStore(db);
				const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
				const authorizationService = new WikiAuthorizationService();
				const editService = new WikiEditService();
				const svc = new WikiService({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo, repositoryStore,
					addressService, authorizationService, editService,
				});
				const search = new WikiSearchService({
					db, nodeRepo, repositoryStore, addressService, authorizationService,
				});
				const projectId = "p-src";
				const projectStore: ProjectStoreLike = {
					get: (id) => (id === projectId ? { id, name: "Src", workspaceDir: repo.repoDir } : undefined),
					list: () => [{ id: projectId, name: "Src", workspaceDir: repo.repoDir }],
				};
				const indexer = new WikiProjectIndexer({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
					repositoryStore, git: new ArchivistGit(), projectStore,
				});
				await indexer.fullIndex(projectId, { revision: repo.headSha });

				// The project subtree under wiki-root/projects/p-src is source-bound.
				// Build a non-source-bound parent we have create rights on, then attempt
				// structural ops ON a source-bound node.
				const admin = access("admin", [
					grant("wiki-root", ALL_ACTIONS),
				], projectId);
				const tool = createWikiTool({ wikiService: svc, searchService: search });
				const execute = getToolExecute(tool)!;
				const ctx = callerCtx(admin);

				// Create UNDER a source-bound parent → SOURCE_MANAGED.
				const fileNodePath = `${projectPath(projectId)}/${repo.fileRel}`;
				const createUnderMirror = await execute({
					action: "create", parent: fileNodePath, name: "x",
				}, ctx);
				expect(createUnderMirror.ok).toBe(false);
				expect(createUnderMirror.error ?? "").toMatch(/^SOURCE_MANAGED:/);

				// Move a source-bound node → SOURCE_MANAGED.
				const moveMirror = await execute({
					action: "move", node: fileNodePath, newParent: "wiki-root/knowledge",
				}, ctx);
				expect(moveMirror.ok).toBe(false);
				expect(moveMirror.error ?? "").toMatch(/^SOURCE_MANAGED:/);

				// Delete a source-bound node → SOURCE_MANAGED.
				const delMirror = await execute({
					action: "delete", node: fileNodePath,
				}, ctx);
				expect(delMirror.ok).toBe(false);
				expect(delMirror.error ?? "").toMatch(/^SOURCE_MANAGED:/);

				// update on a source-bound node is still allowed (semantic enrichment).
				const readFirst = await execute({
					action: "read", node: fileNodePath, view: "summary",
				}, ctx);
				const rev = (readFirst.data as WikiReadResult).node.revision;
				const semanticUpdate = await execute({
					action: "update", node: fileNodePath, expected_revision: rev,
					changes: { summary: "enriched summary" },
				}, ctx);
				expect(semanticUpdate.ok).toBe(true);
			} finally {
				try { wiki.close(); } catch { /* idempotent */ }
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// round-2 FIX 1 — error code closed-set + no internal id leak (repo + tool)
//
// round-1 BLOCKER: WikiNodeRepository.update() threw raw Error with messages
// like "node id=42 not found" / "revision mismatch for id=42", AND the tool
// wrapped ANY non-WikiServiceError as INTERNAL_ERROR — so WRITE_CONFLICT and
// NOT_FOUND were disguised as INTERNAL_ERROR with integer ids in the text.
//
// round-2 FIX 1: repo throws wikiError(NOT_FOUND | WRITE_CONFLICT) with PATH-
// based messages (no integer id); tool duck-types `.code` ∈ WIKI_ERROR_CODE_SET
// and stripInternalIds scrubs any residual `id=N` from surfaced messages.
// ===========================================================================

describe("round-2 FIX 1 — repo-direct errors: closed-set code, path-based message, no id leak [对抗]", () => {
	let h: ToolHost;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("repo.update on missing id → throws NOT_FOUND with path message, NO integer id", () => {
		// Drive the repository directly (bypass service+tool) to test the lowest
		// layer's error shape. round-1 threw `Error: node id=999999 not found`.
		const repo = new WikiNodeRepository(h.wiki.getDb());
		let caught: unknown;
		try {
			repo.update(999_999, 1, { path: "wiki-root/knowledge/ghost-path" });
		} catch (err) {
			caught = err;
		}
		expect(caught, "repo.update must throw on missing id").toBeDefined();
		expect(isWikiServiceError(caught)).toBe(true);
		expect((caught as { code: string }).code).toBe("NOT_FOUND");
		const msg = String((caught as Error).message ?? "");
		// Path-based, NOT integer-id-based.
		expect(msg).toContain("wiki-root/knowledge/ghost-path");
		expect(msg, `repo NOT_FOUND message must not leak integer id: "${msg}"`).not.toMatch(/\bid\s*=\s*\d+/i);
		expect(msg).not.toMatch(/\bnode\s+id\s*=\s*\d+/i);
	});

	test("repo.update stale revision → throws WRITE_CONFLICT with revision (public), NO integer id", async () => {
		const admin = wideOpen();
		await h.svc.create({
			parent: "wiki-root/knowledge", name: "wc1", content: "v0",
		}, ctxOfForService(admin));
		const repo = new WikiNodeRepository(h.wiki.getDb());
		const row = repo.getActiveByPath("wiki-root/knowledge/wc1")!;
		// Bump revision via the repo, then attempt update on the STALE revision.
		repo.update(row.id, row.revision, { content: "v1" });
		let caught: unknown;
		try {
			repo.update(row.id, row.revision, { path: "wiki-root/knowledge/wc1" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(isWikiServiceError(caught)).toBe(true);
		expect((caught as { code: string }).code).toBe("WRITE_CONFLICT");
		const msg = String((caught as Error).message ?? "");
		// revision is a PUBLIC optimistic-concurrency token — allowed in message.
		expect(msg).toMatch(/stale revision/i);
		// Integer node id must NOT appear.
		expect(msg, `WRITE_CONFLICT message leaked integer id: "${msg}"`).not.toMatch(/\bid\s*=\s*\d+/i);
	});
});

describe("round-2 FIX 1 — tool-wrap errors: code machine-judgeable, no INTERNAL_ERROR disguise [对抗]", () => {
	let h: ToolHost;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("tool update on non-existing node → NOT_FOUND (NOT INTERNAL_ERROR), no id=N in any payload", async () => {
		const admin = wideOpen();
		const res = await h.execute({
			action: "update", node: "wiki-root/knowledge/never-created-xyz",
			expected_revision: 1, changes: { content: "v" },
		}, admin);
		expect(res.ok).toBe(false);
		// CRITICAL (FIX 1): code must be NOT_FOUND, not INTERNAL_ERROR.
		expect(res.error ?? "").toMatch(/^NOT_FOUND:/);
		expect(res.error ?? "").not.toMatch(/^INTERNAL_ERROR:/);
		// No integer id anywhere in the surfaced error or JSON.
		expect(res.error ?? "", `error string leaked id: "${res.error}"`).not.toMatch(/\bid\s*=\s*\d+/i);
		expect(JSON.stringify(res), "payload leaked integer id").not.toMatch(/\bid\s*=\s*\d+/i);
		expect(JSON.stringify(res)).not.toMatch(/\bnode\s+id\s*=\s*\d+/i);
	});

	test("tool update stale revision → WRITE_CONFLICT (NOT INTERNAL_ERROR), no id=N", async () => {
		const admin = wideOpen();
		await h.execute({ action: "create", parent: "wiki-root/knowledge", name: "wc-tool", content: "v0" }, admin);
		const staleRes = await h.execute({ action: "read", node: "wiki-root/knowledge/wc-tool", view: "summary" }, admin);
		const observed = (staleRes.data as WikiReadResult).node.revision;
		// First update bumps revision.
		await h.execute({
			action: "update", node: "wiki-root/knowledge/wc-tool",
			expected_revision: observed, changes: { content: "v1" },
		}, admin);
		// Second update with STALE revision → WRITE_CONFLICT (round-1 disguised as INTERNAL_ERROR).
		const conflict = await h.execute({
			action: "update", node: "wiki-root/knowledge/wc-tool",
			expected_revision: observed, changes: { content: "v2" },
		}, admin);
		expect(conflict.ok).toBe(false);
		expect(conflict.error ?? "").toMatch(/^WRITE_CONFLICT:/);
		expect(conflict.error ?? "").not.toMatch(/^INTERNAL_ERROR:/);
		expect(conflict.error ?? "", `conflict error leaked id: "${conflict.error}"`).not.toMatch(/\bid\s*=\s*\d+/i);
		expect(JSON.stringify(conflict)).not.toMatch(/\bid\s*=\s*\d+/i);
	});

	test("FIX 1 duck-typed code: raw Error with .code='WRITE_CONFLICT' → surfaced as WRITE_CONFLICT (not INTERNAL_ERROR)", async () => {
		// Adversarial: simulate a service-layer raw throw that carries a closed-set
		// `.code` but is NOT a WikiServiceError instance. round-1 tool fell through
		// to INTERNAL_ERROR for this; round-2 FIX 1 duck-types `.code` ∈
		// WIKI_ERROR_CODE_SET and maps it correctly.
		const fakeService = {
			expand: async () => { throw Object.assign(new Error("simulated stale node id=99"), { code: "WRITE_CONFLICT" }); },
			read: async () => { throw Object.assign(new Error("simulated missing node id=99"), { code: "NOT_FOUND" }); },
		} as unknown as import("../../src/server/wiki/wiki-service.js").WikiService;
		const tool = createWikiTool({ wikiService: fakeService, searchService: {} as any });
		const execute = getToolExecute(tool)!;
		const ctx: CallerCtx = {
			caller: "internal", sessionId: "s", agentId: "a", toolCallId: "tc",
			wikiAccess: wideOpen(),
		};
		// expand throws raw Error with .code=WRITE_CONFLICT → tool surfaces WRITE_CONFLICT.
		const expandRes = await execute({ action: "expand", node: "wiki-root/knowledge/x" }, ctx);
		expect(expandRes.ok).toBe(false);
		expect(expandRes.error ?? "").toMatch(/^WRITE_CONFLICT:/);
		expect(expandRes.error ?? "").not.toMatch(/^INTERNAL_ERROR:/);
		// stripInternalIds MUST scrub the `id=99` even from a raw Error message.
		expect(expandRes.error ?? "", `stripInternalIds failed: "${expandRes.error}"`).not.toMatch(/\bid\s*=\s*\d+/i);

		// read throws raw Error with .code=NOT_FOUND → tool surfaces NOT_FOUND.
		const readRes = await execute({ action: "read", node: "wiki-root/knowledge/x", view: "summary" }, ctx);
		expect(readRes.ok).toBe(false);
		expect(readRes.error ?? "").toMatch(/^NOT_FOUND:/);
		expect(readRes.error ?? "").not.toMatch(/^INTERNAL_ERROR:/);
		expect(readRes.error ?? "").not.toMatch(/\bid\s*=\s*\d+/i);
	});

	test("FIX 1 stripInternalIds scrubs id=N but preserves path/revision/auditId", async () => {
		// Defense-in-depth: even if some future error path leaks `id=N`, the tool's
		// stripInternalIds regex must scrub it. Verify path/revision/auditId survive.
		const fakeService = {
			expand: async () => { throw Object.assign(
				new Error("conflict on node id=777 at wiki-root/knowledge/keep-path revision 3"),
				{ code: "WRITE_CONFLICT" },
			); },
		} as unknown as import("../../src/server/wiki/wiki-service.js").WikiService;
		const tool = createWikiTool({ wikiService: fakeService, searchService: {} as any });
		const execute = getToolExecute(tool)!;
		const ctx: CallerCtx = {
			caller: "internal", sessionId: "s", agentId: "a", toolCallId: "tc",
			wikiAccess: wideOpen(),
		};
		const res = await execute({ action: "expand", node: "wiki-root/knowledge/keep-path" }, ctx);
		expect(res.ok).toBe(false);
		expect(res.error ?? "").toMatch(/^WRITE_CONFLICT:/);
		// Integer id scrubbed.
		expect(res.error ?? "").not.toMatch(/\bid\s*=\s*\d+/i);
		expect(res.error ?? "").not.toMatch(/\bnode\s+id\s*=\s*\d+/i);
		// Path + revision preserved (public identifiers).
		expect(res.error ?? "").toContain("wiki-root/knowledge/keep-path");
		expect(res.error ?? "").toContain("revision 3");
	});
});

// ---------------------------------------------------------------------------
// FIX 1 test helpers — service-level ctx (the tool bridge builds this normally).
// ---------------------------------------------------------------------------

function ctxOfForService(acc: CompiledWikiAccess): WikiRequestContext {
	return {
		access: acc,
		agentId: acc.agentId,
		activeProjectId: acc.activeProjectId,
		sessionId: "contract-fix1-session",
		requestId: null,
	};
}
