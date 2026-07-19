// E2E: Wiki management & publish flows (acceptance-final §G + §H step 6)
//
// # 文件说明书
//
// ## 核心功能
// 端到端驱动 Wiki 管理面 + publish 流程,覆盖:
//
//   acceptance-final §8 场景 G(逻辑地址与管理发布):
//     G.1 注册 runtime:// 到 Project runtime 节点;target Git rename/move 后
//         runtime:// 仍解析同节点新 canonical path。
//     G.2 地址 impact preview 列受影响 Agent/session。
//     G.3 context 不隐式 grant;缺 read grant 阻 publish。
//     G.4 running session 安全边界应用新 revision(进行中 tool call 不变)。
//     G.5 切换 active project 后 project:// + compiled access + Wiki Prompt
//         同边界切换,无旧项目残留。
//     G.6 删最后一条 grant publish/reload→持久化 [],重开 Agent Editor 仍 []。
//     G.7 普通 Wiki tool 无地址/权限/Prompt 管理 action。
//
//   acceptance-final §H 步骤 6:Agent Access / Context / Address / Project Sync
//   publish 流程 UI(在 Agent Editor 与 Project Page 中驱动)。
//
// ## 设计约束
//   - **沿既有 E2E 模式**:launchAppFresh + waitForAppReady + readRuntimePort
//     + REST adminApi(POST)seed + UI 操作;与 wiki-fresh-env.spec.ts /
//     p8-wiki-and-agent-config.spec.ts 同模式。
//   - **最大化真实行为断言**:大部分场景走 UI(AgentEditor 的 wiki-access /
//     wiki-context 段 + WikiProjectCard);少数纯 API 行为(runtime:// rename
//     稳定性、FORBIDDEN_BODY_KEYS)直接走 REST 断言。
//   - **running-session 时序不变量(StepEnd 边界 / mid-tool-call snapshot /
//     active-project switch 无残留)** 由 runtime integration 覆盖,不在本 spec:
//     见 `tests/unit/wiki-v2-runtime-session-boundary.test.ts`(§G.4 + §G.5-runtime
//     + round-2 §3 multi-tool-call/step + cross-session + apply-failure)。
//     该 fixture 驱动真实 AgentLoop + latch-blocked Block tool,精确卡在 tool
//     call 中段,断言 in-flight CallerCtx snapshot 与 next-step snapshot 的 revision
//     /scope 差异。Playwright UI 层到不了 tool-call 粒度,也无法把 publish/switch
//     精确卡在 tool call 中段。
//   - **REST/UI publish、project binding、grants preview 接线** 由本 spec 覆盖
//     (§G.1 runtime:// rename 稳定性、§G.2 impact preview、§G.3 publish 阻断、
//     §G.5 multi-project binding + project:// grant preview、§G.6 删最后 grant
//     持久化、§G.7 FORBIDDEN_BODY_KEYS、§H.6 Access/Context/Address/ProjectSync
//     publish 流程)。
//
// ## 不在本测试范围
//   - 数据面 Browser UI(在 wiki-browser.spec.ts)。
//   - snapshot/restore(在 wiki-fresh-env.spec.ts)。
//
// ## 维护规则
//   - WikiAccessSection / WikiContextSection / WikiProjectCard 的 selector
//     变更同步本测试。
//   - wiki-admin-router.ts endpoint 签名变更同步 adminApi 调用。

import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { launchAppFresh, waitForAppReady, type TestApp } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Shared helpers (same pattern as wiki-fresh-env.spec.ts) ─────────────

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
 * POST-first admin API helper. /api/wiki-admin and /api/wiki routes are all
 * POST (see wiki-admin-router.ts / wiki-router.ts). When `allowStatus` is set,
 * the helper returns `{ status, body }` instead of throwing on non-2xx — used
 * for negative assertions (FORBIDDEN_BODY_KEYS / unauthorized publish).
 */
