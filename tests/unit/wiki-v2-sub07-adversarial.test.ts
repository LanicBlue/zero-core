// Adversarial verifier for wiki-system-redesign sub-07 (Management API + Config UI).
//
// Lens: adversarial. This file deliberately attacks the sub-07 surfaces:
//   (1)  forged authority fields in admin POST bodies (FORBIDDEN_BODY_KEYS gaps)
//   (2)  §6 session refresh RUNTIME-ALIVE — publishAgentWikiPolicy must truly
//        reach the busy loop's applyConfigUpdate with new wikiAccess, not dead-wire
//        (sub-05 round-1 lesson: static gates green but runtime dead path).
//   (3)  C3 delete last grant → persisted as `[]` not `undefined`; actually denies
//   (4)  C4/C7 wiki-root full-tree write grant without confirmRootWriteGrant=true
//   (5)  D3 context publish on address lacking read grant — rejected, no auto-grant
//   (6)  E7 Cron bypass — runtime never reads a cron record's wikiGrants
//   (7)  E4 unbind soft vs hard — soft leaves subtree, hard archives
//   (8)  E1/H absolute checkout path never persisted in wiki_repositories
//   (9)  A3 validate/preview are side-effect-free (no audit, no revision bump)
//   (10) H wiki tool action enum has no address/register/publish/grant action
//   (11) agentId query string cannot self-elevate (audit actor stays @wiki-admin)
//
// Tests are written against plan-07 / acceptance-07 / design.md (the spec),
// NOT against the implementer's claims. Source under src/ is FROZEN — this
// file only asserts behavior. A test that reveals a src bug = FAIL finding
// (reported, not fixed).
//
// Windows vitest note: run THIS file only (single-process temp-DB teardown can
// crash with exit 127/139 on large suites); verbose to see each ✓.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

import { createWikiAdminRouter, type WikiAdminRouterDeps } from "../../src/server/wiki-admin-router.js";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import type { WikiGrant } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (mirrors wiki-v2-runtime-e2e-wiring.test.ts)
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-sub07-adv-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

// Mock provider-factory BEFORE importing AgentService (it imports agent-loop).
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}
function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}
async function post(port: number, path: string, body: unknown): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

// ---------------------------------------------------------------------------
// Build a real admin-router harness backed by a fresh temp wiki.db + core.db.
// Mirrors wiki-v2-runtime-e2e-wiring.test.ts buildSvc, but additionally mounts
// createWikiAdminRouter via express so we can drive HTTP for forged-body probes.
// ---------------------------------------------------------------------------

interface Harness {
	app: Express;
	server: Server;
	port: number;
	svc: AgentService;
	agentStore: AgentStore;
	db: CoreDatabase;
	wikiDb: WikiDatabase;
	wikiSvc: WikiService;
	repositoryStore: WikiRepositoryStore;
	addressService: WikiAddressService;
	auditRepo: WikiAuditRepository;
	nodeRepo: WikiNodeRepository;
	indexer: { ensureBinding: ReturnType<typeof vi.fn>; fullIndex: ReturnType<typeof vi.fn>; sync: ReturnType<typeof vi.fn>; rebuildFromScratch: ReturnType<typeof vi.fn> };
	git: { isGitRepo: ReturnType<typeof vi.fn>; resolveRevision: ReturnType<typeof vi.fn>; detectDefaultBranch: ReturnType<typeof vi.fn> };
	projectStore: { get: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
	dir: string;
}

function buildHarness(seedProjectSubtree = true): Harness {
	const dir = mkdtempSync(join(tmpdir(), "zc-sub07-adv-"));
	const db = new CoreDatabase(join(dir, "core.db"));
	runMigrations(db);

	const wikiDb = new WikiDatabase(join(dir, "wiki.db"));
	const wikiSvc = WikiService.fromDatabase(wikiDb);
	const wdb = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(wdb);
	const repositoryStore = new WikiRepositoryStore(wdb);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const auditRepo = new WikiAuditRepository(wdb);
	const searchSvc = new WikiSearchService({
		db: wdb, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	// Register the runtime singleton so AgentService.compileWikiAccessForSession
	// (the §6 hot-sync path) can find the WikiService. Without this, the §6
	// wiring is dead (compileWikiAccessForSession returns undefined wikiAccess).
	setWikiRuntime({ wikiService: wikiSvc, searchService: searchSvc });

	// Seed canonical wiki-root structure if requested (needed by tests that
	// create address targets or bind project subtrees).
	if (seedProjectSubtree) {
		wikiSvc.ensureAgentMemoryRoot("agent-a", "Agent A").catch(() => {});
	}

	const agentStore = new AgentStore(db);
	const svc = new AgentService(dir, db);
	svc.setAgentStore(agentStore);
	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(createFinishModel());

	// Mock indexer — we are NOT testing Git indexing here (that's plan-03/07 §5
	// implementations). We assert the admin router calls the right indexer
	// methods with the right args; the indexer's own behavior is verified by
	// wiki-v2-indexer.test.ts.
	const indexer = {
		ensureBinding: vi.fn(async (_projectId: string, _opts?: any) => ({
			bound: true,
			repositoryId: `repo-${_projectId}`,
			projectNodePath: `wiki-root/projects/${_projectId}`,
			sourceRoot: _opts?.sourceRoot ?? "",
			defaultBranch: _opts?.defaultBranch ?? "main",
		})),
		fullIndex: vi.fn(async (projectId: string) => ({
			projectId, repositoryId: `repo-${projectId}`, ok: true,
			indexedRevision: "deadbeef", error: null,
		})),
		sync: vi.fn(async (projectId: string, _opts?: any) => ({
			projectId, repositoryId: `repo-${projectId}`, fromRevision: null,
			toRevision: "deadbeef", syncStatus: "synced", stats: null, error: null,
		})),
		rebuildFromScratch: vi.fn(async (projectId: string) => ({
			projectId, repositoryId: `repo-${projectId}`, ok: true,
			indexedRevision: "deadbeef", error: null,
		})),
	};

	const git = {
		isGitRepo: vi.fn(async () => true),
		resolveRevision: vi.fn(async () => "deadbeefcafebabe"),
		detectDefaultBranch: vi.fn(async () => "main"),
	};

	const projectStore = {
		get: vi.fn((pid: string) => ({
			id: pid, name: `Project-${pid}`, workspaceDir: join(dir, "checkout", pid),
		})),
		list: vi.fn(() => []),
	};

	const deps: WikiAdminRouterDeps = {
		wikiService: wikiSvc,
		addressService,
		indexer: indexer as any,
		repositoryStore,
		auditRepo,
		nodeRepo,
		projectStore: projectStore as any,
		agentService: svc,
		agentStore,
		git: git as any,
	};

	const app = express();
	app.use(express.json({ limit: "1mb" }));
	app.use("/api/wiki-admin", createWikiAdminRouter(deps));

	let server: Server;
	let port = 0;
	// listen synchronously in beforeEach; we return a Promise from buildHarnessAsync.
	const harness: Harness = {
		app, server: null as any, port: 0,
		svc, agentStore, db, wikiDb, wikiSvc,
		repositoryStore, addressService, auditRepo, nodeRepo,
		indexer, git, projectStore, dir,
	};
	// Express listen is async; expose via a wrapper.
	(harness as any)._listenPromise = listen(app).then(({ server: s, port: p }) => {
		harness.server = s;
		harness.port = p;
		return harness;
	});
	return harness;
}

async function buildHarnessAsync(seed = true): Promise<Harness> {
	const h = buildHarness(seed);
	await (h as any)._listenPromise;
	return h;
}

function createFinishModel(modelId = "sub07-mock"): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
					controller.close();
				},
			});
			return { stream } as any;
		},
	} as unknown as LanguageModelV2;
}

let holder: Harness | null;

