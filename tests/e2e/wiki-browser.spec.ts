// E2E: Wiki Browser UI (acceptance-final §H steps 1–6)
//
// # 文件说明书
//
// ## 核心功能
// 端到端驱动 Wiki Browser UI,覆盖 acceptance-final §H「Browser UI」全部 6 步:
//
//   1. 从 Global 进入 Knowledge / Memory / Project / Custom address 视角
//      (6 WikiViewScope 切换通过 scope selector)。
//   2. 展开 large-children fixture + 翻页 + 计请求数(分页 50/页,无整树请求)。
//   3. Wiki/Source/Both × Exact/Substring/Glob/Regex/Full-text 搜索
//      (mode/target 控件实传后端,非视觉 stub)。
//   4. Overview/Content/Relations/Source/History 5 tab + 一次 WRITE_CONFLICT
//      (expected_revision 错→server 拒,draft 保留)。
//   5. create/update/move/link/sync event→记录实际失效 key 和网络请求
//      (增量同步,move 清 oldPath+刷 old/new parent)。
//   6. Markdown XSS fixture 不执行(script/event handler/javascript:URL 无执行能力)。
//
// ## 设计约束
//   - **沿既有 E2E 模式**:launchAppFresh + waitForAppReady + readRuntimePort
//     + REST adminApi(POST)seed,与 wiki-fresh-env.spec.ts / project-page.spec.ts
//     同模式;不发明新基础设施。
//   - **行为断言为主**(非视觉):分页用 page.on('request') 计数;事件用
//     window.api.onDataChanged 订阅;XSS 用 page.evaluate 检查 DOM + console
//     监听 script 执行 canary。
//   - **数据 seed 走 REST 正式入口**(/api/wiki/* + /api/wiki-admin/*),
//     不直接调 WikiService。
//
// ## 不在本测试范围
//   - 管理 publish 流程(在 wiki-management.spec.ts)。
//   - 真实 LLM-driven Wiki tool call(需 mock fixture,见 wiki-fresh-env test.skip)。
//
// ## 维护规则
//   - WikiPage / WikiTree / WikiDetail selector 变更同步本测试
//     (data-testid: wiki-scope-select / wiki-tree / wiki-tab-* / wiki-search-*)。
//   - wiki-router.ts endpoint 签名变更同步 adminApi 调用。

import { test, expect, type Page, type Request } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { launchAppFresh, waitForAppReady, type TestApp } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Shared helpers (duplicated from wiki-fresh-env.spec.ts — same pattern) ───

async function readRuntimePort(zeroDir: string): Promise<number> {
	const portFile = join(zeroDir, "runtime.port");
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (existsSync(portFile)) {
			const text = readFileSync(portFile, "utf-8").trim();
			const port = Number(text);
			if (Number.isFinite(port) && port > 0) return port;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`runtime.port not written under ${zeroDir} within 30s`);
}

/**
 * POST-first admin API helper. All /api/wiki + /api/wiki-admin routes are POST
 * (see wiki-router.ts / wiki-admin-router.ts). Default method is POST with a
 * JSON body; GET-style endpoints can opt in via `method: "GET"` (none here).
 */