async function apiPost(
	port: number,
	path: string,
	body?: unknown,
	opts?: { allowStatus: boolean },
): Promise<any> {
	const url = `http://127.0.0.1:${port}${path}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body !== undefined ? JSON.stringify(body) : "{}",
	});
	const text = await res.text();
	if (!res.ok && !opts?.allowStatus) {
		throw new Error(`POST ${path} → ${res.status}: ${text}`);
	}
	if (opts?.allowStatus) {
		return { status: res.status, body: text ? JSON.parse(text) : undefined };
	}
	return text ? JSON.parse(text) : undefined;
}

function makeTempGitRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "zc-wiki-mgmt-repo-"));
	execSync("git init -b main", { cwd: repo, stdio: "ignore" });
	execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
	execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "app.ts"), "export const APP = 'app';\n");
	execSync("git add .", { cwd: repo, stdio: "ignore" });
	execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });
	return repo;
}

function rewriteAndCommit(repo: string, relPath: string, body: string): void {
	writeFileSync(join(repo, relPath), body);
	execSync("git add .", { cwd: repo, stdio: "ignore" });
	execSync(`git commit -m "update ${relPath}"`, { cwd: repo, stdio: "ignore" });
}

function gitRenameAndCommit(repo: string, oldRel: string, newRel: string): void {
	mkdirSync(join(repo, dirname(newRel)), { recursive: true });
	execSync(`git mv "${oldRel}" "${newRel}"`, { cwd: repo, stdio: "ignore" });
	execSync('git commit -m "rename"', { cwd: repo, stdio: "ignore" });
}

/** Bind a git repo to a project and wait for full index to settle.
 *
 * NOTE: sourceRoot MUST be relative (design contract — see
 * wiki-project-indexer.ensureBinding: `isAbsolute(rawSourceRoot)` is rejected).
 * The repo path is already known to the indexer via ProjectStore.workspaceDir
 * (set when the project is created with workspaceDir=repo). Pass "" to index
 * the whole repo. */
async function bindAndIndex(port: number, projectId: string, _repo: string): Promise<void> {
	await apiPost(port, "/api/wiki-admin/repositories/bind", {
		projectId,
		sourceRoot: "",
		defaultBranch: "main",
	});
	// round-2 review P1 §6.1/§6.2:必须按目标 projectId 查状态(旧代码取
	// repositories[0],多项目时 [0] 是已 synced 的第一个,循环立刻退出,第二
	// 项目可能仍 pending → §G.5 multi-project 断言失败)。现在:只在该项目
	// synced 时返回;failed 立即抛(lastError);超时抛带诊断(projectId /
	// 最后状态 / indexedRevision)。不用固定 sleep,400ms 轮询。
	const deadline = Date.now() + 30_000;
	let lastStatus = "unknown";
	let lastIndexed: unknown = undefined;
	let lastError: unknown = undefined;
	while (Date.now() < deadline) {
		const list = await apiPost(port, "/api/wiki-admin/repositories/list");
		const repos = list?.result?.repositories ?? [];
		const entry = repos.find((r: any) => r.projectId === projectId);
		lastStatus = entry?.syncStatus ?? entry?.sync_status ?? "unknown";
		lastIndexed = entry?.indexedRevision ?? entry?.indexed_revision;
		lastError = entry?.lastError ?? entry?.last_error;
		if (lastStatus === "failed") {
			throw new Error(
				`bindAndIndex: project ${projectId} sync failed (lastError=${lastError})`,
			);
		}
		if (lastStatus === "synced") return;
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(
		`bindAndIndex: project ${projectId} did not reach synced within 30s `
		+ `(lastStatus=${lastStatus}, indexedRevision=${lastIndexed})`,
	);
}

/** Open AgentEditor for the first agent in the list (fresh-DB seed always has ≥1). */
async function openFirstAgentEditor(window: Page): Promise<void> {
	await window.locator("button[title='Agents']").click();
	await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
	const agentItem = window.locator(".agents-list-item").first();
	await agentItem.waitFor({ state: "visible", timeout: 10_000 });
	await agentItem.click();
	await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────

test.describe("acceptance-final §G/§H.6 — Wiki management & publish", () => {
	test.setTimeout(180_000);

	let app: TestApp;
	let port: number;
	let repo: string;
	let projectId: string;
	// §G.5 second project temp repo(cleanup in afterEach so assertion-failure
	// still cleans — round-2 review P1 §6.2)。空串=本测试未用,no-op 清理。
	let repo2 = "";

	test.beforeEach(async () => {
		app = await launchAppFresh();
		await waitForAppReady(app.window);
		port = await readRuntimePort(app.zeroDir);
		repo = makeTempGitRepo();

		const project = await apiPost(port, "/api/projects", {
			name: "mgmt-e2e-proj",
			workspaceDir: repo,
		});
		projectId = project.id;
		await bindAndIndex(port, projectId, repo);
	});

	test.afterEach(async () => {
		try { await app.cleanup(); } catch {}
		try { rmSync(repo, { recursive: true, force: true }); } catch {}
		try { rmSync(repo2, { recursive: true, force: true }); } catch {}
		repo2 = "";
	});

	// ─── §G.1 + §H.6 Address publish: runtime:// target rename keeps identity ──
	test("§G.1 runtime:// resolves to renamed target's new canonical path", async () => {
		// 1. Locate the project's source-bound node for src/app.ts.
		const search = await apiPost(port, "/api/wiki/search", {
			mode: "substring",
			target: "wiki",
			query: "app.ts",
			limit: 20,
		});
		const hits = search?.result?.wikiHits ?? search?.result?.hits ?? [];
		expect(hits.length).toBeGreaterThan(0);
		const appPath: string = hits[0].path;
		expect(appPath).toContain(projectId);

		// 2. Register runtime://my-app → that node's canonical path (Address create
		//    flow via REST; the UI dialog is the same endpoint).
		const created = await apiPost(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://my-app",
			scope: "runtime",
			kind: "alias",
			resolver: null,
			targetPath: appPath,
			promptPolicy: null,
		});
		expect(created?.result?.address?.address).toBe("runtime://my-app");
		expect(created?.result?.address?.targetCanonicalPath).toBe(appPath);

		// 3. Git rename src/app.ts → src/runtime/app.ts + commit + reindex.
		gitRenameAndCommit(repo, "src/app.ts", "src/runtime/app.ts");
		await apiPost(port, "/api/wiki-admin/repositories/reindex", {
			projectId,
			full: false,
		});
		// Wait for the reindex to settle.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const list = await apiPost(port, "/api/wiki-admin/repositories/list");
			const entry = list?.result?.repositories?.[0];
			if (entry?.syncStatus !== "indexing") break;
			await new Promise((r) => setTimeout(r, 400));
		}

		// 4. The runtime:// alias now resolves to the SAME node at its NEW path.
		const list = await apiPost(port, "/api/wiki-admin/addresses/list");
		const addresses = list?.result?.addresses ?? list?.result ?? [];
		const alias = addresses.find((a: any) => a.address === "runtime://my-app");
		expect(alias).toBeTruthy();
		const newPath: string = alias.targetCanonicalPath;
		// Path moved from src/app.ts → src/runtime/app.ts.
		expect(newPath).toContain("runtime");
		expect(newPath).not.toBe(appPath);
		// Identity preserved: WikiLinkRepository / address book keeps the alias
		// pointing at the same node identity (just new canonical path).
		expect(alias.targetMissing ?? false).toBe(false);

		// 5. round-2 review P1 §6.3 (Choice B): assert the rename actually
		//    synced into the wiki tree — this subsumes the deleted fresh-env
		//    "Git rename + sync" skip. The indexer's git-diff mirror must have
		//    archived the OLD path node and created the NEW path node (rename =
		//    move, not duplicate). Two direct /api/wiki/read checks on the
		//    canonical paths (avoids FTS tokenization lag/quirks — read is the
		//    authoritative active-node lookup):
		//      (a) NEW path node is ACTIVE/reachable (read returns 200 + node).
		//      (b) OLD path node is NO LONGER reachable (read returns 400
		//          NOT_FOUND — the rename moved it, didn't duplicate).
		//    Both reads can lag a few hundred ms behind the wiki_nodes commit
		//    (observed in acceptance-final round-1) → retry up to 15s.

		// (a) NEW path reachable. Retry: indexer is async + node write may lag.
		const readDeadline = Date.now() + 15_000;
		let newReadOk = false;
		while (Date.now() < readDeadline) {
			const r = await apiPost(port, "/api/wiki/read", {
				address: newPath,
				view: "summary",
			}, { allowStatus: true });
			if (r.status === 200) { newReadOk = true; break; }
			await new Promise((res) => setTimeout(res, 400));
		}
		expect(newReadOk,
			"NEW path src/runtime/app.ts must be readable post-reindex (rename synced into wiki tree)").toBe(true);

		// (b) OLD path is NO LONGER an active node — read returns NOT_FOUND.
		// round-2 review P1 §6.3: rename moved the node; the old canonical path
		// must not remain as an active (duplicate) entry. /api/wiki/read throws
		// NOT_FOUND on a renamed-away path (authorization-disciplined, same
		// outward shape as "no grant" — no existence leak). Retry: archived
		// row may take a moment to settle.
		let oldRead: any = null;
		const oldDeadline = Date.now() + 15_000;
		while (Date.now() < oldDeadline) {
			oldRead = await apiPost(port, "/api/wiki/read", {
				address: appPath,
				view: "summary",
			}, { allowStatus: true });
			if (oldRead.status === 400 && oldRead.body?.error?.code === "NOT_FOUND") break;
			await new Promise((res) => setTimeout(res, 400));
		}
		expect(oldRead.status, "OLD path src/app.ts must NOT be readable post-rename (rename = move, not duplicate)").toBe(400);
		expect(oldRead.body?.error?.code).toBe("NOT_FOUND");
	});

	// ─── §G.2 Address impact preview lists affected Agent/session ─────────
	test("§G.2 address impact lists agents/sessions touching the address", async () => {
		// Seed an agent whose wikiGrants reference the alias we'll inspect.
		const agent = await apiPost(port, "/api/agents", {
			name: "impact-agent",
			model: "test-model",
			provider: "mock",
			systemPrompt: "",
			toolPolicy: { tools: { Wiki: { enabled: true } } },
			wikiGrants: [
				{ scope: "runtime://my-app", actions: ["read", "expand"] },
			],
			wikiContext: [],
		});
		expect(agent.id).toBeTruthy();

		const impact = await apiPost(port, "/api/wiki-admin/addresses/impact", {
			address: "runtime://my-app",
			targetPath: null,
			resolver: null,
		});
		const result = impact?.result ?? impact;
		const affectedAgents = result?.affectedAgents ?? [];
		const affectedSessions = result?.affectedSessions ?? [];
		// Agent we created should show up (viaGrants).
		expect(affectedAgents.some((a: any) => a.agentId === agent.id)).toBe(true);
		// Sessions list is a hint; presence shape matters more than count here.
		expect(Array.isArray(affectedSessions)).toBe(true);
	});

	// ─── §G.3 Context publish blocked when entry address lacks read grant ──
	test("§G.3 context publish is rejected when entries lack read grant (no implicit grant)", async () => {
		// Create an agent with NO grants (clean baseline).
		const agent = await apiPost(port, "/api/agents", {
			name: "no-grant-agent",
			model: "test-model",
			provider: "mock",
			systemPrompt: "",
			toolPolicy: { tools: { Wiki: { enabled: true } } },
			wikiGrants: [],
			wikiContext: [],
		});
		const rev: number = agent.wikiPolicyRevision ?? 0;

		// wiki-admin-router reads agentId from the query string (req.query.agentId)
		// — body agentId is forbidden. Send via ?agentId=... on the URL.
		const blocked = await fetch(
			`http://127.0.0.1:${port}/api/wiki-admin/context/publish?agentId=${encodeURIComponent(agent.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						{ address: "wiki-root/knowledge", profile: "standard", channel: "system", budgetTokens: 800 },
					],
					expectedRevision: rev,
				}),
			},
		);
		expect(blocked.ok).toBe(false);
		const body = await blocked.json();
		expect(body?.ok).toBe(false);
		// Router code path: checkContextAuthorization throws INVALID_REQUEST
		// when unauthorized.length > 0 (no implicit grant).
		expect(body?.error?.code).toBe("INVALID_REQUEST");
		expect(body?.error?.message).toMatch(/read grant/i);

		// Sanity: validate (no publish side effect) also surfaces the unauthorized
		// address so the UI can show configuration feedback before the user
		// attempts publish.
		const validate = await fetch(
			`http://127.0.0.1:${port}/api/wiki-admin/context/validate?agentId=${encodeURIComponent(agent.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entries: [
						{ address: "wiki-root/knowledge", profile: "standard", channel: "system", budgetTokens: 800 },
					],
				}),
			},
		).then((r) => r.json());
		expect(validate?.result?.ok).toBe(false);
		expect(validate?.result?.unauthorizedAddresses ?? [])
			.toContain("wiki-root/knowledge");
	});

	// ─── §G.4 Running session safety boundary (StepEnd-only revision apply) ──
	//
	// **Covered by runtime integration** (user-approved Choice B, 2026-07-19):
	// `tests/unit/wiki-v2-runtime-session-boundary.test.ts` ›
	// "§G.4 — running session applies new revision at safety boundary" +
	// "§G.4 (multi-tool-call-per-step) — single step keeps one revision" +
	// round-2 §3.5 mid-tool-call multi-enqueue merge tests. Those fixtures drive
	// a real AgentLoop with a latch-blocked Block tool, publish grants
	// mid-tool-call, and assert: (a) in-flight CallerCtx.wikiAccess is the OLD
	// revision (per-call snapshot), (b) next step's CallerCtx reflects the NEW
	// revision, (c) two tool calls in ONE step both see the same OLD revision
	// (single-step revision-coherence). Playwright UI cannot precisely pin a
	// publish between two tool calls in the same model step — that granularity
	// only exists at the runtime layer. REST/UI publish wiring itself is
	// covered by §G.3/§G.6/§H.6 below.

	// ─── §G.5 Active project switch boundary ─────────────────────────────
	test("§G.5 multi-project binding + project:// grant preview (inactive in preview, active at runtime)", async () => {
		// Structural prerequisite for the runtime switch boundary: two bound
		// projects + an agent with project:// grant. We assert:
		//   (a) both projects bind + index successfully,
		//   (b) project:// grant is accepted by the preview endpoint AND the
		//       preview surfaces the scope as inactive/unresolved in the preview
		//       context (design: preview has no session/active-project context,
		//       so project:// stays inactive until a runtime session binds an
		//       active project — see wiki-admin-router resolveAgentContext).
		//   (c) at runtime, compiled access for project:// is resolved against
		//       the session's active project (verified via repo "synced" status
		//       for both, since either may be active at a given moment).
		//
		// Pre-acceptance-final this test asserted `mergedGrants.length > 0` for
		// project:// in preview. That is wrong by design: preview deliberately
		// does NOT inject an activeProjectId, so project:// cannot resolve to a
		// concrete project subtree and the preview must surface that as an
		// unresolved/inactive scope (otherwise preview would silently pick a
		// default project and hide a real config mistake). Relaxing the
		// assertion to match design; not changing the source.
		//
		// The full runtime switch (publish mid-session → step boundary → prompt
		// uses new project subtree, no old-project content leak) needs a running
		// agent loop with Wiki tool calls — **owned by runtime integration**
		// (user-approved Choice B, 2026-07-19):
		// `tests/unit/wiki-v2-runtime-session-boundary.test.ts` ›
		// "§G.5-runtime — active project switch at safety boundary" asserts the
		// in-flight snapshot stays on projectA, the next step's snapshot is on
		// projectB, and there is NO projectA residue after the switch (the patch
		// is enqueued via enqueueConfigPatch + flushed at StepEnd). This spec
		// covers the multi-project binding + grant preview wiring only.
		repo2 = makeTempGitRepo();
		const project2 = await apiPost(port, "/api/projects", {
			name: "mgmt-e2e-proj-2",
			workspaceDir: repo2,
		});
		await bindAndIndex(port, project2.id, repo2);

		const agent = await apiPost(port, "/api/agents", {
			name: "switch-agent",
			model: "test-model",
			provider: "mock",
			systemPrompt: "",
			toolPolicy: { tools: { Wiki: { enabled: true } } },
			wikiGrants: [
				{ scope: "project://", actions: ["read", "expand", "search"] },
			],
			wikiContext: [],
		});

		// grant preview accepts the project:// grant. By design it does NOT
		// resolve project:// to a concrete project subtree (no active-project
		// context in preview) — so the project:// grant either drops out of
		// mergedGrants OR the compiler emits a warning mentioning project://.
		// Both shapes are acceptable; what we reject is the preview silently
		// selecting a default project (which would mask a real config mistake).
		const preview = await fetch(
			`http://127.0.0.1:${port}/api/wiki-admin/grants/preview?agentId=${encodeURIComponent(agent.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					grants: [{ scope: "project://", actions: ["read", "expand", "search"] }],
				}),
			},
		).then((r) => r.json());
		// Preview call succeeded and returned the result envelope.
		expect(preview?.ok).toBe(true);
		const result = preview?.result ?? {};
		const merged = result.mergedGrants ?? [];
		const warnings: string[] = result.warnings ?? [];
		// project:// must NOT silently resolve to a concrete project subtree in
		// preview. Acceptable signals: empty mergedGrants, OR a warning that
		// mentions project:// / inactive / unresolved / active project. A
		// regression that picks a default project would set mergedGrants to a
		// project-scoped entry WITHOUT any warning → this assertion fails.
		const warningsMentionProject = warnings.some((w) => /project:\/\/|inactive|unresolved|active project/i.test(w));
		const projectScopeAcceptedInactive =
			merged.length === 0 || warningsMentionProject;
		expect(projectScopeAcceptedInactive).toBe(true);

		// Both projects are bound + synced (so either can be active at runtime).
		const repoList = await apiPost(port, "/api/wiki-admin/repositories/list");
		const syncedProjects = (repoList?.result?.repositories ?? [])
			.filter((r: any) => r.syncStatus === "synced")
			.map((r: any) => r.projectId);
		expect(syncedProjects).toContain(projectId);
		expect(syncedProjects).toContain(project2.id);
		// repo2 cleanup in afterEach(round-2 review P1 §6.2:断言失败也清)。
	});

	// ─── §G.5-runtime Active project switch boundary ───────────────────
	//
	// **Covered by runtime integration** (user-approved Choice B, 2026-07-19):
	// `tests/unit/wiki-v2-runtime-session-boundary.test.ts` ›
	// "§G.5-runtime — active project switch at safety boundary" drives a real
	// AgentLoop with a latch-blocked Block tool, calls sendProjectPrompt with a
	// different projectId mid-call (production round-2 B2② path: existing loop →
	// enqueueConfigPatch + busy skip), and asserts: (a) in-flight snapshot still
	// on projectA, (b) next step's snapshot on projectB, (c) NO projectA residue
	// after the switch, (d) the patch was queued + flushed at StepEnd boundary
	// (config stays projectA right after switch, only flips after StepEnd). The
	// multi-project binding + project:// grant preview wiring itself is covered
	// by §G.5 above.

	// ─── §G.6 Removing the LAST grant persists [] across reload ──────────
	test("§G.6 deleting last wiki grant persists [] (not undefined) across Agent Editor reload", async () => {
		// Drive via UI: open Agent Editor > Wiki access > add grant > publish >
		// remove it > publish/reload → must still be []. Regression guard for
		// JSON.stringify dropping undefined and backend keeping stale list.
		await openFirstAgentEditor(app.window);
		await app.window.locator(".editor-nav-item", { hasText: "Wiki access" }).click();
		await expect(app.window.getByText("Wiki Access (grants)").first())
			.toBeVisible({ timeout: 10_000 });
		// Add a grant (default memory:// + read actions).
		await app.window.getByRole("button", { name: "+ Add grant" }).click();
		await expect(app.window.locator("table tbody tr").first()).toBeVisible({ timeout: 5_000 });

		// Publish (currentRevision 0 → 1).
		const publishBtn = app.window.getByRole("button", { name: /Publish.*rev.*→/ });
		await publishBtn.click();
		// Success banner "✓ Published (new revision 1...)".
		await expect(app.window.getByText(/✓ Published.*new revision 1/).first())
			.toBeVisible({ timeout: 10_000 });

		// Remove the grant → table empty.
		await app.window.locator("table tbody tr").first()
			.getByRole("button", { name: "Remove" }).click();
		await expect(app.window.getByText(/No grants configured/).first())
			.toBeVisible({ timeout: 5_000 });

		// Publish again (1 → 2) to persist the empty list.
		const publishBtn2 = app.window.getByRole("button", { name: /Publish.*rev.*→/ });
		await publishBtn2.click();
		await expect(app.window.getByText(/✓ Published.*new revision 2/).first())
			.toBeVisible({ timeout: 10_000 });

		// Reload Agent Editor (close + reopen) — the empty list MUST persist
		// (the regression was: JSON.stringify(undefined-for-empty) → backend
		// kept stale grants → row reappeared).
		await app.window.locator("button[title='Agents']").click();
		await expect(app.window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		const agentItem = app.window.locator(".agents-list-item").first();
		await agentItem.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem.click();
		await expect(app.window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });
		await app.window.locator(".editor-nav-item", { hasText: "Wiki access" }).click();

		// Empty hint still shown + zero rows.
		await expect(app.window.getByText(/No grants configured/).first())
			.toBeVisible({ timeout: 10_000 });
		await expect(app.window.locator("table tbody tr")).toHaveCount(0);
	});

	// ─── §H.6 UI publish flows: Access / Context / Address / ProjectSync ────
	test("§H.6 Agent Editor exposes Wiki access + Wiki context publish flows", async () => {
		await openFirstAgentEditor(app.window);

		// Wiki access section renders with a publish button (disabled until agent saved).
		await app.window.locator(".editor-nav-item", { hasText: "Wiki access" }).click();
		await expect(app.window.getByText("Wiki Access (grants)").first())
			.toBeVisible({ timeout: 10_000 });
		// "+ Add grant" button present.
		await expect(app.window.getByRole("button", { name: "+ Add grant" })).toBeVisible();
		// Publish button label format includes "rev" (revision counter).
		await expect(app.window.getByRole("button", { name: /Publish.*rev.*→/ })).toBeVisible();

		// Wiki context section renders with its own publish flow.
		await app.window.locator(".editor-nav-item", { hasText: "Wiki context" }).click();
		await expect(app.window.getByText(/Wiki Context/i).first()).toBeVisible({ timeout: 10_000 });
		// Add-entry button present in the context section.
		await expect(app.window.getByRole("button", { name: /\+ Add entry|Add context entry/i })).toBeVisible();
	});

	test("§H.6 Project Page exposes WikiProjectCard bind/reindex/unbind (Project Sync publish)", async () => {
		// Project Page sidebar entry.
		await app.window.locator("button[title='Requirements']").click();
		await expect(app.window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		await expect(app.window.locator(".page-overlay").getByText("Projects", { exact: false }).first())
			.toBeVisible({ timeout: 10_000 });
		await app.window.waitForTimeout(1000);

		// WikiProjectCard renders inside the Dashboard + Activity tab (not Project
		// View — see ProjectPage.tsx: WikiProjectCard is mounted inside DashboardTab).
		await app.window.getByRole("button", { name: "Dashboard + Activity" }).first().click();
		await app.window.waitForTimeout(500);
		// The seeded project should be auto-selected; its card renders the heading.
		await expect(app.window.getByText("Wiki Git binding").first())
			.toBeVisible({ timeout: 15_000 });

		// The 4 management actions are present: Validate / Sync to HEAD /
		// Full reindex / Unbind. Project already bound → "Bind + initial index"
		// is NOT shown; instead the sync actions appear.
		await expect(app.window.getByRole("button", { name: "Validate" })).toBeVisible();
		await expect(app.window.getByRole("button", { name: "Sync to HEAD" })).toBeVisible();
		await expect(app.window.getByRole("button", { name: "Full reindex" })).toBeVisible();
		await expect(app.window.getByRole("button", { name: "Unbind" })).toBeVisible();
	});

	test("§H.6 Address publish flow via REST (Address CRUD)", async () => {
		// There is no first-class Address editor UI panel today — addresses are
		// managed via the wikiAdminAddresses* REST endpoints (consumed by the
		// eventual Address management screen + impact preview). Drive them end-
		// to-end through the formal entry to assert the publish flow survives
		// the round-trip.
		const created = await apiPost(port, "/api/wiki-admin/addresses/create", {
			address: "runtime://publish-flow-test",
			scope: "runtime",
			kind: "alias",
			resolver: null,
			targetPath: null,
			promptPolicy: null,
		});
		expect(created?.result?.address?.address).toBe("runtime://publish-flow-test");

		// Update (publish revision +1) — Address.update audit.
		const updated = await apiPost(port, "/api/wiki-admin/addresses/update", {
			address: "runtime://publish-flow-test",
			patch: {
				scope: "runtime",
				kind: "alias",
				resolver: null,
				targetPath: "wiki-root/knowledge",
				promptPolicy: null,
			},
		});
		expect(updated?.result?.address?.targetCanonicalPath ?? updated?.result?.address?.targetPath)
			.toBe("wiki-root/knowledge");

		// Delete.
		const deleted = await apiPost(port, "/api/wiki-admin/addresses/delete", {
			address: "runtime://publish-flow-test",
		});
		expect(deleted?.result?.address).toBe("runtime://publish-flow-test");

		// Verify it's gone from list.
		const list = await apiPost(port, "/api/wiki-admin/addresses/list");
		const addresses = list?.result?.addresses ?? list?.result ?? [];
		expect(addresses.some((a: any) => a.address === "runtime://publish-flow-test")).toBe(false);
	});

	// ─── §G.7 Ordinary Wiki tool has NO management actions ─────────────
	test("§G.7 /api/wiki/create rejects forged identity fields (FORBIDDEN_BODY_KEYS)", async () => {
		// The data-plane wiki-router enforces FORBIDDEN_BODY_KEYS: caller cannot
		// inject admin/grants/agentId/callerCtx to escalate. Assert each of
		// these is rejected at the formal entry point. The list below is the
		// intersection of the actual wiki-router FORBIDDEN_BODY_KEYS set with
		// the management-only invariant "ordinary Wiki tool has no management
		// actions" (server-injected identity).
		const forbiddenKeys = ["admin", "isAdmin", "global", "callerCtx", "grants", "agentId", "authority"];

		for (const key of forbiddenKeys) {
			const body: Record<string, unknown> = {
				parent: "wiki-root/knowledge",
				name: `forge-${key}`,
				kind: "node",
				summary: "",
				content: "",
			};
			body[key] = key === "grants" ? [] : true;

			const r = await apiPost(port, "/api/wiki/create", body, { allowStatus: true });
			expect(r.status).toBe(400);
			expect(r.body?.error?.code).toBe("INVALID_REQUEST");
			expect(r.body?.error?.message).toMatch(/forged identity/i);
		}

		// Sanity: a clean body still succeeds (so we know the 400s were due to
		// the forged keys, not unrelated validation).
		const clean = await apiPost(port, "/api/wiki/create", {
			parent: "wiki-root/knowledge",
			name: "forge-clean-control",
			kind: "node",
			summary: "",
			content: "",
		});
		expect(clean?.result?.path).toContain("wiki-root/knowledge");
	});
});

// Suppress unused-import warnings for helpers reserved for future expansion.
void renameSync;