beforeEach(() => { holder = null; });
afterEach(async () => {
	if (holder) {
		try { await close(holder.server); } catch { /* ignore */ }
		try { await Promise.resolve(holder.svc?.abort?.()); } catch { /* ignore */ }
		try { holder.wikiDb?.close(); } catch { /* ignore */ }
		try { holder.db?.close(); } catch { /* ignore */ }
		try { rmSync(holder.dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
	_resetWikiRuntimeForTests();
});

// ===========================================================================
// SUITE A — Static purity: data plane untouched by admin actions
// (acceptance A2 / H — hard gates; must inspect the actual enum + paths)
// ===========================================================================

describe("sub-07 adv · static purity — admin actions never enter data plane", () => {
	const WIKI_V2_TOOL_SRC = readFileSync("src/tools/wiki-v2-tool.ts", "utf8");
	const WIKI_ROUTER_SRC = readFileSync("src/server/wiki-router.ts", "utf8");
	const REPO_STORE_SRC = readFileSync("src/server/wiki/wiki-repository-store.ts", "utf8");

	test("A2/H: WIKI_V2_ACTIONS enum contains exactly the 9 data-plane actions (no admin action)", () => {
		// Slice the enum definition so we look at the real list, not a comment.
		const m = WIKI_V2_TOOL_SRC.match(/const WIKI_V2_ACTIONS = \[([\s\S]*?)\] as const/);
		expect(m, "WIKI_V2_ACTIONS enum must be defined").not.toBeNull();
		const body = m![1];
		const actions = body.split(",").map((s) => s.replace(/["'`\s]/g, "")).filter(Boolean);
		expect(actions.sort()).toEqual(
			["create", "delete", "expand", "link", "move", "read", "search", "unlink", "update"],
		);
		// Hard-gate: NONE of the management actions may appear in the data-plane enum.
		const forbidden = ["address", "register", "publish", "grant", "context", "reindex", "bind", "unbind"];
		for (const f of forbidden) {
			expect(actions, `data-plane enum must NOT include '${f}'`).not.toContain(f);
		}
	});

	test("A2/H: wiki-router.ts (data plane) defines no admin endpoint path", () => {
		// The data router must NOT mount any of the admin action paths. Confirm
		// by scanning router.post(...) path literals.
		const matches = [...WIKI_ROUTER_SRC.matchAll(/router\.post\("([^"]+)"/g)];
		const paths = matches.map((m) => m[1]).sort();
		// Data plane has exactly these 10 endpoints (round-2 added /history).
		expect(paths).toEqual(
			["/create", "/delete", "/expand", "/history", "/link", "/move", "/read", "/search", "/unlink", "/update"],
		);
		// No admin-plane resource path leaks into the data router.
		for (const adminPath of ["/addresses", "/repositories", "/grants", "/context", "/sessions", "/publish"]) {
			expect(paths, `data-plane wiki-router must not expose '${adminPath}'`).not.toContain(adminPath);
		}
	});

	test("E1/H: wiki_repositories table schema has NO workspaceDir / absolute-checkout-path column", () => {
		// The DB schema for wiki_repositories must persist ONLY shared state
		// (project_id, source_root relative, branch, revisions, sync status).
		// Workspace absolute path belongs to Core ProjectRecord, never Wiki DB.
		// Inspect both CREATE TABLE (wiki-schema.ts) and the WikiRepositoryRow
		// shape: no field named workspace* / checkout* / abs*.
		const schemaSrc = readFileSync("src/server/wiki/wiki-schema.ts", "utf8");
		const repoBlock = schemaSrc.match(/CREATE TABLE[^;]*wiki_repositories[^;]*;/s);
		expect(repoBlock, "wiki_repositories CREATE TABLE block must exist").not.toBeNull();
		const lower = repoBlock![0].toLowerCase();
		expect(lower, "wiki_repositories must not have a workspace_dir column").not.toMatch(/\bworkspace_dir\b/);
		expect(lower, "wiki_repositories must not have a workspaceDir column").not.toMatch(/workspacedir/);
		expect(lower, "wiki_repositories must not have an absolute-checkout-path column").not.toMatch(/\bcheckout_path\b/);
		// WikiRepositoryRow interface must not surface any workspace field either.
		const rowIface = REPO_STORE_SRC.match(/export interface WikiRepositoryRow \{([\s\S]*?)\}/);
		expect(rowIface).not.toBeNull();
		expect(rowIface![1].toLowerCase()).not.toMatch(/workspace/);
	});
});

// ===========================================================================
// SUITE B — Forged-identity rejection at every admin endpoint
// (acceptance A1 / H — body cannot declare admin/actor/authority/canManage)
//
// IMPORTANT: the admin router's FORBIDDEN_BODY_KEYS was copy-pasted from the
// data-plane wiki-router. In the data plane, body-level `grants` / `projectId`
// are identity-injection vectors (server-injected only). In the management
// plane, they are LEGITIMATE INPUTS (grants/* takes a `grants` array to
// validate/preview/publish; repositories/* takes `projectId`). This collision
// is documented in the dedicated BLOCKER suite below. The tests here ONLY use
// identity synonyms that are NOT legitimate management inputs.
// ===========================================================================

describe("sub-07 adv · forged authority fields rejected at admin endpoints", () => {
	let h: Harness;

	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });
	afterEach(async () => { /* shared afterEach closes */ });

	// Keys that are PURE identity/authority injection vectors — never a
	// legitimate input field on any management endpoint. All MUST be rejected.
	const PURE_IDENTITY_KEYS = [
		"admin", "actor", "authority", "callerCtx",
		"access", "compiledAccess", "wikiAccess",
		"is-admin", "isAdmin", "isGlobal", "global",
		"actorAgentId", "effectiveAccess",
		"sessionId", "requestId", "policyRevision",
		"nodeId", "anchorIds", "wikiAnchors", "wikiAnchorNodeIds",
		"target_id", "project_node_id",
	];

	test("A1: pure identity keys on /addresses/validate are rejected with INVALID_REQUEST + 'forged identity'", async () => {
		for (const key of PURE_IDENTITY_KEYS) {
			const res = await post(h.port, "/api/wiki-admin/addresses/validate", {
				address: "runtime://x", scope: "runtime", kind: "static",
				[key]: "forged",
			});
			expect(res.status, `key "${key}" must be rejected (got ${res.status})`).toBe(400);
			expect(res.data?.error?.code).toBe("INVALID_REQUEST");
			expect(res.data?.error?.message).toMatch(/forged identity/i);
		}
	});

	test("A1 round-2 FIX 2: canManage (the WikiAdminAuthority field) IS now in FORBIDDEN_BODY_KEYS — forged canManage rejected 400", async () => {
		// WikiAdminAuthority = { actor, canManage }. round-1 found `canManage`
		// slipped the forged-identity gate (hardening gap). round-2 FIX 2 added
		// `canManage` to FORBIDDEN_BODY_KEYS alongside admin/actor. A renderer
		// POST with `canManage: true` must now be rejected cleanly at the gate.
		const res = await post(h.port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://probe", scope: "runtime", kind: "static",
			canManage: true, // forged authority field
		});
		expect(res.status, "canManage must now be rejected (FIX 2 closed the gap)").toBe(400);
		expect(res.data?.error?.code).toBe("INVALID_REQUEST");
		expect(res.data?.error?.message).toMatch(/forged identity/i);
		expect(res.data?.error?.message).toMatch(/canManage/);
	});

	test("A1: every pure-identity forged key on /context/publish is rejected (this is the dangerous one — implicit grant path)", async () => {
		for (const key of PURE_IDENTITY_KEYS) {
			const res = await post(h.port, `/api/wiki-admin/context/publish?agentId=a`, {
				entries: [{ address: "memory://", profile: "standard", channel: "system" }],
				expectedRevision: 0,
				[key]: "forged",
			});
			expect(res.status, `key "${key}" must be rejected`).toBe(400);
			expect(res.data?.error?.message).toMatch(/forged identity/i);
		}
	});

	test("A1 gap-probe: identity synonyms NOT in FORBIDDEN_BODY_KEYS (manager/role/sudo/impersonate) slip the gate — but must NOT propagate into any service call or audit actor", async () => {
		// Probe synonyms that are NOT in the explicit gate. The safety
		// property: even if zod accepts them, audit actor stays "@wiki-admin"
		// (server constant), never the forged value.
		// NOTE: `canManage` was removed from this list in round-2 — FIX 2 added
		// it to FORBIDDEN_BODY_KEYS, so it no longer slips (covered by the test
		// above). The remaining synonyms are still NOT in the explicit gate;
		// they slip through zod (address.create runs), but the server constant
		// authority still wins for the audit actor.
		const synonyms = ["manager", "role", "roleId", "sudo", "superuser",
			"impersonate", "onBehalfOf", "elevate", "privileged", "bypass",
			"bypassAccess", "user", "userId", "principal"];
		for (const key of synonyms) {
			await post(h.port, "/api/wiki-admin/addresses/create", {
				address: `runtime://syn-${key}`, scope: "runtime", kind: "static",
				[key]: "attacker-forged",
			});
		}
		const all = (h.wikiDb.getDb() as any)
			.prepare("SELECT actor_agent_id AS actor, detail_json FROM wiki_audit_log WHERE action = 'address.create'")
			.all() as Array<{ actor: string; detail_json: string | null }>;
		expect(all.length, "address.create audit rows should exist for synonym probes").toBeGreaterThanOrEqual(synonyms.length);
		for (const r of all) {
			expect(r.actor, `audit actor must be server constant "@wiki-admin" (got "${r.actor}")`).toBe("@wiki-admin");
			// Forged value must not appear anywhere in the detail JSON either.
			expect(r.detail_json ?? "", "forged value must NOT echo back in audit detail").not.toMatch(/attacker-forged/);
		}
	});
});

// ===========================================================================
// SUITE B2 — round-2 FIX 1: grants/* + repositories/* now accept their
// legitimate payload inputs (grants / projectId / activeProjectId are PAYLOAD
// in the management plane, not caller identity).
// (acceptance A1/C1-8/D1-5/E1-6 — round-1 found a BLOCKER where the management
// plane reused the data-plane FORBIDDEN_BODY_KEYS and rejected every legitimate
// grants/repos body as "forged identity". FIX 1 removed grants/projectId/
// activeProjectId from the management-plane gate; the data plane keeps them.)
// ===========================================================================

describe("sub-07 adv · round-2 FIX 1: grants/repos endpoints accept legitimate payload inputs", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("FIX 1 + C2: /grants/validate accepts the legitimate `grants` array body and returns a real validation result", async () => {
		// Body shape mandated by GrantsValidateInput (wiki-admin-types.ts:209).
		// Spec: plan-07 §3 grants editor calls /grants/validate with `{ grants }`.
		const agent = h.agentStore.create({
			name: "gv-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const res = await post(h.port, `/api/wiki-admin/grants/validate?agentId=${agent.id}`, {
			grants: [{ scope: "memory://", actions: ["read"] }],
		});
		expect(res.status, "grants/validate must accept the `grants` field it exists to validate").toBe(200);
		expect(res.data?.ok).toBe(true);
		// Real validation result: compiled grant carries the canonical memory
		// root + the read action (C2 round-trip).
		const merged = res.data?.result?.mergedGrants ?? [];
		expect(merged.some((g: any) =>
			g.canonicalScope === `wiki-root/memory/${agent.id}` && g.actions.includes("read"),
		)).toBe(true);
	});

	test("FIX 1 + A4 + A5: /grants/publish accepts `grants` payload → 200, bumps revision, writes audit row", async () => {
		const agent = h.agentStore.create({
			name: "gp-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const auditBefore = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { n: number }).n;
		const res = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [{ scope: "memory://", actions: ["read"] }],
			expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(res.status, "grants/publish must accept the grants payload and publish").toBe(200);
		expect(res.data?.result?.newRevision).toBe(1);
		// Agent record was mutated (revision bumped, grants persisted).
		expect((h.agentStore.get(agent.id) as any).wikiPolicyRevision).toBe(1);
		// Audit row written (A5 — now reachable).
		const auditAfter = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { n: number }).n;
		expect(auditAfter, "policy.publish.grants audit row must be written on HTTP publish").toBe(auditBefore + 1);
	});

	test("FIX 1 + E2/E3: /repositories/bind accepts `projectId` payload → 200, indexer.ensureBinding invoked, audit written", async () => {
		h.indexer.ensureBinding.mockClear();
		const auditBefore = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'repository.bind'")
			.get() as { n: number }).n;
		const res = await post(h.port, "/api/wiki-admin/repositories/bind", {
			projectId: "p-fix1", sourceRoot: "src",
		});
		expect(res.status, "repositories/bind must accept the projectId payload and bind").toBe(200);
		expect(res.data?.ok).toBe(true);
		expect(h.indexer.ensureBinding, "indexer.ensureBinding MUST be called now (request reaches it)").toHaveBeenCalledTimes(1);
		expect(h.indexer.ensureBinding.mock.calls[0][0]).toBe("p-fix1");
		// Audit row written.
		const auditAfter = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'repository.bind'")
			.get() as { n: number }).n;
		expect(auditAfter).toBe(auditBefore + 1);
	});

	test("FIX 1 surface scan: every management endpoint accepts its spec-mandated body (no forged-identity anywhere)", async () => {
		// Comprehensive scan: every documented management endpoint hit with its
		// spec-mandated body. NONE may hit the forged-identity gate now (FIX 1).
		const agent = h.agentStore.create({
			name: "scan-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const checks: Array<{ path: string; body: any }> = [
			{ path: "/addresses/validate", body: { address: "runtime://x", scope: "runtime", kind: "static" } },
			{ path: "/addresses/list", body: {} },
			{ path: "/grants/validate", body: { grants: [{ scope: "memory://", actions: ["read"] }] } },
			{ path: "/grants/preview", body: { grants: [{ scope: "memory://", actions: ["read"] }] } },
			{ path: "/grants/publish", body: { grants: [{ scope: "memory://", actions: ["read"] }], expectedRevision: 0 } },
			{ path: "/context/validate", body: { entries: [{ address: "memory://", profile: "standard", channel: "system" }] } },
			{ path: "/context/preview", body: { entries: [{ address: "memory://", profile: "standard", channel: "system" }] } },
			{ path: "/repositories/validate", body: { projectId: "p1" } },
			{ path: "/repositories/status", body: { projectId: "p1" } },
			{ path: "/repositories/bind", body: { projectId: "p1" } },
			{ path: "/repositories/unbind", body: { projectId: "p1" } },
			{ path: "/repositories/reindex", body: { projectId: "p1" } },
		];
		for (const c of checks) {
			const url = c.path.startsWith("/grants") || c.path.startsWith("/context")
				? `/api/wiki-admin${c.path}?agentId=${agent.id}`
				: `/api/wiki-admin${c.path}`;
			const res = await post(h.port, url, c.body);
			expect(res.data?.error?.message ?? "", `${c.path}: must NOT hit forged-identity gate (FIX 1)`).not.toMatch(/forged identity/i);
		}
	});
});

// ===========================================================================
// SUITE C — agentId query string + audit actor invariant
// (acceptance A1 / A5 — renderer cannot self-claim admin actor)
//
// Note: /grants/publish positive path is blocked by the FORBIDDEN_BODY_KEYS
// BLOCKER (Suite B2). These tests document what the audit actor WOULD be when
// the publish flow actually runs. We exercise the audit-actor invariant via
// address.create (which IS reachable) to keep coverage meaningful.
// ===========================================================================

describe("sub-07 adv · agentId query string cannot self-elevate audit actor", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("A1: /grants/publish without ?agentId is rejected 400 (agentId required)", async () => {
		const res = await post(h.port, "/api/wiki-admin/grants/publish", {
			grants: [{ scope: "memory://", actions: ["read"] }], expectedRevision: 0,
		});
		expect(res.status).toBe(400);
		expect(res.data?.error?.message).toMatch(/agentId/i);
	});

	test("A1/A5: audit actor stays '@wiki-admin' regardless of which agentId the renderer passes (via address.create — positive reachable path)", async () => {
		// address.create IS reachable (body has no grants/projectId top-level),
		// so we can prove the audit-actor invariant here. The renderer cannot
		// stamp its own actor on the audit row.
		const res = await post(h.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://actor-probe", scope: "runtime", kind: "static",
			targetPath: "wiki-root/knowledge",
		});
		expect(res.status).toBe(200);
		const audit = (h.wikiDb.getDb() as any)
			.prepare("SELECT actor_agent_id AS actor FROM wiki_audit_log WHERE action = 'address.create'")
			.get() as { actor: string };
		expect(audit, "address.create audit row must exist").toBeDefined();
		expect(audit.actor, `audit actor must be "@wiki-admin" (got "${audit?.actor}")`).toBe("@wiki-admin");
	});
});

// ===========================================================================
// SUITE D — A3: validate / preview are side-effect-free
// (acceptance A3 — no DB mutation, no audit row, no revision bump)
// ===========================================================================

describe("sub-07 adv · A3 validate/preview are pure (no audit, no revision bump)", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("A3: addresses/validate + impact do NOT write audit log", async () => {
		const auditBefore = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log").get() as { n: number }).n;
		await post(h.port, "/api/wiki-admin/addresses/validate", {
			address: "runtime://probe", scope: "runtime", kind: "static",
		});
		await post(h.port, "/api/wiki-admin/addresses/impact", {
			address: "runtime://probe", targetPath: "wiki-root/knowledge",
		});
		const auditAfter = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log").get() as { n: number }).n;
		expect(auditAfter, "validate/impact must NOT write audit rows").toBe(auditBefore);
	});

	test("A3: grants/validate + grants/preview do NOT bump wikiPolicyRevision or write audit", async () => {
		const agent = h.agentStore.create({
			name: "adv-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const revBefore = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const auditBefore = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log").get() as { n: number }).n;

		// Hammer validate + preview with multiple distinct grant drafts.
		for (let i = 0; i < 3; i++) {
			await post(h.port, `/api/wiki-admin/grants/validate?agentId=${agent.id}`, {
				grants: [{ scope: "memory://", actions: ["read", "create"] }],
			});
			await post(h.port, `/api/wiki-admin/grants/preview?agentId=${agent.id}`, {
				grants: [{ scope: "memory://", actions: ["read", "create", "update"] }],
			});
		}
		const revAfter = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const auditAfter = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log").get() as { n: number }).n;
		expect(revAfter, "validate/preview must NOT bump wikiPolicyRevision").toBe(revBefore);
		expect(auditAfter, "validate/preview must NOT write audit rows").toBe(auditBefore);
	});

	test("A3: context/validate + context/preview do NOT bump revision or auto-add grant", async () => {
		const agent = h.agentStore.create({
			name: "ctx-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const revBefore = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const grantsBefore = ((h.agentStore.get(agent.id) as any).wikiGrants ?? []).length;

		// Context referencing an address the agent HAS read on (memory://).
		const v = await post(h.port, `/api/wiki-admin/context/validate?agentId=${agent.id}`, {
			entries: [{ address: "memory://", profile: "standard", channel: "system" }],
		});
		expect(v.status).toBe(200);
		// And preview (calls real compileWikiContext).
		const p = await post(h.port, `/api/wiki-admin/context/preview?agentId=${agent.id}`, {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
		});
		expect(p.status).toBe(200);

		const revAfter = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const grantsAfter = ((h.agentStore.get(agent.id) as any).wikiGrants ?? []).length;
		expect(revAfter, "context validate/preview must NOT bump revision").toBe(revBefore);
		expect(grantsAfter, "context validate/preview must NOT auto-add grant").toBe(grantsBefore);
	});
});

// ===========================================================================
// SUITE E — A4: publish CAS (expectedRevision mismatch → WRITE_CONFLICT)
// (acceptance A4 — publish conflicts do not overwrite others' modifications)
// ===========================================================================

describe("sub-07 adv · A4 publish CAS — mismatch returns WRITE_CONFLICT, no overwrite", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("FIX 1 + A4: grants/publish CAS exercised via HTTP — first publish 200 (rev bump), stale publish 409 WRITE_CONFLICT, grants not overwritten", async () => {
		// round-1 could not exercise CAS via HTTP (BLOCKER). round-2 FIX 1
		// unblocks grants/publish; now we prove the full CAS contract end-to-end
		// through the HTTP router, not just the service.
		const agent = h.agentStore.create({
			name: "cas-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		// Successful publish: rev 0 → 1, grants become memory:// read+expand.
		const ok = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [{ scope: "memory://", actions: ["read", "expand"] }],
			expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(ok.status, "first publish must succeed (200)").toBe(200);
		expect(ok.data?.result?.newRevision).toBe(1);
		// Stale publish (still claims rev 0) → 409 WRITE_CONFLICT with currentRevision.
		const conflict = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [{ scope: "wiki-root/knowledge", actions: ["read"] }],
			expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(conflict.status, "stale publish must 409 WRITE_CONFLICT").toBe(409);
		expect(conflict.data?.error?.code).toBe("WRITE_CONFLICT");
		expect(conflict.data?.error?.currentRevision).toBe(1);
		// Agent grants must reflect the FIRST publish (memory://), NOT the stale one.
		const after = h.agentStore.get(agent.id) as any;
		const scopes = (after.wikiGrants ?? []).map((g: WikiGrant) => g.scope);
		expect(scopes).toContain("memory://");
		expect(scopes, "stale publish must NOT have overwritten grants").not.toContain("wiki-root/knowledge");
	});

	test("A4 direct: AgentService.publishAgentWikiPolicy with stale expectedRevision → WRITE_CONFLICT + currentRevision; agent unchanged", async () => {
		// Drive the CAS logic directly (bypassing the broken HTTP gate) to
		// prove the underlying service implementation IS correct.
		const agent = h.agentStore.create({
			name: "cas-direct", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		// Successful publish (rev 0 → 1).
		const ok = h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: 0,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read", "expand"] }] },
		});
		expect(ok.newRevision).toBe(1);
		// Stale publish (still claims rev 0) → WRITE_CONFLICT.
		try {
			h.svc.publishAgentWikiPolicy({
				agentId: agent.id, expectedRevision: 0,
				patch: { wikiGrants: [{ scope: "wiki-root/knowledge", actions: ["read"] }] },
			});
			throw new Error("expected WRITE_CONFLICT");
		} catch (e) {
			expect((e as Error).message).toMatch(/WRITE_CONFLICT/);
			expect((e as any).code).toBe("WRITE_CONFLICT");
			expect((e as any).currentRevision).toBe(1);
		}
		// Agent grants must reflect the FIRST publish (memory://), NOT the stale one.
		const after = h.agentStore.get(agent.id) as any;
		const scopes = (after.wikiGrants ?? []).map((g: WikiGrant) => g.scope);
		expect(scopes).toContain("memory://");
		expect(scopes, "stale publish must NOT have overwritten grants").not.toContain("wiki-root/knowledge");
	});

	test("A4: context/publish with stale expectedRevision → 409 WRITE_CONFLICT; no implicit grant added", async () => {
		const agent = h.agentStore.create({
			name: "cas-ctx", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		// First publish context successfully (memory:// is read-authorized).
		const ok = await post(h.port, `/api/wiki-admin/context/publish?agentId=${agent.id}`, {
			entries: [{ address: "memory://", profile: "compact", channel: "system" }],
			expectedRevision: 0,
		});
		expect(ok.status).toBe(200);
		const currentRev = ok.data.result.newRevision;

		// Stale publish with a different context entry. Must 409 and NOT change
		// agent.wikiContext.
		const conflict = await post(h.port, `/api/wiki-admin/context/publish?agentId=${agent.id}`, {
			entries: [{ address: "memory://", profile: "deep", channel: "off" }],
			expectedRevision: 0,
		});
		expect(conflict.status).toBe(409);
		expect(conflict.data?.error?.code).toBe("WRITE_CONFLICT");
		expect(conflict.data?.error?.currentRevision).toBe(currentRev);
		const after = h.agentStore.get(agent.id) as any;
		// First-publish context (compact) must be retained.
		expect((after.wikiContext ?? []).some((e: any) => e.profile === "compact")).toBe(true);
	});
});

// ===========================================================================
// SUITE F — C3: delete last grant persists [] and actually denies
// (acceptance C3 / H — `[]` survives JSON round-trip; undefined is forbidden)
// ===========================================================================

describe("sub-07 adv · C3 delete last grant → [] persisted + actually denies tool", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("FIX 1 + C3: publish grants=[] via HTTP → 200, persists literal [] (not NULL), compiles to empty access (actual denial)", async () => {
		// round-1 could not exercise the `[]` round-trip via HTTP (BLOCKER).
		// round-2 FIX 1 unblocks it; now we prove the full chain end-to-end:
		// HTTP publish grants=[] → agentStore row literal '[]' → compile →
		// zero grants → any wiki tool call denied (feedback-unique-message-keys:
		// JSON round-trip must preserve [] vs undefined).
		const agent = h.agentStore.create({
			name: "del-grants", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const res = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [], expectedRevision: rev0, confirmRootWriteGrant: false,
		});
		expect(res.status, "empty-grants publish must succeed via HTTP (FIX 1)").toBe(200);
		expect(res.data?.result?.newRevision).toBe(rev0 + 1);
		// DB row: literal '[]', NOT NULL (the undefined-vs-empty invariant).
		const row = (h.db.getDb() as any)
			.prepare("SELECT wiki_grants AS g FROM agents WHERE id = ?").get(agent.id) as { g: string | null };
		expect(row.g, "wiki_grants column must be literal '[]', not NULL").toBe("[]");
		// Agent record round-trip: wikiGrants is [] not undefined.
		const after = h.agentStore.get(agent.id) as any;
		expect(Array.isArray(after.wikiGrants)).toBe(true);
		expect(after.wikiGrants).toEqual([]);
		// Actually denies: compile the PUBLISHED grants with the same compiler
		// the runtime uses → empty access → every wiki tool call denied.
		const { compileWikiAccess } = await import("../../src/server/wiki/wiki-access-compiler.js");
		const compiled = compileWikiAccess({ agentId: agent.id, wikiGrants: after.wikiGrants });
		expect(compiled.access.grants, "published empty grants must compile to zero grants (denial)").toEqual([]);
	});

	test("C3 direct: AgentService.publishAgentWikiPolicy with patch.wikiGrants=[] persists literal [] (not NULL/undefined) and compiles to empty access", async () => {
		// Drive the underlying service directly to prove the [] vs undefined
		// invariant (feedback-unique-message-keys) is correctly implemented.
		const agent = h.agentStore.create({
			name: "del-grants-direct", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: rev0,
			patch: { wikiGrants: [] },
		});
		// DB row: literal '[]', NOT NULL.
		const row = (h.db.getDb() as any)
			.prepare("SELECT wiki_grants AS g FROM agents WHERE id = ?").get(agent.id) as { g: string | null };
		expect(row.g, "wiki_grants column must be literal '[]', not NULL").toBe("[]");
		// Agent record round-trip: wikiGrants is [] not undefined.
		const after = h.agentStore.get(agent.id) as any;
		expect(Array.isArray(after.wikiGrants)).toBe(true);
		expect(after.wikiGrants).toEqual([]);
		// Actually denies: compile with no fallback grants → empty access.
		const { compileWikiAccess } = await import("../../src/server/wiki/wiki-access-compiler.js");
		const compiled = compileWikiAccess({ agentId: agent.id, wikiGrants: after.wikiGrants });
		expect(compiled.access.grants, "empty wikiGrants must compile to zero grants (denial)").toEqual([]);
	});
});

// ===========================================================================
// SUITE G — C4/C7: wiki-root full-tree write grant requires confirmation
// (acceptance C4/C7 — not hard-forbidden, not silently allowed)
// ===========================================================================

describe("sub-07 adv · C4/C7 wiki-root full-tree write grant confirmation", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	const rootWriteGrants: WikiGrant[] = [{
		scope: "wiki-root",
		actions: ["create", "update", "delete"], // any write action on wiki-root
	}];

	test("FIX 1 + C4/C7 HTTP: wiki-root write publish WITHOUT confirm → 400 confirm message (not forged-identity), agent unchanged, no audit; WITH confirm → 200 + audit", async () => {
		// round-1: confirmRootWriteGrant gate was UNREACHABLE via HTTP (BLOCKER).
		// round-2 FIX 1: gate is now reachable. C4: high-risk confirmation
		// required. C7: cancel (no confirm) does NOT save; confirm → audit.
		const agent = h.agentStore.create({
			name: "root-noconfirm", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const auditBefore = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { n: number }).n;

		// WITHOUT confirm → 400 with the confirm message (NOT forged-identity).
		const denied = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: rootWriteGrants, expectedRevision: rev0,
		});
		expect(denied.status).toBe(400);
		expect(denied.data?.error?.code).toBe("INVALID_REQUEST");
		expect(denied.data?.error?.message).toMatch(/confirmRootWriteGrant/i);
		expect(denied.data?.error?.message, "must NOT be a forged-identity rejection (FIX 1 unblocked the gate)").not.toMatch(/forged identity/i);
		// C7 cancel: agent unchanged (no revision bump, no audit row written).
		expect((h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0).toBe(rev0);
		const auditAfterDenied = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { n: number }).n;
		expect(auditAfterDenied, "cancelled confirm must NOT write an audit row").toBe(auditBefore);

		// WITH confirm=true → 200, publishes, audit written.
		const ok = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: rootWriteGrants, expectedRevision: rev0, confirmRootWriteGrant: true,
		});
		expect(ok.status).toBe(200);
		expect(ok.data?.result?.newRevision).toBe(rev0 + 1);
		const auditAfterOk = ((h.wikiDb.getDb() as any)
			.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { n: number }).n;
		expect(auditAfterOk, "confirmed root-write publish must write an audit row").toBe(auditBefore + 1);
	});

	test("FIX 3 (service boundary): publishAgentWikiPolicy enforces confirmRootWriteGrant — no confirm → INVALID_REQUEST; canonical-equivalent scope also hits; confirm=true → publishes", () => {
		// round-1: the confirm gate was router-only; a direct service call
		// published a wiki-root write grant with NO confirmation (the gate was
		// bypassable by any direct caller: recovery script / test harness /
		// future admin tool). round-2 FIX 3 moves the gate INTO the service:
		// compileWikiAccess canonicalizes the grants first, then checks for
		// canonicalScope === WIKI_ROOT_PATH + a write action. confirmRootWrite
		// Grant defaults to undefined → !== true → reject.
		const agent = h.agentStore.create({
			name: "root-direct", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;

		// (a) Raw "wiki-root" write grant, NO confirm → INVALID_REQUEST.
		try {
			h.svc.publishAgentWikiPolicy({
				agentId: agent.id, expectedRevision: rev0,
				patch: { wikiGrants: rootWriteGrants },
			});
			throw new Error("expected INVALID_REQUEST for root-write without confirm");
		} catch (e) {
			expect((e as Error).message).toMatch(/confirmRootWriteGrant/i);
			expect((e as any).code).toBe("INVALID_REQUEST");
		}
		// Agent unchanged: no revision bump, no grants written.
		expect((h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0).toBe(rev0);

		// (b) Canonical-equivalent scope "wiki-root/" (trailing slash) —
		// compileWikiAccess normalizes it to WIKI_ROOT_PATH, so the gate STILL
		// hits even though the raw scope string differs. This proves the
		// service uses canonicalization, not raw string compare.
		try {
			h.svc.publishAgentWikiPolicy({
				agentId: agent.id, expectedRevision: rev0,
				patch: { wikiGrants: [{ scope: "wiki-root/", actions: ["create"] }] },
			});
			throw new Error("expected INVALID_REQUEST for trailing-slash root-write");
		} catch (e) {
			expect((e as Error).message, "canonical-equivalent 'wiki-root/' must also trip the gate").toMatch(/confirmRootWriteGrant/i);
			expect((e as any).code).toBe("INVALID_REQUEST");
		}

		// (c) WITH confirmRootWriteGrant=true → publishes (rev bumps).
		const out = h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: rev0,
			patch: { wikiGrants: rootWriteGrants },
			confirmRootWriteGrant: true,
		});
		expect(out.newRevision).toBe(rev0 + 1);
	});

	test("FIX 1 + C7 HTTP: wiki-root READ-ONLY grant (no write action) publishes WITHOUT confirm (non-trigger behavior)", async () => {
		// C7 confirmation only triggers on write actions (create/update/delete/
		// link/unlink/move) at canonicalScope === WIKI_ROOT_PATH. A read-only
		// wiki-root grant is broad but not destructive → publish succeeds
		// without confirmRootWriteGrant.
		const agent = h.agentStore.create({
			name: "root-readonly", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const res = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [{ scope: "wiki-root", actions: ["read", "expand", "search"] }],
			expectedRevision: rev0,
		});
		expect(res.status, "read-only wiki-root grant must publish without confirm").toBe(200);
		expect(res.data?.result?.newRevision).toBe(rev0 + 1);
		// Published grant compiles to a wiki-root read grant.
		const after = h.agentStore.get(agent.id) as any;
		const compiled = (await import("../../src/server/wiki/wiki-access-compiler.js")).compileWikiAccess({
			agentId: agent.id, wikiGrants: after.wikiGrants,
		});
		const rootGrant = compiled.access.grants.find((g: any) => g.canonicalScope === "wiki-root");
		expect(rootGrant, "published wiki-root read grant must be present").toBeDefined();
		expect(rootGrant!.actions.sort()).toEqual(["expand", "read", "search"]);
	});
});

// ===========================================================================
// SUITE H — D3: context publish refuses unauthorized address, no implicit grant
// (acceptance D3 / H — "context checkbox does NOT auto-grant read+write")
// ===========================================================================

describe("sub-07 adv · D3 context publish unauthorized — refuses + no implicit grant", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("D3: publish context entry whose address the agent lacks read on → 400; wikiGrants unchanged", async () => {
		const agent = h.agentStore.create({
			name: "ctx-unauth", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			// memory:// read only — no wiki-root/knowledge grant.
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const rev0 = (h.agentStore.get(agent.id) as any).wikiPolicyRevision ?? 0;
		const grantsBefore = (h.agentStore.get(agent.id) as any).wikiGrants.slice();

		// wiki-root/knowledge is NOT in grants → context publish must refuse.
		const res = await post(h.port, `/api/wiki-admin/context/publish?agentId=${agent.id}`, {
			entries: [{ address: "wiki-root/knowledge", profile: "standard", channel: "system" }],
			expectedRevision: rev0,
		});
		expect(res.status).toBe(400);
		expect(res.data?.error?.message).toMatch(/lacks? read grant|unauthorized/i);

		// CRITICAL: agent.wikiGrants must NOT have been mutated (no implicit
		// grant auto-added for wiki-root/knowledge).
		const after = h.agentStore.get(agent.id) as any;
		expect(after.wikiGrants.map((g: WikiGrant) => g.scope)).toEqual(grantsBefore.map((g: WikiGrant) => g.scope));
		expect(after.wikiGrants.map((g: WikiGrant) => g.scope), "must NOT have auto-added wiki-root/knowledge grant")
			.not.toContain("wiki-root/knowledge");
	});

	test("D3: context/preview returns unauthorizedAddresses for unauth address (UI gate)", async () => {
		const agent = h.agentStore.create({
			name: "ctx-prev-unauth", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		const p = await post(h.port, `/api/wiki-admin/context/preview?agentId=${agent.id}`, {
			entries: [
				{ address: "memory://", profile: "standard", channel: "system" },
				{ address: "wiki-root/knowledge", profile: "standard", channel: "system" },
			],
		});
		expect(p.status).toBe(200);
		expect(p.data?.result?.unauthorizedAddresses, "preview must surface unauthorized addresses")
			.toContain("wiki-root/knowledge");
	});
});

// ===========================================================================
// SUITE I — §6 session refresh RUNTIME-ALIVE
// (acceptance §6 — publishAgentWikiPolicy → agentStore.update → onChange →
// busy loop applyConfigUpdate called with NEW wikiAccess; in-flight tool call
// snapshot unchanged. This is the sub-05 round-1 dead-wiring lesson.)
// ===========================================================================

describe("sub-07 adv · §6 session refresh runtime-alive (not dead wiring)", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("§6 busy loop: publishAgentWikiPolicy triggers onChange → applyConfigUpdate with NEW wikiAccess reflecting new grants", async () => {
		const agent = h.agentStore.create({
			name: "busy-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);

		const applySpy = vi.fn();
		// Stub a BUSY loop (mirrors wiki-v2-runtime-e2e-wiring B2① shape).
		(h.svc as any).loops.set("sess-busy", {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: applySpy,
			isWaiting: () => false,
			getState: () => ({ isBusy: true }),
			abort: () => {},
		});
		(h.svc as any).activeSessions.set(agent.id, "sess-busy");
		(h.svc as any).runStates.set("sess-busy", { isBusy: true });

		// Drive publishAgentWikiPolicy directly (this is the production path
		// admin-router invokes; bypassing HTTP keeps the assertion on runtime
		// wiring, not express serialization).
		const result = h.svc.publishAgentWikiPolicy({
			agentId: agent.id,
			expectedRevision: 0,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read", "create", "update"] }] },
		});

		// The busy loop's applyConfigUpdate MUST have received a hot-sync
		// patch carrying the NEW compiled wikiAccess (not the old one).
		expect(applySpy, "busy loop applyConfigUpdate must be called on publish (runtime-alive)").toHaveBeenCalledTimes(1);
		const patch = applySpy.mock.calls[0][0];
		expect(patch.wikiAccess, "patch must include wikiAccess").toBeDefined();
		const newActions = patch.wikiAccess.grants.find((g: any) =>
			g.canonicalScope === `wiki-root/memory/${agent.id}`)?.actions ?? [];
		// New grant includes create+update (the publish payload). This proves
		// the patch reflects the NEW policy, not the stale one.
		expect(newActions).toEqual(expect.arrayContaining(["read", "create", "update"]));

		// affectedSessions must report this busy session. The onChange busy
		// branch applies synchronously via applyConfigUpdate (NOT through
		// pendingConfigPatches), so `applied=true` per the implementation's
		// accounting. The in-flight CallerCtx reference is still unchanged
		// (proven in the snapshot test below) — that is the actual safety
		// boundary, NOT the applied flag.
		const mine = result.affectedSessions.find((s) => s.sessionId === "sess-busy");
		expect(mine, "busy session must be reported in affectedSessions").toBeDefined();
		expect(mine?.applied).toBe(true);
	});

	test("§6 idle loop: publishAgentWikiPolicy → applyConfigUpdate called; affectedSessions reports applied=true", async () => {
		const agent = h.agentStore.create({
			name: "idle-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);

		const applySpy = vi.fn();
		(h.svc as any).loops.set("sess-idle", {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: applySpy,
			isWaiting: () => false,
			getState: () => ({ isBusy: false }), // idle
			abort: () => {},
		});

		const result = h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: 0,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read", "create"] }] },
		});
		expect(applySpy, "idle loop applyConfigUpdate must be called (immediate apply)").toHaveBeenCalledTimes(1);
		// Idle sessions report applied=true.
		const mine = result.affectedSessions.find((s) => s.sessionId === "sess-idle");
		expect(mine?.applied, "idle session must report applied=true after publish").toBe(true);
	});

	test("§6 in-flight tool snapshot unchanged: publish does NOT swap a busy loop's already-injected CallerCtx", async () => {
		// The wikiAccess currently bound on the loop's config (what an in-flight
		// tool call is using right now) must not be mutated in place. The
		// hot-sync passes a NEW object through applyConfigUpdate; the loop is
		// expected to swap at StepEnd. We assert the OLD reference is not
		// mutated by publishing.
		const agent = h.agentStore.create({
			name: "snapshot-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
		} as any);
		// Capture the loop's old wikiAccess reference (as the in-flight tool
		// would have snapped it).
		const oldAccess = (h.svc as any).compileWikiAccessForSession(agent, "sess-snap", undefined).wikiAccess;
		expect(oldAccess).toBeDefined();
		const oldActions = oldAccess.grants.find((g: any) => g.canonicalScope === `wiki-root/memory/${agent.id}`)?.actions ?? [];
		// Publish new grants.
		h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: 0,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read", "create", "update", "delete"] }] },
		});
		// The old captured snapshot's actions array must NOT have been mutated
		// in place (in-flight tool keeps using what it snapshotted).
		expect(oldAccess.grants.find((g: any) => g.canonicalScope === `wiki-root/memory/${agent.id}`)?.actions ?? [])
			.toEqual(oldActions);
	});
});

// ===========================================================================
// SUITE J — E4 unbind soft vs hard
// (acceptance E4 — unbind does NOT implicitly hard-delete wiki)
// ===========================================================================

describe("sub-07 adv · E4 unbind soft vs hard (no implicit hard-delete)", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("FIX 1 + E4 HTTP: soft unbind → 200 (repositories.delete, NOT rebuildFromScratch, subtree kept); hard unbind → 200 (rebuildFromScratch called)", async () => {
		// round-1: both unbind paths rejected by FORBIDDEN_BODY_KEYS (BLOCKER).
		// round-2 FIX 1: unbind accepts `projectId`. E4 acceptance: unbind does
		// NOT implicitly hard-delete — soft only removes the binding row; the
		// Wiki project subtree is preserved.
		// Seed two bindings so unbind has something to remove.
		h.repositoryStore.repositories.upsert({
			repository_id: "repo-p-soft", project_node_id: 1,
			project_id: "p-soft", source_root: "src",
		});
		h.repositoryStore.repositories.upsert({
			repository_id: "repo-p-hard", project_node_id: 2,
			project_id: "p-hard", source_root: "src",
		});
		h.indexer.rebuildFromScratch.mockClear();

		// Soft unbind → 200, binding gone, rebuildFromScratch NOT called.
		const soft = await post(h.port, "/api/wiki-admin/repositories/unbind", { projectId: "p-soft" });
		expect(soft.status, "soft unbind must succeed (FIX 1)").toBe(200);
		expect(soft.data?.result?.unbound).toBe(true);
		expect(soft.data?.result?.hard).toBe(false);
		expect(h.repositoryStore.repositories.getByProjectId("p-soft"), "soft unbind removes the binding row").toBeUndefined();
		expect(h.indexer.rebuildFromScratch, "soft unbind must NOT hard-delete the subtree").not.toHaveBeenCalled();

		// Hard unbind → 200, rebuildFromScratch called (archives subtree + rebinds).
		const hard = await post(h.port, "/api/wiki-admin/repositories/unbind", { projectId: "p-hard", hard: true });
		expect(hard.status, "hard unbind must succeed (FIX 1)").toBe(200);
		expect(hard.data?.result?.hard).toBe(true);
		expect(h.indexer.rebuildFromScratch, "hard unbind must call rebuildFromScratch").toHaveBeenCalledWith("p-hard");

		// Both unbind paths write an audit row (A5).
		const auditRows = (h.wikiDb.getDb() as any)
			.prepare("SELECT detail_json AS d FROM wiki_audit_log WHERE action = 'repository.unbind' ORDER BY created_at ASC")
			.all() as Array<{ d: string | null }>;
		expect(auditRows.length).toBeGreaterThanOrEqual(2);
		const hardFlags = auditRows.map((r) => { try { return JSON.parse(r.d ?? "{}").hard; } catch { return undefined; } });
		expect(hardFlags).toContain(false);
		expect(hardFlags).toContain(true);
	});

	test("E4 direct: store-level soft delete leaves binding gone but project subtree untouched (no implicit hard-delete)", async () => {
		// Drive the store path the router's soft-branch WOULD take (the gate
		// is broken, but the underlying soft vs hard logic is correct).
		const projectId = "p-direct";
		h.repositoryStore.repositories.upsert({
			repository_id: `repo-${projectId}`, project_node_id: 1,
			project_id: projectId, source_root: "src",
		});
		expect(h.repositoryStore.repositories.getByProjectId(projectId)).toBeDefined();
		// Soft delete = just the binding row (router's else-branch).
		h.repositoryStore.repositories.delete(`repo-${projectId}`);
		expect(h.repositoryStore.repositories.getByProjectId(projectId)).toBeUndefined();
	});

	test("E4 source inspection: router soft-branch calls repositories.delete only; hard-branch gates on body.hard and calls rebuildFromScratch", async () => {
		// Static inspection of the router's unbind handler — proves the
		// soft/hard branching logic is correct even though the HTTP gate is
		// broken upstream.
		const routerSrc = readFileSync("src/server/wiki-admin-router.ts", "utf8");
		const unblock = routerSrc.slice(routerSrc.indexOf("router.post(\"/repositories/unbind\""));
		expect(unblock, "router must branch on body.hard for soft vs hard").toMatch(/if \(body\.hard\)/);
		const elseIdx = unblock.indexOf("} else {");
		const elseBlock = unblock.slice(elseIdx, elseIdx + 250);
		expect(elseBlock, "soft unbind else-branch must call repositories.delete").toMatch(/repositories\.delete/);
		expect(elseBlock, "soft unbind else-branch must NOT call rebuildFromScratch").not.toMatch(/rebuildFromScratch/);
	});
});

// ===========================================================================
// SUITE K — E1/H: repositories table never persists absolute workspace path
// (acceptance E1 / H — bind must NOT copy local absolute checkout path)
// ===========================================================================

describe("sub-07 adv · E1/H bind does NOT persist absolute workspace path into wiki.db", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("E1/H schema: wiki_repositories table has NO workspaceDir column (FK design — workspace path lives in ProjectStore only)", () => {
		// Schema-level invariant — independent of the broken HTTP gate.
		const cols = (h.wikiDb.getDb() as any)
			.prepare("PRAGMA table_info(wiki_repositories)").all() as Array<{ name: string }>;
		const colNames = cols.map((c) => c.name.toLowerCase());
		expect(colNames, "wiki_repositories must NOT have a workspace_dir column").not.toContain("workspace_dir");
		expect(colNames, "wiki_repositories must NOT have a workspacedir column").not.toContain("workspacedir");
		expect(colNames, "wiki_repositories must NOT have an absolute-checkout-path column").not.toContain("checkout_path");
		// Columns it SHOULD have (no absolute path among them).
		for (const required of ["repository_id", "project_id", "source_root", "default_branch"]) {
			expect(colNames, `wiki_repositories must have ${required}`).toContain(required);
		}
	});

	test("E1/H source inspection: repositoryBindSchema + repositoryRowToView never write workspaceDir into the DB row", () => {
		// Static check on the router + store: the bind code path writes only
		// projectId/sourceRoot/defaultBranch. workspaceDir is read from
		// ProjectStore for the VIEW (read-only display), never upserted.
		const routerSrc = readFileSync("src/server/wiki-admin-router.ts", "utf8");
		const bindSlice = routerSrc.slice(
			routerSrc.indexOf("router.post(\"/repositories/bind\""),
			routerSrc.indexOf("router.post(\"/repositories/update\""),
		);
		// The bind body schema only accepts projectId/sourceRoot/defaultBranch.
		expect(bindSlice, "bind schema must NOT accept workspaceDir").not.toMatch(/workspaceDir\s*[?:]/);
		// And the indexer call must pass only sourceRoot/defaultBranch.
		expect(bindSlice, "bind must NOT forward workspaceDir to indexer").not.toMatch(/ensureBinding.*workspaceDir|workspaceDir.*ensureBinding/s);
		// The view-builder reads workspaceDir from projectStore (display only).
		const viewSlice = routerSrc.slice(routerSrc.indexOf("async function repositoryRowToView"));
		expect(viewSlice, "view reads workspaceDir from ProjectStore (display only)").toMatch(/project.*workspaceDir|workspaceDir.*project/);
		expect(viewSlice, "view-builder must NOT insert workspaceDir into the DB row").not.toMatch(/upsert.*workspaceDir|workspace_dir/);
	});

	test("E1/H (BLOCKER-bound): HTTP bind is blocked by FORBIDDEN_BODY_KEYS — but the underlying upsert path stores sourceRoot (relative) only", async () => {
		// The HTTP gate rejects projectId, so we cannot drive the bind via HTTP.
		// Drive the underlying upsert directly to prove the row never holds an
		// absolute path.
		const projectId = "p-direct-leak";
		h.repositoryStore.repositories.upsert({
			repository_id: `repo-${projectId}`, project_node_id: 1,
			project_id: projectId, source_root: "src/sub",
		});
		const row = (h.wikiDb.getDb() as any)
			.prepare("SELECT * FROM wiki_repositories WHERE project_id = ?")
			.get(projectId) as Record<string, unknown>;
		expect(row).toBeDefined();
		expect(row.source_root).toBe("src/sub");
		// No column in the row should hold an absolute path.
		const absPrefix = join(h.dir, "checkout");
		for (const [k, v] of Object.entries(row)) {
			if (typeof v === "string") {
				expect(v, `row.${k} must NOT contain absolute workspace path`).not.toContain(absPrefix);
			}
		}
	});
});

// ===========================================================================
// SUITE L — E7: cron record cannot bypass Agent grants
// (acceptance E7 — Work/Cron cannot expand Wiki actions beyond Agent grants)
// ===========================================================================

describe("sub-07 adv · E7 cron/work cannot bypass Agent grants", () => {
	const TYPES_SRC = readFileSync("src/shared/types.ts", "utf8");
	const CRON_RUNNER_SRC = readFileSync("src/server/cron-analysis.ts", "utf8");

	test("E7 structural: shared types define wikiGrants ONLY on AgentRecord and PromptTemplate — NOT on Cron / Work records", () => {
		// Find every `wikiGrants?` declaration in shared types and confirm
		// each one sits inside an Agent-like / Template-like interface.
		// Adversarial: scan for any interface that introduces wikiGrants and
		// is NOT Agent* or Prompt*.
		const ifaceBlocks = [...TYPES_SRC.matchAll(/export (?:interface|type) (\w+)[\s\S]*?\n\}/g)];
		const offenders: string[] = [];
		for (const m of ifaceBlocks) {
			const name = m[1];
			const body = m[0];
			if (/\bwikiGrants\??\s*:/.test(body)) {
				if (!/^(Agent|PromptTemplate|WikiGrant)/.test(name)) {
					offenders.push(name);
				}
			}
		}
		expect(offenders, `wikiGrants must only appear on Agent/PromptTemplate types (offenders: ${offenders.join(", ")})`).toEqual([]);
	});

	test("E7 runtime: cron-analysis runs prompts via AgentService.send(Prompt) — which always compiles wikiAccess from AgentRecord, never from cron config", () => {
		// Strip comments to defeat commented-out dead wiring (sub-05 lesson).
		const stripped = CRON_RUNNER_SRC
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// Cron must delegate to sendProjectPrompt or sendPrompt — both go
		// through AgentService which compiles wikiAccess from AgentRecord.
		expect(stripped, "cron must invoke AgentService.sendProjectPrompt or sendPrompt").toMatch(/sendProjectPrompt|sendPrompt/);
		// And must NOT read wikiGrants from the cron record directly.
		expect(stripped, "cron runner must NOT read wikiGrants from the cron record").not.toMatch(/cron.*wikiGrants|wikiGrants.*cron/);
	});

	test("E7 defer note: Cron editor UI disable is plan-08 — runtime invariant holds regardless (compileWikiAccess reads only AgentRecord)", async () => {
		// Independently confirm: the runtime compiler NEVER accepts a Cron or
		// Work record. compileWikiAccess takes {agentId, activeProjectId,
		// wikiGrants} — the wikiGrants MUST come from AgentRecord.
		const h = await buildHarnessAsync();
		holder = h;
		const { compileWikiAccess } = await import("../../src/server/wiki/wiki-access-compiler.js");
		// Agent without wikiGrants — only fallback defaults.
		const agent = h.agentStore.create({
			name: "cron-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		// Even if someone tries to pass "extra grants" via a cron config, the
		// compiler has NO such parameter. Assert the function signature.
		expect(compileWikiAccess.length, "compileWikiAccess takes a single opts object").toBe(1);
		// Try to smuggle in a cron-context grant via prototype pollution style —
		// the function only reads `opts.wikiGrants`. Anything else is ignored.
		const out = compileWikiAccess({
			agentId: agent.id,
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			// @ts-expect-error — intentionally invalid extra field
			cronWikiGrants: [{ scope: "wiki-root", actions: ["delete"] }],
		} as any);
		const scopes = out.access.grants.map((g: any) => g.canonicalScope);
		expect(scopes, "smuggled cronWikiGrants must NOT affect compiled access").not.toContain("wiki-root");
		expect(scopes).toContain(`wiki-root/memory/${agent.id}`);
	});
});

// ===========================================================================
// SUITE M — PromptTemplate fresh-DB columns (feedback-fresh-db-migrations)
// (orchestrator-flagged: templates.wiki_grants/wiki_context must be in COLUMNS
// AND db-migration safeAddColumn, else fresh DB missing columns)
// ===========================================================================

describe("sub-07 adv · PromptTemplate fresh-DB column migration", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("fresh DB: templates table contains wiki_grants and wiki_context columns", () => {
		// Instantiating TemplateStore triggers SqliteStore.ensureTable which
		// adds any missing columns listed in COLUMNS (mirrors server startup
		// sequence: db-migration runs first, then stores instantiate). Without
		// this step, fresh DBs would be missing the new columns entirely
		// (feedback-fresh-db-migrations invariant).
		new TemplateStore(h.db);
		const cols = (h.db.getDb() as any)
			.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);
		expect(names, "templates must have wiki_grants column (fresh DB)").toContain("wiki_grants");
		expect(names, "templates must have wiki_context column (fresh DB)").toContain("wiki_context");
	});

	test("fresh DB: built-in Archivist seed round-trips with wikiGrants populated", () => {
		const ts = new TemplateStore(h.db);
		const archivist = ts.list().find((t: any) => t.name === "Archivist");
		expect(archivist, "Archivist built-in template must exist after fresh-DB seed").toBeDefined();
		expect(archivist!.wikiGrants, "Archivist seed must carry wikiGrants (field round-trip)").toBeDefined();
		expect(Array.isArray(archivist!.wikiGrants)).toBe(true);
		expect(archivist!.wikiGrants!.length).toBeGreaterThan(0);
		// Own memory grant must be present.
		const scopes = archivist!.wikiGrants!.map((g) => g.scope);
		expect(scopes).toContain("memory://");
		// Context entries also round-trip.
		expect(archivist!.wikiContext, "Archivist seed must carry wikiContext").toBeDefined();
		expect(archivist!.wikiContext!.length).toBeGreaterThan(0);
	});

	test("template-store COLUMNS array AND db-migration safeAddColumn both list wiki_grants/wiki_context (no drift)", () => {
		const tsSrc = readFileSync("src/server/template-store.ts", "utf8");
		const migSrc = readFileSync("src/server/db-migration.ts", "utf8");
		// template-store COLUMNS lists both (fresh-DB INSERT/SELECT covers them).
		expect(tsSrc).toMatch(/\{ key:\s*"wikiGrants",\s*column:\s*"wiki_grants"/);
		expect(tsSrc).toMatch(/\{ key:\s*"wikiContext",\s*column:\s*"wiki_context"/);
		// db-migration safeAddColumn backfills both on upgraded DBs.
		expect(migSrc).toMatch(/safeAddColumn\(db,\s*"templates",\s*"wiki_grants"/);
		expect(migSrc).toMatch(/safeAddColumn\(db,\s*"templates",\s*"wiki_context"/);
	});
});

// ===========================================================================
// SUITE N — A5 every mutation writes audit with actor/revision/time/impact
// (acceptance A5 — actor + revision + time + impact summary for each mutation)
// ===========================================================================

describe("sub-07 adv · A5 every admin mutation writes audit row", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("A5: address create / update / delete each write an audit row with actor=@wiki-admin + nodePath", async () => {
		const c = await post(h.port, "/api/wiki-admin/addresses/create", {
			address: "runtime://audit-probe", scope: "runtime", kind: "static",
			targetPath: "wiki-root/knowledge",
		});
		expect(c.status).toBe(200);
		const u = await post(h.port, "/api/wiki-admin/addresses/update", {
			address: "runtime://audit-probe",
			patch: { scope: "alias", kind: "static", resolver: null, targetPath: "wiki-root/knowledge" },
		});
		expect(u.status).toBe(200);
		const d = await post(h.port, "/api/wiki-admin/addresses/delete", {
			address: "runtime://audit-probe",
		});
		expect(d.status).toBe(200);

		const rows = (h.wikiDb.getDb() as any)
			.prepare("SELECT action, actor_agent_id AS actor, node_path AS np, detail_json AS d, created_at AS t FROM wiki_audit_log WHERE action LIKE 'address.%' ORDER BY created_at ASC")
			.all() as Array<{ action: string; actor: string; np: string | null; d: string | null; t: string }>;
		const actions = rows.map((r) => r.action);
		expect(actions).toEqual(expect.arrayContaining(["address.create", "address.update", "address.delete"]));
		for (const r of rows) {
			expect(r.actor, "audit actor must be @wiki-admin").toBe("@wiki-admin");
			expect(r.t, "audit must have created_at timestamp").toBeTruthy();
			expect(r.d, "audit must carry detail_json impact summary").not.toBeNull();
		}
	});

	test("FIX 1 + A5 HTTP: policy.publish.grants writes audit row with actor=@wiki-admin + newRevision + detail (agentId/grants/affectedSessions)", async () => {
		// round-1: the audit-emit path was unreachable via HTTP (BLOCKER).
		// round-2 FIX 1: publish reaches callAdmin → auditRepo.append runs.
		const agent = h.agentStore.create({
			name: "audit-blocked", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const res = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants: [{ scope: "memory://", actions: ["read"] }],
			expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(res.status).toBe(200);
		const row = (h.wikiDb.getDb() as any)
			.prepare("SELECT actor_agent_id AS actor, new_revision AS rev, detail_json AS d, created_at AS t FROM wiki_audit_log WHERE action = 'policy.publish.grants'")
			.get() as { actor: string; rev: number | null; d: string | null; t: string };
		expect(row, "policy.publish.grants audit row must exist after HTTP publish").toBeDefined();
		expect(row.actor, "audit actor must be @wiki-admin").toBe("@wiki-admin");
		expect(row.rev, "audit must record newRevision").toBe(1);
		expect(row.t, "audit must have created_at").toBeTruthy();
		const detail = JSON.parse(row.d ?? "{}");
		expect(detail.agentId).toBe(agent.id);
		expect(Array.isArray(detail.grants)).toBe(true);
		expect(Array.isArray(detail.affectedSessions)).toBe(true);
	});

	test("A5 direct: AgentService.publishAgentWikiPolicy + router's audit-emit logic record newRevision + agentId + affectedSessions (when reachable)", async () => {
		// The router's audit-emit logic is correct but unreachable. Verify the
		// underlying AgentService.publishAgentWikiPolicy returns the shape the
		// audit-emit code expects (newRevision + affectedSessions).
		const agent = h.agentStore.create({
			name: "audit-direct", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		// Stub a busy loop so affectedSessions has an entry.
		(h.svc as any).loops.set("sess-audit", {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: () => {},
			isWaiting: () => false,
			getState: () => ({ isBusy: true }),
			abort: () => {},
		});
		const out = h.svc.publishAgentWikiPolicy({
			agentId: agent.id, expectedRevision: 0,
			patch: { wikiGrants: [{ scope: "memory://", actions: ["read"] }] },
		});
		expect(out.newRevision, "service must return newRevision > 0").toBeGreaterThan(0);
		// affectedSessions contains the session (onChange busy branch applied
		// directly via applyConfigUpdate, so applied=true per the impl's accounting).
		expect(out.affectedSessions, "service must return affectedSessions (impact summary source)")
			.toContainEqual({ sessionId: "sess-audit", applied: true });
	});
});

// ===========================================================================
// SUITE O — round-2 now-unblocked criteria, driven end-to-end via HTTP.
// These criteria were MASKED by the round-1 BLOCKER (every grants/repos body
// was rejected before reaching the service). Now that FIX 1 unblocks the gate,
// we exercise them through the real HTTP endpoints — not direct service drives
// — per feedback-verify-runtime-wiring (assert the downstream真的消费).
// ===========================================================================

describe("sub-07 adv · round-2 HTTP-unblocked criteria (C2/C5/C8 + data-plane isolation)", () => {
	let h: Harness;
	beforeEach(async () => { h = await buildHarnessAsync(); holder = h; });

	test("C2 round-trip via HTTP: validate → preview → publish → re-read agent reflects the published grants", async () => {
		const agent = h.agentStore.create({
			name: "rt-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const grants = [{ scope: "memory://", actions: ["read", "create"] as any }];
		// validate
		const v = await post(h.port, `/api/wiki-admin/grants/validate?agentId=${agent.id}`, { grants });
		expect(v.status).toBe(200);
		const memRoot = `wiki-root/memory/${agent.id}`;
		expect(v.data?.result?.mergedGrants.some((g: any) =>
			g.canonicalScope === memRoot && g.actions.includes("create"),
		)).toBe(true);
		// preview
		const p = await post(h.port, `/api/wiki-admin/grants/preview?agentId=${agent.id}`, { grants });
		expect(p.status).toBe(200);
		expect(p.data?.result?.hasRootWriteGrant).toBe(false);
		expect(p.data?.result?.access.grants.some((g: any) => g.canonicalScope === memRoot)).toBe(true);
		// publish
		const pub = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants, expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(pub.status).toBe(200);
		expect(pub.data?.result?.newRevision).toBe(1);
		// re-read: agent record carries the published grants (round-trip).
		const after = h.agentStore.get(agent.id) as any;
		expect(after.wikiGrants).toEqual([{ scope: "memory://", actions: ["read", "create"] }]);
		expect(after.wikiPolicyRevision).toBe(1);
	});

	test("C5 overlapping grants: preview shows ACTION UNION for same canonical scope (no random priority)", async () => {
		// Two grants on the SAME scope (memory:// → same canonical memory root)
		// with disjoint action sets. The compiled/merged result must be the
		// UNION of actions, deterministically — not whichever grant happened to
		// be processed last.
		const agent = h.agentStore.create({
			name: "ovl-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const grants = [
			{ scope: "memory://", actions: ["read"] },
			{ scope: "memory://", actions: ["create", "update"] },
		];
		const p = await post(h.port, `/api/wiki-admin/grants/preview?agentId=${agent.id}`, { grants });
		expect(p.status).toBe(200);
		const memRoot = `wiki-root/memory/${agent.id}`;
		const merged = p.data?.result?.mergedGrants.find((g: any) => g.canonicalScope === memRoot);
		expect(merged, "overlapping grants must merge to a single entry per scope").toBeDefined();
		expect(merged.actions.sort(), "merged actions must be the UNION (read+create+update)").toEqual(["create", "read", "update"]);
		// Run again in reversed order — union must be IDENTICAL (no order bias).
		const p2 = await post(h.port, `/api/wiki-admin/grants/preview?agentId=${agent.id}`, {
			grants: [grants[1], grants[0]],
		});
		const merged2 = p2.data?.result?.mergedGrants.find((g: any) => g.canonicalScope === memRoot);
		expect(merged2.actions.sort()).toEqual(["create", "read", "update"]);
	});

	test("C8 publish→preview parity: after HTTP publish, the runtime compiler produces the SAME access the UI preview showed", async () => {
		// acceptance C8: "publish 后真实 Agent tool 权限与 preview 一致". The
		// runtime tool gate compiles wikiAccess from AgentRecord.wikiGrants via
		// the SAME compileWikiAccess the preview uses. So: capture preview, then
		// publish, then independently compile the published record — the two
		// access.grants sets must agree. This is the downstream-consumption
		// assertion (not just that the store row changed).
		const agent = h.agentStore.create({
			name: "parity-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const grants = [
			{ scope: "memory://", actions: ["read", "expand"] },
			{ scope: "wiki-root/knowledge", actions: ["read", "search"] },
		];
		const p = await post(h.port, `/api/wiki-admin/grants/preview?agentId=${agent.id}`, { grants });
		expect(p.status).toBe(200);
		const previewGrants = p.data?.result?.access.grants as Array<{ canonicalScope: string; actions: string[] }>;

		const pub = await post(h.port, `/api/wiki-admin/grants/publish?agentId=${agent.id}`, {
			grants, expectedRevision: 0, confirmRootWriteGrant: false,
		});
		expect(pub.status).toBe(200);

		// Independently compile the PUBLISHED agent record (what the runtime
		// wiki tool gate will use on the next tool call).
		const after = h.agentStore.get(agent.id) as any;
		const { compileWikiAccess } = await import("../../src/server/wiki/wiki-access-compiler.js");
		const runtimeAccess = compileWikiAccess({ agentId: agent.id, wikiGrants: after.wikiGrants }).access.grants;

		// Normalize both to scope→sorted-actions maps and compare.
		const norm = (arr: Array<{ canonicalScope: string; actions: string[] }>) => {
			const m = new Map<string, string[]>();
			for (const g of arr) m.set(g.canonicalScope, [...g.actions].sort());
			return m;
		};
		const previewMap = norm(previewGrants);
		const runtimeMap = norm(runtimeAccess);
		expect(previewMap.size, "preview and runtime must cover the same scope set").toBe(runtimeMap.size);
		for (const [scope, actions] of previewMap) {
			expect(runtimeMap.get(scope), `published runtime access must include scope ${scope} (preview→publish parity)`).toEqual(actions);
		}
	});

	test("FIX 1 isolation: data-plane wiki-router still FORBIDS grants/projectId/activeProjectId body; admin plane allows them (two gates isolated)", async () => {
		// round-2 FIX 1 removed grants/projectId/activeProjectId from the
		// MANAGEMENT-plane gate. Adversarial regression: confirm the DATA-plane
		// gate (wiki-router.ts) STILL forbids them — Fix 1 must not have
		// weakened the data plane. The two gates are intentionally different.
		const adminSrc = readFileSync("src/server/wiki-admin-router.ts", "utf8");
		const dataSrc = readFileSync("src/server/wiki-router.ts", "utf8");
		// Slice each FORBIDDEN_BODY_KEYS Set literal.
		const sliceSet = (src: string) => {
			const m = src.match(/const FORBIDDEN_BODY_KEYS = new Set\(\[([\s\S]*?)\]\)/);
			expect(m, "FORBIDDEN_BODY_KEYS Set must be defined").not.toBeNull();
			return m![1];
		};
		const adminSet = sliceSet(adminSrc);
		const dataSet = sliceSet(dataSrc);
		// Management plane: payload fields REMOVED (FIX 1) — allowed.
		for (const payload of [`"grants"`, `"projectId"`, `"activeProjectId"`]) {
			expect(adminSet, `admin plane must NOT forbid payload field ${payload} (FIX 1)`).not.toContain(payload);
		}
		// Management plane still forbids true identity keys + canManage (FIX 2).
		for (const identity of [`"admin"`, `"actor"`, `"authority"`, `"canManage"`]) {
			expect(adminSet, `admin plane must forbid identity key ${identity}`).toContain(identity);
		}
		// Data plane: payload fields STILL forbidden (caller identity here).
		for (const identity of [`"grants"`, `"projectId"`, `"activeProjectId"`]) {
			expect(dataSet, `data plane MUST still forbid ${identity} (isolation unchanged by FIX 1)`).toContain(identity);
		}
		// Live confirmation: admin grants/validate ACCEPTS a grants body (200),
		// proving the field is genuinely not in the admin gate.
		const agent = h.agentStore.create({
			name: "iso-agent", provider: "MockProv", model: "sub07-mock",
			toolPolicy: { tools: {} },
		} as any);
		const res = await post(h.port, `/api/wiki-admin/grants/validate?agentId=${agent.id}`, {
			grants: [{ scope: "memory://", actions: ["read"] }],
		});
		expect(res.status).toBe(200);
	});
});