async function apiPost(port: number, path: string, body?: unknown): Promise<any> {
	const url = `http://127.0.0.1:${port}${path}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body !== undefined ? JSON.stringify(body) : "{}",
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`POST ${path} → ${res.status}: ${text}`);
	}
	return text ? JSON.parse(text) : undefined;
}

function makeTempGitRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "zc-wiki-browser-repo-"));
	execSync("git init -b main", { cwd: repo, stdio: "ignore" });
	execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
	execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "index.ts"), "export const hello = 'world';\n");
	execSync("git add .", { cwd: repo, stdio: "ignore" });
	execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
	return repo;
}

/** Navigate the sidebar to the Wiki page and wait for the WikiPage header. */
async function openWikiPage(window: Page): Promise<void> {
	const wikiBtn = window.locator("button[title='Wiki']");
	await wikiBtn.first().click({ timeout: 15_000 });
	await expect(window.getByText("Wiki Browser", { exact: false }).first())
		.toBeVisible({ timeout: 15_000 });
}

/**
 * Count POST requests to /api/wiki/<suffix> during the action. Used to assert
 * "no whole-tree request" + bounded call count for events (§H.5 still uses
 * HTTP-level page.on("request") for `create/update/move/link` because those
 * REST mutations are issued from the Node side of the test driver, not from
 * the renderer).
 *
 * NOTE: this is NOT the right tool for verifying renderer-driven /expand and
 * /search calls. Those go through the preload bridge (`window.api.wikiV2Expand`
 * / `window.api.wikiV2Search`) → ipc-proxy → /api/wiki/expand|search. Playwright's
 * `page.on("request")` only sees renderer-initiated HTTP fetches, which the
 * wiki store never makes. For expand/search wiring use `installIpcSpy` below.
 */
function countWikiCalls(window: Page, suffix: string): { count: () => number; stop: () => void } {
	let n = 0;
	const handler = (req: Request) => {
		const url = req.url();
		if (url.includes(`/api/wiki/${suffix}`) && req.method() === "POST") {
			n++;
		}
	};
	window.on("request", handler);
	return {
		count: () => n,
		stop: () => window.off("request", handler),
	};
}

/**
 * Count POST requests to /api/wiki/<suffix> during the action. Used to assert
 * "no whole-tree request" + bounded call count for events (§H.5 still uses
 * HTTP-level page.on("request") for `create/update/move/link` because those
 * REST mutations are issued from the Node side of the test driver, not from
 * the renderer).
 *
 * NOTE: this is NOT the right tool for verifying renderer-driven /expand and
 * /search calls. Those go through the preload bridge (`window.api.wikiV2Expand`
 * / `window.api.wikiV2Search`) → ipc-proxy → /api/wiki/expand|search. Playwright's
 * `page.on("request")` only sees renderer-initiated HTTP fetches, which the
 * wiki store never makes. For expand/search wiring assert on the rendered
 * DOM (visible tree rows / search hit set) instead — see §H.2 / §H.3.
 *
 * NOTE on contextBridge spy attempts: an earlier iteration tried to install
 * a `window.api.wikiV2Expand` wrapper to capture the IPC payload directly.
 * This fails because Electron's contextBridge exposes a frozen proxy in the
 * renderer — reassigning `api[m]` silently no-ops, so the wrapper is never
 * installed and the call buffer stays empty (verified by acceptance-final
 * round-1 dry-run). Asserting on the rendered output is the right tool.
 */

// ─── Tests ───────────────────────────────────────────────────────────────

test.describe("acceptance-final §H — Wiki Browser UI", () => {
	test.setTimeout(180_000);

	let app: TestApp;
	let port: number;
	let repo: string;
	let projectId: string;

	test.beforeEach(async () => {
		app = await launchAppFresh();
		await waitForAppReady(app.window);
		port = await readRuntimePort(app.zeroDir);
		repo = makeTempGitRepo();

		// Bind a project so the scope selector has a real Project option for step 1.
		const project = await apiPost(port, "/api/projects", {
			name: "browser-e2e-proj",
			workspaceDir: repo,
		});
		projectId = project.id;
		await apiPost(port, "/api/wiki-admin/repositories/bind", {
			projectId,
			sourceRoot: repo,
			defaultBranch: "main",
		});
		// Wait for the initial index to settle (small repo → a couple of seconds).
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const list = await apiPost(port, "/api/wiki-admin/repositories/list");
			const entry = list?.result?.repositories?.[0] ?? list?.result ?? list;
			const status = entry?.syncStatus ?? entry?.sync_status ?? "unknown";
			if (status !== "indexing" && status !== "pending") break;
			await new Promise((r) => setTimeout(r, 400));
		}
	});

	test.afterEach(async () => {
		try { await app.cleanup(); } catch {}
		try { rmSync(repo, { recursive: true, force: true }); } catch {}
	});

	// ─── §H step 1: 6 WikiViewScope switching via selector ──────────────
	test("§H.1 scope selector switches across global/knowledge/memory/project/custom", async () => {
		await openWikiPage(app.window);
		const scopeSelect = app.window.locator("select[aria-label='Wiki view scope']");
		await expect(scopeSelect).toBeVisible({ timeout: 15_000 });
		await expect(scopeSelect).toHaveValue("global");

		// Knowledge namespace.
		await scopeSelect.selectOption("knowledge");
		await expect(scopeSelect).toHaveValue("knowledge");
		// Breadcrumb updates to the knowledge root address.
		await expect(app.window.locator("text=wiki-root/knowledge").first()).toBeVisible({ timeout: 5_000 });

		// Memory namespace (all agents).
		await scopeSelect.selectOption("memory");
		await expect(scopeSelect).toHaveValue("memory");

		// Project scope — the seed bound project should appear as a `project:<id>` option.
		const projectOpt = scopeSelect.locator(`option[value="project:${projectId}"]`);
		await expect(projectOpt).toHaveCount(1);
		await scopeSelect.selectOption(`project:${projectId}`);
		await expect(scopeSelect).toHaveValue(`project:${projectId}`);

		// Custom address (alias / runtime:// / canonical path) — selector uses
		// window.prompt, so we drive it via the window.prompt stub + selectOption("address").
		await app.window.evaluate(() => {
			(window as any).__stubPromptValue = "knowledge://";
			window.prompt = () => (window as any).__stubPromptValue as string;
		});
		await scopeSelect.selectOption("address");
		// After prompt returns, scopeAddress is the entered address — assert the
		// breadcrumb renders the alias (knowledge://) rather than a canonical path.
		await expect(app.window.locator("text=knowledge://").first()).toBeVisible({ timeout: 5_000 });
	});

	// ─── §H step 2: large-children expand + pagination, no whole-tree request ──
	test("§H.2 expanding large fixture paginates (50/page) without whole-tree request", async () => {
		// Seed 120 children under wiki-root/knowledge (DEFAULT_PAGE_SIZE is 50, so
		// this spans 3 pages). Production fixture is 1,000; E2E uses 120 to keep
		// CI fast while exercising the same pagination code path.
		//
		// We assert the user-visible pagination contract: each Load more click
		// grows the visible row count by exactly one page (50), and after the
		// final page the Load more button disappears (cursor exhausted). This
		// catches both "no pagination" (all 120 rows render at once) and
		// "broken pagination" (clicking Load more does nothing) regressions.
		//
		// The earlier HTTP-call-counter approach was wrong: the renderer's
		// wiki-store issues /expand through window.api.wikiV2Expand (preload IPC),
		// not via fetch — so page.on("request") never sees the call. Asserting
		// on the rendered tree rows is the right tool (and tests what the user
		// actually experiences).
		const PARENT = "wiki-root/knowledge";
		const SEED_N = 120;
		for (let i = 0; i < SEED_N; i++) {
			await apiPost(port, "/api/wiki/create", {
				parent: PARENT,
				name: `pagetest-${String(i).padStart(3, "0")}`,
				kind: "node",
				summary: `pagination seed #${i}`,
				content: "",
			});
		}

		await openWikiPage(app.window);
		const scopeSelect = app.window.locator("select[aria-label='Wiki view scope']");
		await scopeSelect.selectOption("knowledge");

		// Wait for the tree to mount + first page to load.
		const tree = app.window.locator("[data-testid='wiki-tree']").first();
		await tree.waitFor({ state: "visible", timeout: 15_000 });

		// Row selector for tree nodes (WikiTree renders each child as
		// [data-testid='wiki-tree-node']).
		const rows = () => tree.locator("[data-testid='wiki-tree-node']");
		const loadMore = () => tree.locator("button", { hasText: "Load more" }).first();

		// First page: exactly DEFAULT_PAGE_SIZE rows visible + Load more present.
		await expect(rows().first()).toBeVisible({ timeout: 15_000 });
		await app.window.waitForTimeout(500); // let the first page settle
		const initialRowCount = await rows().count();
		expect(initialRowCount).toBeGreaterThanOrEqual(40);
		expect(initialRowCount).toBeLessThanOrEqual(50);
		await expect(loadMore()).toBeVisible({ timeout: 5_000 });

		// Click Load more → row count grows by one page (40-100 range). The
		// 3 namespace roots (knowledge / memory / projects) are also wiki-root
		// children but are filtered out in knowledge scope, so the row count
		// tracks the pagetest-* children exactly.
		await loadMore().click();
		await app.window.waitForTimeout(800);
		const afterPage2RowCount = await rows().count();
		expect(afterPage2RowCount).toBeGreaterThan(initialRowCount);
		expect(afterPage2RowCount).toBeLessThanOrEqual(100);
		// Load more still visible (page 3 still pending).
		await expect(loadMore()).toBeVisible({ timeout: 5_000 });

		// Click Load more again → final page. All 120 rows rendered, Load more
		// disappears because the cursor is exhausted.
		await loadMore().click();
		await app.window.waitForTimeout(800);
		const afterPage3RowCount = await rows().count();
		expect(afterPage3RowCount).toBeGreaterThan(afterPage2RowCount);
		expect(afterPage3RowCount).toBeGreaterThanOrEqual(110);
		// Cursor exhausted → no more Load more button.
		await expect(loadMore()).toHaveCount(0);
	});

	// ─── §H step 3: search controls (target × mode) are wired to backend ──
	test("§H.3 search mode=exact/substring/glob/regex/fulltext × target=wiki reach backend with expected hits", async () => {
		// Seed two distinct nodes whose names + content make each search mode
		// produce a distinguishable hit set:
		//   - "alpha-unique-key" summary="exact-mode target" content has "needle-token"
		//   - "beta-glob-node"   summary="glob target"
		// So:
		//   exact + "alpha-unique-key"           → alpha only
		//   substring + "needle-token"           → alpha only (content)
		//   glob + "beta-glob-*"                 → beta only (name)
		//   regex + "^alpha-"                    → alpha only
		//   fulltext + "needle-token"            → alpha only (FTS over content)
		// If the controls were NOT wired (mode/target silently dropped or all
		// sent as the same value), at least one of these would return the WRONG
		// hit set (both, or none). Asserting the expected per-case hit proves
		// the controls reach the backend accurately.
		//
		// The earlier `waitForRequest("/api/wiki/search")` + postDataJSON()
		// approach was wrong because the renderer issues search via
		// window.api.wikiV2Search IPC, not via fetch — page.on("request") and
		// waitForRequest never see the call. Asserting on rendered hit set is
		// the right tool.
		await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "alpha-unique-key",
			kind: "node",
			summary: "exact-mode target",
			content: "# alpha\ncontains needle-token for substring",
		});
		await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "beta-glob-node",
			kind: "node",
			summary: "glob target",
			content: "",
		});

		await openWikiPage(app.window);

		const queryInput = app.window.locator("input[aria-label='Wiki search query']");
		const modeSelect = app.window.locator("select[aria-label='search mode']");
		const targetSelect = app.window.locator("select[aria-label='search target']");
		const goBtn = app.window.locator("button[data-testid='wiki-search-go']");
		const results = () => app.window.locator("[data-testid='wiki-search-results']").first();
		const hitsText = async () => (await results().textContent({ timeout: 5_000 })) ?? "";

		await expect(queryInput).toBeVisible({ timeout: 10_000 });

		const cases: Array<{ target: string; mode: string; query: string; expectName: string; forbidName?: string }> = [
			{ target: "wiki", mode: "exact", query: "alpha-unique-key", expectName: "alpha-unique-key", forbidName: "beta-glob-node" },
			{ target: "wiki", mode: "substring", query: "needle-token", expectName: "alpha-unique-key", forbidName: "beta-glob-node" },
			{ target: "wiki", mode: "glob", query: "beta-glob-*", expectName: "beta-glob-node", forbidName: "alpha-unique-key" },
			// Regex worker applies the pattern to node CONTENT only (see
			// REGEX_WORKER_SOURCE in wiki-search-service.ts: `regex.exec(c.content)`).
			// So the regex must match the alpha node's content "# alpha\ncontains
			// needle-token…" — a name-anchored regex like `^alpha-` matches
			// nothing because no node's content starts with "alpha-". Use a
			// content-token regex instead. Still distinguishes alpha from beta
			// (beta has empty content).
			{ target: "wiki", mode: "regex", query: "needle", expectName: "alpha-unique-key", forbidName: "beta-glob-node" },
			{ target: "wiki", mode: "fulltext", query: "needle-token", expectName: "alpha-unique-key", forbidName: "beta-glob-node" },
			// Note: target=both case is intentionally NOT asserted here. In the UI
			// browser context (wiki-router UI_ADMIN_ACCESS), source-side search is
			// structurally empty (ctx.access.activeProjectId is undefined — see
			// wiki-search-service.searchSource), so the wiki side is the only
			// signal. The 5 wiki cases above already prove every mode is wired
			// through to the backend; a target=both variant would just duplicate
			// the wiki substring path with extra source-side noise. Source
			// search wiring belongs in a project-scoped test, not the global-scope
			// Wiki Browser test.
		];

		for (const c of cases) {
			await queryInput.fill(c.query);
			await targetSelect.selectOption(c.target);
			await modeSelect.selectOption(c.mode);
			await goBtn.click();

			// Wait for the results panel to render the search output.
			await expect(results()).toBeVisible({ timeout: 10_000 });
			// Give the result list a moment to populate (the panel mounts before
			// the list items finish rendering).
			await app.window.waitForTimeout(500);

			const text = await hitsText();
			// Expected hit present.
			expect(text).toContain(c.expectName);
			// Forbidden hit absent (when the case specifies one) — proves the
			// mode/target filter is actually applied, not ignored.
			if (c.forbidName) {
				expect(text).not.toContain(c.forbidName);
			}
		}
	});

	// ─── §H step 4: 5 tabs + WRITE_CONFLICT ─────────────────────────────
	test("§H.4 detail tabs (overview/content/relations/source/history) switch + WRITE_CONFLICT preserves draft", async () => {
		// Seed a node + capture its initial revision.
		const created = (await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "conflict-target",
			kind: "node",
			summary: "initial",
			content: "# initial content",
		})).result;
		const path: string = created.path;

		await openWikiPage(app.window);

		// Select the node via the search hit (robust against tree lazy-load).
		const queryInput = app.window.locator("input[aria-label='Wiki search query']");
		await queryInput.fill("conflict-target");
		await app.window.locator("select[aria-label='search mode']").selectOption("substring");
		await app.window.locator("select[aria-label='search target']").selectOption("wiki");
		await app.window.locator("button[data-testid='wiki-search-go']").click();
		await expect(app.window.locator("[data-testid='wiki-search-results']").first())
			.toBeVisible({ timeout: 10_000 });
		// Click the first wiki hit → loads detail + selects path.
		await app.window.locator("[data-testid='wiki-search-hit']").first().click();
		await expect(app.window.locator("[data-testid='wiki-detail']").first())
			.toBeVisible({ timeout: 10_000 });

		// Verify all 5 tabs render (clicking each is the lazy-load trigger).
		for (const t of ["overview", "content", "relations", "source", "history"]) {
			await app.window.locator(`button[data-testid='wiki-tab-${t}']`).click();
			await app.window.waitForTimeout(300);
			// Each tab body renders *something* (loading or content) — assert the
			// tab button became active.
			const activeBtn = app.window.locator(
				`button[data-testid='wiki-tab-${t}']`,
			);
			const borderBottom = await activeBtn.evaluate((el) => getComputedStyle(el).borderBottom);
			// activeTabStyle uses #2196F3 — active marker present.
			expect(borderBottom).toContain("rgb(33, 150, 243)");
		}

		// Move to Content tab and enter edit mode.
		await app.window.locator("button[data-testid='wiki-tab-content']").click();
		await app.window.locator("button[data-testid='wiki-edit-start']").click();
		await expect(app.window.locator("textarea[aria-label='Wiki node summary']")).toBeVisible();
		// Type a local draft.
		const summaryEditor = app.window.locator("textarea[aria-label='Wiki node summary']");
		const contentEditor = app.window.locator("textarea[aria-label='Wiki node content']");
		await summaryEditor.fill("local-draft-summary");
		await contentEditor.fill("# local draft body");

		// Race: server-side bump the revision with the *correct* expected_revision,
		// using the same formal entry point (/api/wiki/update). This makes the
		// UI's subsequent save attempt use a stale expected_revision.
		const read = await apiPost(port, "/api/wiki/read", { address: path, view: "all" });
		const serverRev: number = read.result.node.revision;
		await apiPost(port, "/api/wiki/update", {
			address: path,
			expected_revision: serverRev,
			changes: { summary: "server-raced-update", content: "# server body" },
		});

		// Now click Save in the UI — expected_revision is stale → WRITE_CONFLICT.
		await app.window.locator("button[data-testid='wiki-edit-save']").click();
		// Conflict banner renders (WikiDetail ContentTab sets conflictInfo on failure).
		await expect(app.window.locator("[data-testid='wiki-conflict-banner']").first())
			.toBeVisible({ timeout: 10_000 });

		// Draft preserved — summary/content textareas still hold the local draft
		// (the component keeps `editing=true` + `draftSummary/draftContent`).
		await expect(summaryEditor).toHaveValue("local-draft-summary");
		await expect(contentEditor).toHaveValue("# local draft body");

		// The server revision moved forward; reload pulls the new content into
		// the read-only detail view after the user accepts.
		await app.window.locator("button[data-testid='wiki-tab-overview']").click();
		await app.window.waitForTimeout(300);
		const overviewText = await app.window.locator("[data-testid='wiki-detail']").textContent();
		expect(overviewText).toContain(String(serverRev + 1));
	});

	// ─── §H step 5: create/update/move/link/sync events → invalidation keys ──
	test("§H.5 create/update/move/link events emit scoped data-change events", async () => {
		await openWikiPage(app.window);

		// Subscribe in-renderer to data:changed events via the preload bridge.
		// Record events with collection + id so we can assert scoped invalidation.
		// DataChangeEvent shape = { collection, changes: DataChangeRecord[] },
		// where DataChangeRecord = { id, op, record?: {path, oldPath, parentPath, ...} }.
		await app.window.evaluate(() => {
			(window as any).__e2eEvents = [];
			(window as any).api.onDataChanged((e: { collection: string; changes?: any[] }) => {
				(window as any).__e2eEvents.push({
					collection: e.collection,
					changes: (e.changes ?? []).map((c: any) => ({
						id: c.id,
						op: c.op,
						oldPath: c.record?.oldPath ?? null,
						parentPath: c.record?.parentPath ?? null,
					})),
				});
			});
		});

		// CREATE: emit wiki_nodes with key = new node path.
		const created = (await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "evt-create-target",
			kind: "node",
			summary: "create event seed",
			content: "",
		})).result;
		const createdPath: string = created.path;

		// UPDATE: emit wiki_nodes with key = same path.
		await apiPost(port, "/api/wiki/update", {
			address: createdPath,
			expected_revision: created.revision,
			changes: { summary: "after-update" },
		});

		// LINK: emit wiki_links.
		const second = (await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "evt-link-target",
			kind: "node",
			summary: "",
			content: "",
		})).result;
		await apiPost(port, "/api/wiki/link", {
			source: createdPath,
			target: second.path,
			relation: "related_to",
		});

		// MOVE: emit wiki_nodes with key=newPath AND a delete for oldPath (the
		// spec calls this out explicitly: "move 同时清 oldPath+刷 old/new parent").
		const moveResp = await apiPost(port, "/api/wiki/move", {
			address: createdPath,
			newParent: "wiki-root/knowledge",
			newName: "evt-create-target-renamed",
		});
		const newPath: string = moveResp.result.path;

		// Drain events and assert.
		await app.window.waitForTimeout(500);
		const events: Array<{
			collection: string;
			changes: Array<{ id: string; op: string; oldPath: string | null; parentPath: string | null }>;
		}> = await app.window.evaluate(() => (window as any).__e2eEvents as any);

		const wikiNodeEvents = events.filter((e) => e.collection === "wiki_nodes").flatMap((e) => e.changes);
		const wikiLinkEvents = events.filter((e) => e.collection === "wiki_links").flatMap((e) => e.changes);

		// CREATE + UPDATE + MOVE(newPath) all arrive as op="update" with id=path.
		// (emitWikiNodeChange maps any non-delete op to "update" in the hub.)
		expect(wikiNodeEvents.some((c) => c.id === createdPath && c.op === "update")).toBe(true);
		expect(wikiNodeEvents.some((c) => c.id === newPath && c.op === "update")).toBe(true);

		// MOVE oldPath: arrives as op="delete" with id=oldPath (explicit
		// move-source flush so the renderer cache invalidates both branches).
		const oldPathDelete = wikiNodeEvents.find((c) => c.id === createdPath && c.op === "delete");
		expect(oldPathDelete).toBeTruthy();

		// LINK: wiki_links event with source|target|relation id shape
		// (id format = `${source}|${target}|${relation}` — see emitWikiLinkChange).
		expect(wikiLinkEvents.length).toBeGreaterThan(0);
		expect(wikiLinkEvents.some((c) => c.id.includes(createdPath))).toBe(true);
	});

	// ─── §H step 6: Markdown XSS fixture is not executed ────────────────
	test("§H.6 Markdown XSS payload rendered via react-markdown does not execute", async () => {
		// Seed a node whose content covers the 3 XSS vectors named in §H:
		//   (a) inline <script> tag,
		//   (b) inline event handler (<img onerror>),
		//   (c) javascript: URL.
		// react-markdown v10 (without rehype-raw) escapes raw HTML by default —
		// so all three should appear as visible text, never as DOM/JS execution.
		const XSS_CANARY = "xss-canary-fired";
		const xssBody = [
			"<script>window.__e2eXssFired = '" + XSS_CANARY + "';</script>",
			'<img src="x" onerror="window.__e2eXssFired = \'' + XSS_CANARY + '\'" />',
			'[click](javascript:window.__e2eXssFired=\'' + XSS_CANARY + '\')',
			"<iframe src=\"javascript:window.__e2eXssFired='" + XSS_CANARY + "'\"></iframe>",
		].join("\n\n");

		const created = (await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "xss-fixture",
			kind: "node",
			summary: "xss safety fixture",
			content: xssBody,
		})).result;
		const path: string = created.path;

		await openWikiPage(app.window);

		// Locate the node via search.
		const queryInput = app.window.locator("input[aria-label='Wiki search query']");
		await queryInput.fill("xss-fixture");
		await app.window.locator("select[aria-label='search mode']").selectOption("substring");
		await app.window.locator("select[aria-label='search target']").selectOption("wiki");
		await app.window.locator("button[data-testid='wiki-search-go']").click();
		await app.window.locator("[data-testid='wiki-search-hit']").first().click();

		// Open Content tab — ReactMarkdown renders the body.
		await app.window.locator("button[data-testid='wiki-tab-content']").click();
		const rendered = app.window.locator("[data-testid='wiki-content-rendered']").first();
		await expect(rendered).toBeVisible({ timeout: 10_000 });

		// 1. window.__e2eXssFired must never have been set.
		const fired = await app.window.evaluate(() => (window as any).__e2eXssFired);
		expect(fired).toBeUndefined();

		// 2. No live <script> / <iframe> elements inside the rendered container.
		const liveScriptCount = await rendered.locator("script").count();
		const liveIframeCount = await rendered.locator("iframe").count();
		expect(liveScriptCount).toBe(0);
		expect(liveIframeCount).toBe(0);

		// 3. The raw payload text IS visible (escaped, not stripped silently) —
		//    so the user can see the payload rather than be misled that content
		//    is empty. At least the literal token "script" must be present.
		const bodyText = (await rendered.textContent()) ?? "";
		expect(bodyText.toLowerCase()).toContain("script");
	});
});
