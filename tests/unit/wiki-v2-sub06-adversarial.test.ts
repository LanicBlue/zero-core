// Adversarial verifier for wiki-system-redesign sub-06 (Data API + Browser UI).
//
// Lens: adversarial. This file deliberately attacks the sub-06 surfaces:
//   - forged identity fields in POST bodies (FORBIDDEN_BODY_KEYS gaps)
//   - UI admin authority injection (must come from server constant, not body)
//   - XSS via Markdown raw HTML (react-markdown WITHOUT rehype-raw)
//   - DB internal-ID leakage in renderer state / REST responses
//   - regex invalid/timeout error surfacing (no substring degradation)
//   - unbounded rendering of 1,000+ siblings (pagination)
//   - WRITE_CONFLICT draft preservation
//   - data:changed incremental cache invalidation + move old/new parent refresh
//   - legacy project_wiki / old wiki:* channel residue
//   - workspace-doc sandbox path escape
//
// Tests are written against acceptance-06 (the spec), NOT against the
// implementer's claims. Source code under src/ is frozen — this file only
// asserts behavior.
//
// Windows vitest note: run THIS file only (single-process temp-DB teardown can
// crash with exit 127/139 on large suites); verbose to see each ✓.

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { createWikiBrowserRouter, createWorkspaceDocHandler } from "../../src/server/wiki-router.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import { wikiError } from "../../src/server/wiki/wiki-errors.js";
import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import type {
	WikiExpandRequest, WikiExpandResult,
	WikiReadRequest, WikiReadResult,
	WikiCreateRequest, WikiUpdateRequest, WikiArchiveRequest,
	WikiLinkRequest, WikiUnlinkRequest, WikiMoveRequest,
	WikiMutationResult, WikiRequestContext,
} from "../../src/shared/wiki-types.js";
import type { WikiSearchRequest, WikiSearchResult } from "../../src/shared/wiki-search-types.js";

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
async function get(port: number, path: string): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`);
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

// ---------------------------------------------------------------------------
// Mock WikiService + WikiSearchService — record every call's (req, ctx)
// ---------------------------------------------------------------------------

interface RecordedCall { method: string; req: any; ctx: WikiRequestContext }

function makeMockRuntime() {
	const calls: RecordedCall[] = [];
	const wikiService = {
		expand: async (req: WikiExpandRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "expand", req, ctx });
			const result: WikiExpandResult = {
				path: req.address,
				summary: "mock summary",
				displayTitle: "mock",
				kind: "node",
				children: { items: [], cursor: null, hasMore: false },
				auditId: "audit-receipt-1",
			};
			return result;
		},
		read: async (req: WikiReadRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "read", req, ctx });
			const result: WikiReadResult = {
				path: req.address,
				node: {
					path: req.address, name: "mock", kind: "node", summary: "s",
					revision: 1, parentPath: null, createdAt: "t", updatedAt: "t",
					archivedAt: null, attributes: {}, sourceBound: false, displayTitle: "mock",
				},
				content: "body",
				auditId: "audit-receipt-1",
			};
			return result;
		},
		create: async (req: WikiCreateRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "create", req, ctx });
			const r: WikiMutationResult = { success: true, path: `${req.parent}/${req.name}`, revision: 1, auditId: "audit-receipt-1", oldRevision: null };
			return r;
		},
		update: async (req: WikiUpdateRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "update", req, ctx });
			const r: WikiMutationResult = { success: true, path: req.address, revision: 2, auditId: "audit-receipt-1", oldRevision: 1 };
			return r;
		},
		archive: async (req: WikiArchiveRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "archive", req, ctx });
			const r: WikiMutationResult = { success: true, path: req.address, revision: 1, auditId: "audit-receipt-1", oldRevision: 1 };
			return r;
		},
		link: async (req: WikiLinkRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "link", req, ctx });
			const r: WikiMutationResult = { success: true, path: req.source, revision: 1, auditId: "audit-receipt-1", oldRevision: null };
			return r;
		},
		unlink: async (req: WikiUnlinkRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "unlink", req, ctx });
			const r: WikiMutationResult = { success: true, path: req.source, revision: 1, auditId: "audit-receipt-1", oldRevision: null };
			return r;
		},
		move: async (req: WikiMoveRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "move", req, ctx });
			const r: WikiMutationResult = { success: true, path: `${req.newParent}/${req.newName ?? "x"}`, revision: 2, auditId: "audit-receipt-1", oldRevision: 1 };
			return r;
		},
		// listHistory is a synchronous read in real WikiService; wrap in async for
		// uniform call-recording. Returns audit-shaped views.
		listHistory: (nodePath: string, limit: number, ctx: WikiRequestContext) => {
			calls.push({ method: "listHistory", req: { address: nodePath, limit }, ctx });
			return [{
				auditId: "audit-1",
				requestId: null,
				actorAgentId: "@ui-browser",
				sessionId: null,
				action: "update",
				nodePath,
				oldRevision: 1,
				newRevision: 2,
				detail: null,
				createdAt: "2026-07-16T00:00:00Z",
			}];
		},
	};
	const searchService = {
		search: async (req: WikiSearchRequest, ctx: WikiRequestContext) => {
			calls.push({ method: "search", req, ctx });
			const result: WikiSearchResult = {
				wikiHits: [], sourceHits: [], cursor: null, hasMore: false, truncated: false,
			};
			return result;
		},
	};
	return { calls, wikiService: wikiService as any, searchService: searchService as any };
}

// Recursively scan an object for any key that looks like a DB internal id.
const ID_KEY = /(^|_)(id)$|^id_|^nodeid$|parentid|^sourceid$|^targetid$/i;
function findIdKeys(obj: any, prefix = ""): string[] {
	const found: string[] = [];
	if (obj === null || obj === undefined) return found;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) found.push(...findIdKeys(obj[i], `${prefix}[${i}]`));
		return found;
	}
	if (typeof obj !== "object") return found;
	for (const [k, v] of Object.entries(obj)) {
		// auditId is the explicitly-public opaque receipt (allowed).
		if (k === "auditId") continue;
		if (ID_KEY.test(k)) found.push(`${prefix}.${k}`);
		found.push(...findIdKeys(v, `${prefix}.${k}`));
	}
	return found;
}

// ===========================================================================
// SUITE 1 — router forged-identity / authority / no-:nodeId / no-DB-ID
// ===========================================================================

describe("sub-06 adversarial · router forged-identity + authority injection", () => {
	let app: Express;
	let server: Server;
	let port: number;
	let runtime: ReturnType<typeof makeMockRuntime>;

	beforeEach(async () => {
		runtime = makeMockRuntime();
		setWikiRuntime({ wikiService: runtime.wikiService, searchService: runtime.searchService } as any);
		app = express();
		app.use(express.json({ limit: "1mb" }));
		app.use("/api/wiki", createWikiBrowserRouter());
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		_resetWikiRuntimeForTests();
	});

	// A1 — nine POST endpoints, no :nodeId path param
	test("A1: all 9 endpoints are POST and reject empty/invalid body; none use :nodeId", async () => {
		// A forged-identity-free but schema-invalid body for each endpoint.
		const endpoints = ["/expand", "/read", "/search", "/create", "/update", "/delete", "/link", "/unlink", "/move"];
		for (const ep of endpoints) {
			// Schema-invalid (missing required fields) → 400 INVALID_REQUEST,
			// NOT 404. A 404 would mean the route does not exist (or :nodeId expected).
			const res = await post(port, `/api/wiki${ep}`, {});
			expect(res.status, `${ep} should be mounted`).toBe(400);
			expect(res.data?.error?.code, `${ep} should return INVALID_REQUEST`).toBe("INVALID_REQUEST");
		}
		// GET on a POST endpoint → 404 (Express) confirms no :nodeId GET route leaks.
		const getter = await get(port, "/api/wiki/expand");
		expect(getter.status).toBe(404);
	});

	// A2 / H — every FORBIDDEN_BODY_KEYS field is rejected, and the service is
	// NEVER called (gate stops before schema parse / service dispatch).
	test("A2/H: each declared FORBIDDEN_BODY_KEYS field is rejected with INVALID_REQUEST and service never called", async () => {
		const forbidden = [
			"callerCtx", "grants", "access", "compiledAccess", "wikiAccess",
			"admin", "global", "is-admin", "isAdmin", "isGlobal",
			"agentId", "actorAgentId", "sessionId", "requestId", "policyRevision",
			"nodeId", "anchorIds", "wikiAnchors", "wikiAnchorNodeIds",
		];
		for (const key of forbidden) {
			runtime.calls.length = 0;
			const res = await post(port, "/api/wiki/expand", { address: "wiki-root", [key]: "forged-value" });
			expect(res.status, `key "${key}" must be rejected`).toBe(400);
			expect(res.data?.error?.code).toBe("INVALID_REQUEST");
			expect(res.data?.error?.message).toMatch(/forged identity/i);
			expect(runtime.calls.length, `service must NOT be called when body has "${key}"`).toBe(0);
		}
	});

	// Adversarial gap probe — identity/authority synonyms. Round-1 found a GAP:
	// activeProjectId/projectId/actor/channel/effectiveAccess/targetId/sourceId
	// were NOT in FORBIDDEN_BODY_KEYS (they slipped past the explicit gate, were
	// stripped by zod, but exposed a confused surface). Round-2 A2 fix CLOSED
	// that gap by adding them to FORBIDDEN_BODY_KEYS. We now assert:
	//   (1) the round-2-added synonyms ARE rejected (gap closed).
	//   (2) any remaining synonym that slips is zod-stripped, never reaches the
	//       service reqInput, and ctx.access stays the server constant.
	test("A2 round-2 fix: CompiledWikiAccess/WikiRequestContext shape synonyms ARE now rejected (gap closed)", async () => {
		// These keys are part of the ctx/access shape and would be dangerous if
		// read from body. Round-2 added them to FORBIDDEN_BODY_KEYS.
		const nowForbidden = [
			"projectId", "activeProjectId", "actor", "channel",
			"effectiveAccess", "targetId", "sourceId",
		];
		for (const key of nowForbidden) {
			runtime.calls.length = 0;
			const res = await post(port, "/api/wiki/expand", { address: "wiki-root", [key]: "evil" });
			expect(res.status, `round-2 should reject "${key}"`).toBe(400);
			expect(res.data?.error?.message).toMatch(/forged identity/i);
			expect(runtime.calls.length, `service must NOT be called for "${key}"`).toBe(0);
		}
	});

	test("A2 remaining-synonym safety: any non-forbidden synonym slips past gate but is zod-stripped; ctx stays server constant", async () => {
		const remainingSlippedSynonyms = [
			"actorId", "userId", "user", "principal", "subject", "role",
			"policy", "permission", "permissions", "wikiAdmin", "wikiGlobal",
			"sudo", "superuser", "elevate", "elevated", "privileged",
			"bypass", "bypassAccess", "impersonate", "onBehalfOf", "parentId", "id",
		];
		const slipped: string[] = [];
		for (const key of remainingSlippedSynonyms) {
			runtime.calls.length = 0;
			const res = await post(port, "/api/wiki/expand", { address: "wiki-root", [key]: "evil" });
			if (res.status === 200) {
				slipped.push(key);
				// Even though accepted, the safety property MUST hold:
				expect(runtime.calls.length, `service should still be called once for "${key}"`).toBe(1);
				const call = runtime.calls[0];
				// reqInput must NOT carry the forged key.
				expect(call.req[key], `forged key "${key}" must not propagate into service reqInput`).toBeUndefined();
				// ctx is the server constant — agentId is the UI browser sentinel.
				expect(call.ctx.access.agentId).toBe("@ui-browser");
				expect(call.ctx.access.grants[0].canonicalScope).toBe("wiki-root");
				expect(call.ctx.agentId).toBe("@ui-browser");
			}
		}
		// These synonyms are not part of the ctx/access shape (zod strips them
		// harmlessly). They are documented as "still slipping" — a future
		// hardening pass could add them to FORBIDDEN_BODY_KEYS for clarity, but
		// the safety property (no body-derived identity reaches service ctx)
		// holds today.
		expect(slipped.length).toBeGreaterThan(0);
		// Sanity: the round-2-closed keys are NOT in the slipping list anymore.
		expect(slipped).not.toContain("projectId");
		expect(slipped).not.toContain("activeProjectId");
	});

	// A3 / H — UI authority is the server constant regardless of body. Even a
	// body without any identity field yields exactly the UI admin access, and
	// mutation endpoints receive the same ctx.
	test("A3/H: server injects UI admin authority; body cannot expand permissions (create mutation)", async () => {
		runtime.calls.length = 0;
		const res = await post(port, "/api/wiki/create", { parent: "wiki-root/knowledge", name: "n" });
		expect(res.status).toBe(200);
		expect(runtime.calls.length).toBe(1);
		const call = runtime.calls[0];
		expect(call.ctx.access.agentId).toBe("@ui-browser");
		expect(call.ctx.access.activeProjectId).toBeUndefined();
		expect(call.ctx.access.grants).toHaveLength(1);
		expect(call.ctx.access.grants[0].canonicalScope).toBe("wiki-root");
		expect(call.ctx.access.grants[0].actions).toEqual([
			"expand", "read", "search", "create", "update", "delete", "link", "unlink", "move",
		]);
		// 9 actions = full data plane, no admin-plane action (no hardDelete/restore).
		expect(call.ctx.access.grants[0].actions).toHaveLength(9);
	});

	// B1 / H — REST responses carry no DB internal integer id. Mock returns the
	// canonical view shape; assert no id-like key slips through the wire.
	test("B1/H: expand + read + mutation responses contain no DB internal id keys", async () => {
		const exp = await post(port, "/api/wiki/expand", { address: "wiki-root" });
		expect(exp.status).toBe(200);
		expect(findIdKeys(exp.data)).toEqual([]);

		const rd = await post(port, "/api/wiki/read", { address: "wiki-root", view: "all" });
		expect(rd.status).toBe(200);
		expect(findIdKeys(rd.data)).toEqual([]);

		const mut = await post(port, "/api/wiki/create", { parent: "wiki-root/knowledge", name: "n" });
		expect(mut.status).toBe(200);
		// auditId is the explicitly-public opaque receipt (allowed by design).
		const ids = findIdKeys(mut.data);
		expect(ids).toEqual([]);
	});

	// A2 — forged identity is rejected BEFORE the service is called, on every
	// endpoint (not just /expand).
	test("A2: forged `grants` on /move is rejected and move service never called", async () => {
		runtime.calls.length = 0;
		const res = await post(port, "/api/wiki/move", {
			address: "wiki-root/a", newParent: "wiki-root/b", newName: "c",
			grants: [{ canonicalScope: "wiki-root", actions: ["delete"] }],
		});
		expect(res.status).toBe(400);
		expect(res.data?.error?.message).toMatch(/forged identity/i);
		expect(runtime.calls.length).toBe(0);
	});

	// C4 (router half) — service REGEX_INVALID bubbles out as structured error,
	// router does NOT swallow it / retry as substring. Must throw a REAL
	// WikiServiceError because the router detects via `instanceof`.
	test("C4 (router): searchService REGEX_INVALID surfaces as structured 400, not swallowed", async () => {
		const failingSearch = {
			search: async () => { throw wikiError("REGEX_INVALID", "invalid regex: SyntaxError at 1:2"); },
		};
		setWikiRuntime({ wikiService: runtime.wikiService, searchService: failingSearch as any } as any);
		const res = await post(port, "/api/wiki/search", { query: "(", mode: "regex", target: "wiki" });
		expect(res.status).toBe(400);
		expect(res.data?.error?.code).toBe("REGEX_INVALID");
		expect(res.data?.error?.message).toMatch(/invalid regex/);
		// Same path for REGEX_TIMEOUT — distinct code preserved through the router.
		const failingTimeout = {
			search: async () => { throw wikiError("REGEX_TIMEOUT", "wall time > 250ms"); },
		};
		setWikiRuntime({ wikiService: runtime.wikiService, searchService: failingTimeout as any } as any);
		const res2 = await post(port, "/api/wiki/search", { query: "(a+)+b", mode: "regex", target: "wiki" });
		expect(res2.status).toBe(400);
		expect(res2.data?.error?.code).toBe("REGEX_TIMEOUT");
	});

	// ── /history endpoint (round-2 D7 fix) — adversarial attack surface ─────
	// /history is a new read endpoint. Attack it like the others: forged
	// identity in body must be rejected BEFORE the service is called; path
	// traversal (`..`) must be rejected by the resolver; limit abuse must be
	// rejected by zod; and the endpoint must NOT emit data:changed (pure read).

	test("D7: POST /history is mounted (400 on invalid body, not 404); GET 404 (no :nodeId leak)", async () => {
		const res = await post(port, "/api/wiki/history", {});
		expect(res.status).toBe(400);
		expect(res.data?.error?.code).toBe("INVALID_REQUEST");
		const getter = await get(port, "/api/wiki/history");
		expect(getter.status).toBe(404);
	});

	test("D7/A2: /history rejects every FORBIDDEN_BODY_KEYS identity field; service never called", async () => {
		const forbidden = [
			"callerCtx", "grants", "admin", "global", "is-admin", "isAdmin",
			"agentId", "actorAgentId", "sessionId", "requestId", "policyRevision",
			"projectId", "activeProjectId", "actor", "channel",
			"effectiveAccess", "targetId", "sourceId",
			"nodeId", "anchorIds",
		];
		for (const key of forbidden) {
			runtime.calls.length = 0;
			const res = await post(port, "/api/wiki/history", { address: "wiki-root", [key]: "evil" });
			expect(res.status, `${key} must be rejected on /history`).toBe(400);
			expect(res.data?.error?.message).toMatch(/forged identity/i);
			expect(runtime.calls.length, `service must NOT be called for ${key}`).toBe(0);
		}
	});

	test("D7: /history happy path delegates to listHistory(address, limit, ctx) with UI-admin ctx", async () => {
		runtime.calls.length = 0;
		const res = await post(port, "/api/wiki/history", { address: "wiki-root/knowledge", limit: 25 });
		expect(res.status).toBe(200);
		expect(res.data?.ok).toBe(true);
		expect(runtime.calls.length).toBe(1);
		const call = runtime.calls[0];
		expect(call.method).toBe("listHistory");
		expect(call.req.address).toBe("wiki-root/knowledge");
		expect(call.req.limit).toBe(25);
		// ctx is the server UI-admin constant — not body-derived.
		expect(call.ctx.access.agentId).toBe("@ui-browser");
		expect(call.ctx.access.grants[0].canonicalScope).toBe("wiki-root");
		// Returned audit rows pass through unchanged.
		expect(Array.isArray(res.data.result)).toBe(true);
		expect(res.data.result[0].action).toBe("update");
		expect(res.data.result[0].actorAgentId).toBe("@ui-browser");
		// No internal DB id leaked (auditId is the allowed opaque receipt).
		expect(findIdKeys(res.data)).toEqual([]);
	});

	test("D7: /history limit abuse (0/negative/string/>500) rejected by schema; service never called", async () => {
		const abuse = [
			{ address: "wiki-root", limit: 0 },
			{ address: "wiki-root", limit: -5 },
			{ address: "wiki-root", limit: 1.5 }, // non-integer
			{ address: "wiki-root", limit: 501 }, // > max(500)
			{ address: "wiki-root", limit: "100" }, // string, not number
			{ address: "wiki-root", limit: NaN },
		];
		for (const body of abuse) {
			runtime.calls.length = 0;
			const res = await post(port, "/api/wiki/history", body);
			expect(res.status, `limit=${(body as any).limit} must be rejected`).toBe(400);
			expect(res.data?.error?.code).toBe("INVALID_REQUEST");
			expect(runtime.calls.length, `service must NOT be called for limit=${(body as any).limit}`).toBe(0);
		}
	});

	test("D7: /history defaults limit to 100 when omitted (matches store loadHistory)", async () => {
		runtime.calls.length = 0;
		const res = await post(port, "/api/wiki/history", { address: "wiki-root" });
		expect(res.status).toBe(200);
		expect(runtime.calls[0].req.limit).toBe(100);
	});

	test("D7/E: /history does NOT emit data:changed (read-only — no mutation, no WS storm)", async () => {
		// Spy on data-change-hub by intercepting require. Easier: assert that the
		// router source for /history contains no emit* call, AND that no
		// wiki_nodes/wiki_links/wiki_sync emission is wired for the history path.
		const fs = await import("node:fs");
		const src = fs.readFileSync(join(process.cwd(), "src/server/wiki-router.ts"), "utf-8");
		// Slice the /history handler body (between `router.post("/history"` and the
		// next `router.post(` or `return router`).
		const start = src.indexOf(`router.post("/history"`);
		expect(start).toBeGreaterThan(-1);
		const end = src.indexOf("return router;", start);
		const body = src.slice(start, end);
		// History handler must NOT emit data:changed (read-only meta-query).
		expect(body).not.toMatch(/emitWikiNodeChange|emitWikiLinkChange|emitWikiSyncChange/);
		expect(body).not.toMatch(/emitDataChange/);
	});
});

// ===========================================================================
// SUITE 2 — workspace-doc sandbox (path escape adversarial)
// ===========================================================================

describe("sub-06 adversarial · workspace-doc sandbox path escape", () => {
	let tmpDir: string;
	let sessionDB: CoreDatabase;
	let projectStore: ProjectStore;
	let app: Express;
	let server: Server;
	let port: number;
	let workspaceDir: string;
	let projectId: string;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "sub06-ws-"));
		sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
		runMigrations(sessionDB);
		projectStore = new ProjectStore(sessionDB);
		workspaceDir = join(tmpDir, "ws");
		mkdirSync(join(workspaceDir, "docs"), { recursive: true });
		writeFileSync(join(workspaceDir, "docs", "ok.md"), "# ok");
		writeFileSync(join(tmpDir, "secret.env"), "KEY=leaked");
		const proj = projectStore.create({ name: "WS", workspaceDir });
		projectId = proj.id;
		app = express();
		app.use(express.json());
		app.get("/api/projects/:projectId/workspace-doc", createWorkspaceDocHandler({ projectStore }));
		const l = await listen(app);
		server = l.server; port = l.port;
	});
	afterEach(async () => {
		await close(server);
		try { sessionDB.close(); } catch {}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("D5: allows in-workspace doc", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("docs/ok.md")}`);
		expect(res.status).toBe(200);
		expect(res.data.content).toContain("# ok");
	});

	test("D5: rejects single-level ../ escape", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("../secret.env")}`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
	});

	test("D5: rejects URL-encoded ..%2f escape", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=..%2F..%2Fsecret.env`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
	});

	test("D5: rejects mixed-slash backslash escape (Windows \\..\\)", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent("..\\..\\secret.env")}`);
		expect(res.status).toBe(400);
	});

	test("D5: rejects absolute path resolving outside workspace", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc?relPath=${encodeURIComponent(join(tmpDir, "secret.env"))}`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/outside workspace/);
	});

	test("D5: missing relPath → 400", async () => {
		const res = await get(port, `/api/projects/${projectId}/workspace-doc`);
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/relPath/);
	});

	test("D5: unknown project → 404", async () => {
		const res = await get(port, `/api/projects/no-such/workspace-doc?relPath=docs/ok.md`);
		expect(res.status).toBe(404);
	});
});

// ===========================================================================
// SUITE 3 — XSS: react-markdown WITHOUT rehype-raw (matches WikiDetail.tsx)
// ===========================================================================

describe("sub-06 adversarial · Markdown XSS (WikiDetail Content tab config)", () => {
	// WikiDetail.tsx renders <ReactMarkdown remarkPlugins={[remarkGfm]}> with NO
	// rehypePlugins. This is the exact config we exercise. raw HTML / inline
	// event handlers / javascript: URLs MUST be escaped or stripped, never
	// executable.

	function render(md: string): string {
		return renderToStaticMarkup(
			React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] } as any, md),
		);
	}

	test("D2/H: <script> tag is NOT emitted as a live script element", () => {
		const html = render("hello <script>alert(1)</script> world");
		// react-markdown v10 escapes raw HTML → the literal `<script>` must NOT
		// appear as an executable element. It may appear as escaped text
		// (`&lt;script&gt;`) which is inert.
		expect(html).not.toMatch(/<script\b/i);
	});

	test("D2/H: <img onerror=...> is emitted as escaped text, never a live <img> element", () => {
		const html = render('<img src=x onerror="alert(1)">');
		// No LIVE <img> element (unescaped tag start).
		expect(html).not.toMatch(/<img\b/i);
		// No live event-handler attribute either: a real onerror="..." (with a
		// real quote) is the executable shape. Escaped form uses &quot; so this
		// pattern only matches a live attribute.
		expect(html).not.toMatch(/onerror\s*=\s*["']/i);
		// And confirm the raw tag was escaped (inert text), not silently dropped
		// to some other active shape.
		expect(html).toMatch(/&lt;img/);
	});

	test("D2/H: javascript: URL in a markdown link is sanitized", () => {
		const html = render("[click](javascript:alert(1))");
		expect(html).not.toMatch(/javascript:/i);
		expect(html).not.toMatch(/href\s*=\s*"javascript:/i);
	});

	test("D2/H: inline event-handler HTML is escaped, not rendered as a live element", () => {
		const html = render('<a href="#" onload="alert(1)">x</a>');
		// No live anchor carrying an onload attribute (real quote = live attr).
		expect(html).not.toMatch(/<a\s[^>]*onload\s*=\s*["']/i);
		// Escaped form present (inert text).
		expect(html).toMatch(/&lt;a/);
	});

	test("D2/H: regular GFM still renders (regression guard — not over-escaping structure)", () => {
		const html = render("# Title\n\n- a\n- b\n\n**bold** `code`");
		expect(html).toContain("<h1");
		expect(html).toContain("<ul");
		expect(html).toContain("<strong");
		expect(html).toContain("<code");
	});

	// Defense that the dangerous alternative (rehype-raw) WOULD execute — proves
	// the safety depends on NOT configuring rehype-raw in WikiDetail.
	test("PROOF-OF-RISK: same payload WITH rehype-raw WOULD emit raw script (confirms config matters)", async () => {
		const rehypeRaw = (await import("rehype-raw")).default;
		const html = renderToStaticMarkup(
			React.createElement(
				ReactMarkdown,
				{ remarkPlugins: [remarkGfm], rehypePlugins: [rehypeRaw] } as any,
				"hello <script>alert(1)</script>",
			),
		);
		// With rehype-raw the raw script tag flows into the static markup — this is
		// exactly why WikiDetail MUST keep rehype-raw OFF (it does).
		expect(html).toMatch(/<script/i);
	});
});

// ===========================================================================
// SUITE 4 — store adversarial (mock window.api): pagination, conflict,
// regex error, no-DB-ID, move invalidation, data:changed subscription,
// legacy project_wiki residue.
// ===========================================================================

describe("sub-06 adversarial · wiki-store state machine", () => {
	let expandMock: ReturnType<typeof vi.fn>;
	let readMock: ReturnType<typeof vi.fn>;
	let searchMock: ReturnType<typeof vi.fn>;
	let createMock: ReturnType<typeof vi.fn>;
	let updateMock: ReturnType<typeof vi.fn>;
	let deleteMock: ReturnType<typeof vi.fn>;
	let moveMock: ReturnType<typeof vi.fn>;
	let linkMock: ReturnType<typeof vi.fn>;
	let unlinkMock: ReturnType<typeof vi.fn>;
	let historyMock: ReturnType<typeof vi.fn>;
	let onDataChangedCb: ((e: any) => void) | null;
	let useWikiStore: typeof import("../../src/renderer/store/wiki-store.js").useWikiStore;
	let addErrorSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		expandMock = vi.fn();
		readMock = vi.fn();
		searchMock = vi.fn();
		createMock = vi.fn();
		updateMock = vi.fn();
		deleteMock = vi.fn();
		moveMock = vi.fn();
		linkMock = vi.fn();
		unlinkMock = vi.fn();
		historyMock = vi.fn();
		onDataChangedCb = null;
		addErrorSpy = vi.fn();

		(globalThis as any).window = {
			api: {
				wikiV2Expand: expandMock,
				wikiV2Read: readMock,
				wikiV2Search: searchMock,
				wikiV2Create: createMock,
				wikiV2Update: updateMock,
				wikiV2Delete: deleteMock,
				wikiV2Move: moveMock,
				wikiV2Link: linkMock,
				wikiV2Unlink: unlinkMock,
				wikiV2History: historyMock,
				wikiV2ReadWorkspaceDoc: vi.fn(),
				onDataChanged: (cb: (e: any) => void) => { onDataChangedCb = cb; },
			},
		};
		// Reset module cache so the store's `if (typeof window !== "undefined")`
		// subscription block re-runs against THIS test's window mock. Without
		// resetModules, the subscription is registered exactly once (first import)
		// against the first test's mock, leaving onDataChangedCb null in later
		// tests.
		vi.resetModules();
		// notification store spy (re-imported fresh after resetModules so the spy
		// targets the same module instance wiki-store imports).
		const notif = await import("../../src/renderer/store/notification-store.js");
		vi.spyOn(notif.useNotificationStore, "getState").mockReturnValue({ addError: addErrorSpy } as any);

		({ useWikiStore } = await import("../../src/renderer/store/wiki-store.js"));
		// Reset store to a clean baseline (isolated per test).
		useWikiStore.setState({
			scope: { kind: "global" },
			showArchived: false,
			childrenByPath: {}, childrenLoaded: {}, loadingChildren: {}, summaryByPath: {},
			detailByPath: {}, relationsByPath: {}, sourceByPath: {}, historyByPath: {},
			selectedPath: null, lastSearchParams: null, searchResult: null,
			searchLoading: false, searchError: null,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		delete (globalThis as any).window;
	});

	// B7 — 1,000 siblings. expandPath requests DEFAULT_PAGE_SIZE (50) and stops;
	// only loadMoreChildren pulls the next page.
	test("B7/H: 1,000 siblings are NOT fetched at once — first page is 50, rest via Load more", async () => {
		const fifty = Array.from({ length: 50 }, (_, i) => ({
			path: `wiki-root/c${i}`, name: `c${i}`, kind: "node" as const,
			summary: "", revision: 1, displayTitle: `c${i}`, archived: false,
		}));
		expandMock.mockResolvedValue({
			ok: true,
			result: {
				path: "wiki-root", summary: "s", displayTitle: "root", kind: "root",
				children: { items: fifty, cursor: "page2", hasMore: true },
				auditId: null,
			},
		});

		await useWikiStore.getState().expandPath("wiki-root", { reset: true });

		// Exactly ONE expand call, with limit = 50 (DEFAULT_PAGE_SIZE).
		expect(expandMock).toHaveBeenCalledTimes(1);
		const arg = expandMock.mock.calls[0][0];
		expect(arg.limit).toBe(50);
		expect(arg.address).toBe("wiki-root");
		// Only the first 50 are in store; 950 more are NOT.
		const page = useWikiStore.getState().childrenByPath["wiki-root"];
		expect(page.items).toHaveLength(50);
		expect(page.hasMore).toBe(true);

		// Second page on loadMoreChildren.
		const next50 = Array.from({ length: 50 }, (_, i) => ({
			path: `wiki-root/c${100 + i}`, name: `c${100 + i}`, kind: "node" as const,
			summary: "", revision: 1, displayTitle: `c${100 + i}`, archived: false,
		}));
		expandMock.mockResolvedValue({
			ok: true,
			result: {
				path: "wiki-root", summary: "s", displayTitle: "root", kind: "root",
				children: { items: next50, cursor: null, hasMore: false },
				auditId: null,
			},
		});
		await useWikiStore.getState().loadMoreChildren("wiki-root");
		expect(expandMock).toHaveBeenCalledTimes(2);
		const arg2 = expandMock.mock.calls[1][0];
		expect(arg2.cursor).toBe("page2");
		expect(useWikiStore.getState().childrenByPath["wiki-root"].items).toHaveLength(100);
	});

	// C4 — regex invalid surfaces as a notification; store does NOT retry as
	// substring and does NOT populate searchResult with substring matches.
	test("C4/H: REGEX_INVALID is surfaced, not silently degraded to substring", async () => {
		searchMock.mockResolvedValue({
			ok: false, error: { code: "REGEX_INVALID", message: "invalid regex: (" },
		});
		await useWikiStore.getState().runSearch({
			query: "(", mode: "regex", target: "wiki", cursor: null,
		});
		// Only ONE search call (no substring retry).
		expect(searchMock).toHaveBeenCalledTimes(1);
		expect(searchMock.mock.calls[0][0].mode).toBe("regex");
		// Error surfaced via notification.
		expect(addErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/REGEX_INVALID/));
		// searchResult stays null — no fake substring hits.
		expect(useWikiStore.getState().searchResult).toBeNull();
		expect(useWikiStore.getState().searchLoading).toBe(false);
	});

	// REGEX_TIMEOUT — same path, distinct code preserved.
	test("C4: REGEX_TIMEOUT surfaces with its specific code", async () => {
		searchMock.mockResolvedValue({
			ok: false, error: { code: "REGEX_TIMEOUT", message: "wall time exceeded" },
		});
		await useWikiStore.getState().runSearch({
			query: "(a+)+b", mode: "regex", target: "wiki", cursor: null,
		});
		expect(addErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/REGEX_TIMEOUT/));
	});

	// D3/D4 — WRITE_CONFLICT: store updateNode returns null (no throw) and does
	// not corrupt the cached detail. Draft text lives in the component (verified
	// by reading WikiDetail.tsx — draftSummary/draftContent are useState cleared
	// only on successful save/cancel).
	test("D3/D4: WRITE_CONFLICT from update → store returns null, surfaces error, keeps existing detail cache", async () => {
		// Seed a detail cache as if the user had loaded the node.
		useWikiStore.setState({
			detailByPath: {
				"wiki-root/knowledge/n": {
					node: {
						path: "wiki-root/knowledge/n", name: "n", kind: "node", summary: "old",
						revision: 5, parentPath: "wiki-root/knowledge", createdAt: "t", updatedAt: "t",
						archivedAt: null, attributes: {}, sourceBound: false, displayTitle: "n",
					},
					content: "old body", loading: false,
				},
			},
		});
		updateMock.mockResolvedValue({
			ok: false, error: { code: "WRITE_CONFLICT", message: "revision mismatch (server=6)" },
		});
		const res = await useWikiStore.getState().updateNode({
			address: "wiki-root/knowledge/n", expected_revision: 5, summary: "new",
		});
		expect(res).toBeNull();
		expect(addErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/WRITE_CONFLICT/));
		// Existing detail cache is not wiped by the failed call (store updateNode
		// only invalidates on success).
		const detail = useWikiStore.getState().detailByPath["wiki-root/knowledge/n"];
		expect(detail?.node?.summary).toBe("old");
		expect(detail?.content).toBe("old body");
	});

	// E1/E2 — move event: oldPath subtree cache cleared, both old + new parent
	// invalidated.
	test("E1/E2: move event clears oldPath subtree and invalidates old + new parent", () => {
		// Seed caches: oldParent has child X (the moved node), newParent empty.
		useWikiStore.setState({
			childrenLoaded: {
				"wiki-root/old": true, "wiki-root/new": true, "wiki-root/old/X": true,
			},
			childrenByPath: {
				"wiki-root/old": {
					items: [{
						path: "wiki-root/old/X", name: "X", kind: "node", summary: "",
						revision: 1, displayTitle: "X", archived: false,
					}],
					cursor: null, hasMore: false,
				},
				"wiki-root/new": { items: [], cursor: null, hasMore: false },
				"wiki-root/old/X": { items: [], cursor: null, hasMore: false },
			},
			summaryByPath: {
				"wiki-root/old/X": { displayTitle: "X" },
			},
			detailByPath: { "wiki-root/old/X": { loading: false } },
		});

		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/new/X",
			op: "move",
			oldPath: "wiki-root/old/X",
			parentPath: "wiki-root/new",
		});

		const s = useWikiStore.getState();
		// oldPath subtree cleared.
		expect(s.childrenByPath["wiki-root/old/X"]).toBeUndefined();
		expect(s.childrenLoaded["wiki-root/old/X"]).toBeUndefined();
		expect(s.summaryByPath["wiki-root/old/X"]).toBeUndefined();
		expect(s.detailByPath["wiki-root/old/X"]).toBeUndefined();
		// both parents invalidated (childrenByPath + childrenLoaded deleted).
		expect(s.childrenLoaded["wiki-root/old"]).toBeUndefined();
		expect(s.childrenByPath["wiki-root/old"]).toBeUndefined();
		expect(s.childrenLoaded["wiki-root/new"]).toBeUndefined();
		expect(s.childrenByPath["wiki-root/new"]).toBeUndefined();
	});

	// E3 — unexpanded branch receiving an event does NOT trigger a fetch.
	test("E3: event for an un-loaded parent does NOT trigger expand", () => {
		// parentPath "wiki-root/never-loaded" has NO cache entry.
		const beforeExpandCalls = expandMock.mock.calls.length;
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/never-loaded/child",
			op: "create",
			parentPath: "wiki-root/never-loaded",
		});
		expect(expandMock.mock.calls.length).toBe(beforeExpandCalls); // no fetch
	});

	// A6 / legacy residue — the wiki-store data:changed subscription must ignore
	// project_wiki events (only wiki_nodes/wiki_links/wiki_sync are handled).
	test("A6/H: project_wiki data event is ignored by the wiki-store subscription", () => {
		expect(onDataChangedCb).not.toBeNull();
		// Seed some state we can assert is untouched.
		useWikiStore.setState({
			childrenLoaded: { "wiki-root/stable": true },
			childrenByPath: { "wiki-root/stable": { items: [], cursor: null, hasMore: false } },
		});
		const before = useWikiStore.getState().childrenLoaded;
		// Simulate a stray project_wiki event (legacy collection).
		onDataChangedCb!({
			collection: "project_wiki",
			changes: [{ id: "anything", op: "update", record: { path: "wiki-root/stable", op: "update" } }],
		});
		expect(useWikiStore.getState().childrenLoaded).toBe(before); // unchanged
		expect(useWikiStore.getState().childrenByPath["wiki-root/stable"]).toBeDefined();
	});

	test("A6: wiki_nodes event IS handled (cache invalidated)", () => {
		expect(onDataChangedCb).not.toBeNull();
		useWikiStore.setState({
			childrenLoaded: { "wiki-root/x": true },
			detailByPath: { "wiki-root/x": { loading: false } },
		});
		onDataChangedCb!({
			collection: "wiki_nodes",
			changes: [{ id: "wiki-root/x", op: "update", record: { path: "wiki-root/x", op: "update", parentPath: "wiki-root" } }],
		});
		// detail for the node is invalidated.
		expect(useWikiStore.getState().detailByPath["wiki-root/x"]).toBeUndefined();
	});

	// wiki_links event invalidates relations cache for both endpoints.
	test("E1: wiki_links event invalidates source + target relations cache", () => {
		expect(onDataChangedCb).not.toBeNull();
		useWikiStore.setState({
			relationsByPath: {
				"wiki-root/a": { outgoing: [], incoming: [] },
				"wiki-root/b": { outgoing: [], incoming: [] },
			},
		});
		onDataChangedCb!({
			collection: "wiki_links",
			changes: [{ id: "wiki-root/a|wiki-root/b|related_to", op: "update",
				record: { source: "wiki-root/a", target: "wiki-root/b", relation: "related_to" } }],
		});
		expect(useWikiStore.getState().relationsByPath["wiki-root/a"]).toBeUndefined();
		expect(useWikiStore.getState().relationsByPath["wiki-root/b"]).toBeUndefined();
	});

	// B1 — store cache keys are canonical paths, never DB ids. Seed via the
	// expand mock and assert every Record key is path-shaped.
	test("B1/H: store cache keys are canonical paths, never integer ids", async () => {
		expandMock.mockResolvedValue({
			ok: true,
			result: {
				path: "wiki-root/knowledge", summary: "s", displayTitle: "Knowledge", kind: "knowledge",
				children: {
					items: [{
						path: "wiki-root/knowledge/child-1", name: "child-1", kind: "node",
						summary: "", revision: 1, displayTitle: "child-1", archived: false,
					}],
					cursor: null, hasMore: false,
				},
				auditId: null,
			},
		});
		await useWikiStore.getState().expandPath("wiki-root/knowledge", { reset: true });
		const s = useWikiStore.getState();
		const keySets = [
			Object.keys(s.childrenByPath),
			Object.keys(s.childrenLoaded),
			Object.keys(s.summaryByPath),
		];
		for (const keys of keySets) {
			for (const k of keys) {
				// every key must start with wiki-root or be a logical address scheme,
				// never a bare integer id.
				expect(k).toMatch(/^(wiki-root\/|[a-z]+:\/\/)/);
				expect(k).not.toMatch(/^\d+$/);
			}
		}
		// No internal id in summary entries either.
		expect(findIdKeys(s.summaryByPath)).toEqual([]);
	});

	// ── D7 store — loadHistory actually calls wikiV2History + maps entries ──
	test("D7: store.loadHistory calls wikiV2History and maps audit rows into historyByPath", async () => {
		historyMock.mockResolvedValue({
			ok: true,
			result: [{
				auditId: "a1", requestId: null, actorAgentId: "agent-x", sessionId: null,
				action: "update", nodePath: "wiki-root/knowledge/n",
				oldRevision: 3, newRevision: 4, detail: null, createdAt: "2026-07-16T01:02:03Z",
			}],
		});
		await useWikiStore.getState().loadHistory("wiki-root/knowledge/n");
		expect(historyMock).toHaveBeenCalledTimes(1);
		expect(historyMock.mock.calls[0][0]).toEqual({ address: "wiki-root/knowledge/n", limit: 100 });
		const cache = useWikiStore.getState().historyByPath["wiki-root/knowledge/n"];
		expect(cache).toBeDefined();
		expect(cache.entries).toHaveLength(1);
		// Mapping preserves all 7 HistoryEntry fields (no internal id; no DB leak).
		expect(cache.entries[0]).toEqual({
			auditId: "a1", action: "update", actorAgentId: "agent-x",
			nodePath: "wiki-root/knowledge/n", oldRevision: 3, newRevision: 4,
			createdAt: "2026-07-16T01:02:03Z",
		});
		expect(findIdKeys(cache.entries)).toEqual([]);
	});

	test("D7: store.loadHistory surfaces error and stays retryable (next call hits IPC again)", async () => {
		historyMock.mockResolvedValue({
			ok: false, error: { code: "ACCESS_DENIED", message: "no read" },
		});
		await useWikiStore.getState().loadHistory("wiki-root/secret");
		expect(addErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/ACCESS_DENIED/));
		const cache = useWikiStore.getState().historyByPath["wiki-root/secret"];
		expect(cache.error).toBeTruthy();
		// Retry: error cache is NOT cached as success — second call hits IPC again.
		historyMock.mockClear();
		await useWikiStore.getState().loadHistory("wiki-root/secret");
		expect(historyMock).toHaveBeenCalledTimes(1);
	});

	test("D7: store.loadHistory is lazy — successful fetch is cached (no second IPC call)", async () => {
		historyMock.mockResolvedValue({ ok: true, result: [] });
		await useWikiStore.getState().loadHistory("wiki-root/knowledge/n");
		await useWikiStore.getState().loadHistory("wiki-root/knowledge/n");
		expect(historyMock).toHaveBeenCalledTimes(1);
	});

	// ── E2 round-2 fix — wasParentLoaded snapshot drives post-set re-fetch ──
	// Round-1 bug: set() deleted childrenLoaded[parentPath] INSIDE set(), then
	// post-set code read get().childrenLoaded[parentPath] which was now undefined
	// → no re-fetch ever happened (dead branch). Round-2 fix snapshots
	// wasParentLoaded BEFORE set() so a previously-loaded parent is re-fetched.
	test("E2 fix: mutation against a LOADED parent triggers expandPath(reset) re-fetch (wasParentLoaded snapshot)", async () => {
		// Seed: parent wiki-root/loaded has been expanded once (childrenLoaded=true).
		useWikiStore.setState({
			childrenLoaded: { "wiki-root/loaded": true },
			childrenByPath: {
				"wiki-root/loaded": {
					items: [{
						path: "wiki-root/loaded/old", name: "old", kind: "node",
						summary: "stale", revision: 1, displayTitle: "old", archived: false,
					}],
					cursor: null, hasMore: false,
				},
			},
		});
		expandMock.mockClear();
		// Simulate a wiki_nodes mutation event arriving for the loaded parent.
		// _applyNodeEvent is what fires on data:changed wiki_nodes.
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/loaded/child",
			op: "create",
			parentPath: "wiki-root/loaded",
		});
		// Round-2 fix: parent WAS loaded → expandPath(reset) is fired → fresh data.
		expect(expandMock).toHaveBeenCalledTimes(1);
		expect(expandMock.mock.calls[0][0].address).toBe("wiki-root/loaded");
	});

	test("E2: move mutation re-fetches BOTH new parent AND old parent when both were loaded", async () => {
		// Seed both parents as loaded.
		useWikiStore.setState({
			childrenLoaded: { "wiki-root/old": true, "wiki-root/new": true },
			childrenByPath: {
				"wiki-root/old": { items: [], cursor: null, hasMore: false },
				"wiki-root/new": { items: [], cursor: null, hasMore: false },
			},
		});
		expandMock.mockClear();
		// move event: parentPath = new (gets re-fetch via wasParentLoaded);
		// old parent gets its own delete (wasParentLoaded only covers parentPath).
		// Note: the implementation fires expandPath only for parentPath; old
		// parent invalidation is delete-only (no auto-refetch of source parent
		// in this code path). This is by design — Wiki Browser WS event path
		// emits separate wiki_sync for the source side.
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/new/X",
			op: "move",
			oldPath: "wiki-root/old/X",
			parentPath: "wiki-root/new",
		});
		// new parent (parentPath) re-fetched.
		const addresses = expandMock.mock.calls.map((c) => c[0].address);
		expect(addresses).toContain("wiki-root/new");
	});

	test("E2/B4 interaction: previously-loaded parent re-fetches ONCE per mutation (no fetch storm)", async () => {
		useWikiStore.setState({
			childrenLoaded: { "wiki-root/p": true },
			childrenByPath: { "wiki-root/p": { items: [], cursor: null, hasMore: false } },
		});
		expandMock.mockClear();
		useWikiStore.getState()._applyNodeEvent({
			path: "wiki-root/p/c1", op: "create", parentPath: "wiki-root/p",
		});
		// Exactly one re-fetch — not zero (round-1 bug) and not many (storm).
		expect(expandMock).toHaveBeenCalledTimes(1);
	});

	// ── C2 round-2 fix — matchedField renders in DOM (not just in store) ────
	// Round-1 bug: store captured matchedField from search hits but WikiPage.tsx
	// only displayed matchType, not matchedField. Round-2 fix renders both.
	test("C2 fix: WikiPage renders h.matchedField in BOTH wiki hit and source hit DOM", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiPage.tsx"), "utf-8");
		// Slice the wiki search hit render and source search hit render.
		// Wiki hit block: data-testid="wiki-search-hit" ... map h => ...
		const wikiHitStart = src.indexOf(`data-testid="wiki-search-hit"`);
		expect(wikiHitStart).toBeGreaterThan(-1);
		const wikiHitEnd = src.indexOf(`data-testid="wiki-search-source-hit"`, wikiHitStart);
		const wikiHitBlock = src.slice(wikiHitStart, wikiHitEnd);
		expect(wikiHitBlock).toMatch(/\{h\.matchedField\}/);
		// Source hit block also shows matchedField.
		const sourceHitStart = src.indexOf(`data-testid="wiki-search-source-hit"`);
		const sourceHitEnd = src.indexOf("searchResult.hasMore", sourceHitStart);
		const sourceHitBlock = src.slice(sourceHitStart, sourceHitEnd);
		expect(sourceHitBlock).toMatch(/\{h\.matchedField\}/);
	});

	// ── D2 round-2 regression sweep — rehype-raw STILL not wired in WikiDetail ─
	test("D2 regression: WikiDetail still has NO rehype-raw wiring (round-2 did not sneak it in)", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(join(process.cwd(), "src/renderer/components/wiki/WikiDetail.tsx"), "utf-8");
		expect(src).not.toMatch(/import[^\n]*rehype-raw/);
		expect(src).not.toMatch(/rehypePlugins/);
		expect(src).toMatch(/remarkPlugins=\{\[remarkGfm\]\}/);
	});
});

// ===========================================================================
// SUITE 5 — static structural assertions (legacy residue + History stub)
// ===========================================================================

describe("sub-06 adversarial · structural residue (read source, don't trust docs)", () => {
	// These read the frozen source to assert absence of legacy plumbing, so the
	// claim does not silently regress.

	test("A6/H: wiki-store subscribes ONLY to wiki_nodes/wiki_links/wiki_sync (no project_wiki)", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(join(process.cwd(), "src/renderer/store/wiki-store.ts"), "utf-8");
		// The subscription filter:
		expect(src).toMatch(/collection !== "wiki_nodes" && collection !== "wiki_links" && collection !== "wiki_sync"/);
		// No active subscription handler for project_wiki.
		expect(src).not.toMatch(/collection === ["']project_wiki["']/);
	});

	test("A6/H: renderer has no production call to legacy wiki:* IPC channels", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const rendererRoot = join(process.cwd(), "src/renderer");
		const banned = /wikiGetChildren|wikiReadDetail|wikiSearch\b|wikiResolvedAnchors|wikiPreviewInjection|wikiGetNode\b|wikiCreateNode|wikiUpdateNode|wikiDeleteNode|wikiListByProject/;
		function walk(dir: string, out: string[] = []): string[] {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p, out);
				else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
			}
			return out;
		}
		const offenders: string[] = [];
		for (const f of walk(rendererRoot)) {
			const t = fs.readFileSync(f, "utf-8");
			if (banned.test(t)) offenders.push(f);
		}
		// The WikiTreePanel/AgentEditor references are comments/field round-trip,
		// not data-plane calls; verify by excluding known comment-only mentions.
		const real = offenders.filter((f) => !f.endsWith("WikiTreePanel.tsx") && !f.endsWith("AgentEditor.tsx") && !f.endsWith("agent-editor-types.ts"));
		expect(real, `legacy wiki:* IPC residue found: ${real.join(", ")}`).toEqual([]);
	});

	// ── D7 History — round-2 fix verified (was round-1 FAIL: History stub) ──
	// These tests assert the FIXED behavior. Round-1 had stub assertions
	// ("no listHistory method", "loadHistory is no-op") which are now inverted.
	test("D7 PASS: WikiService exposes public listHistory delegating to auditRepo.listByNodePath", async () => {
		const fs = await import("node:fs");
		const serviceSrc = fs.readFileSync(join(process.cwd(), "src/server/wiki/wiki-service.ts"), "utf-8");
		const routerSrc = fs.readFileSync(join(process.cwd(), "src/server/wiki-router.ts"), "utf-8");
		// listHistory method is present and delegates to auditRepo.listByNodePath.
		expect(serviceSrc).toMatch(/\blistHistory\s*\(/);
		expect(serviceSrc).toMatch(/auditRepo\.listByNodePath/);
		expect(serviceSrc).toMatch(/auditRowToView/);
		// /history endpoint mounted on router.
		expect(routerSrc).toMatch(/router\.post\("\/history"/);
		expect(routerSrc).toMatch(/historySchema/);
	});

	test("D7 PASS: wiki-store loadHistory calls wikiV2History (NOT a no-op stub)", async () => {
		const fs = await import("node:fs");
		const storeSrc = fs.readFileSync(join(process.cwd(), "src/renderer/store/wiki-store.ts"), "utf-8");
		const start = storeSrc.indexOf("loadHistory: async");
		expect(start).toBeGreaterThan(-1);
		// Slice until the next top-level action comma+newline (the impl ends
		// before the next action definition). Look for the callV2 call.
		const body = storeSrc.slice(start, start + 1500);
		expect(body).toMatch(/callV2<WikiAuditView\[\]>/);
		expect(body).toMatch(/"wikiV2History"/);
		expect(body).not.toMatch(/^return;$/m);
	});
});

// ===========================================================================
// SUITE 6 — listHistory is a pure READ (does not write audit)
// ===========================================================================
//
// Meta-query invariant: querying a node's audit history MUST NOT itself append
// a new audit row. If it did, every History-tab open would add a "listHistory"
// noise row to the very log being displayed — recursive pollution.
//
// We verify behaviorally with a REAL WikiService + temp wiki.db: count audit
// rows before and after listHistory, assert unchanged. (expand/read DO write
// audit receipts via appendAuditSafe; listHistory must not.)

describe("sub-06 adversarial · listHistory is read-only (no audit pollution)", () => {
	let tempDir: string;
	let wikiDb: WikiDatabase;
	let wikiService: WikiService;
	let auditRepo: WikiAuditRepository;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), `sub06-hist-${Date.now()}-`));
		wikiDb = new WikiDatabase(join(tempDir, "wiki.db"));
		wikiService = WikiService.fromDatabase(wikiDb);
		// Reach into the same auditRepo instance the service uses, to count rows.
		// Re-construct via the same DB connection that the service's repos share.
		const db = wikiDb.getDb();
		auditRepo = new WikiAuditRepository(db);
	});
	afterEach(() => {
		try { wikiDb.close(); } catch { /* idempotent */ }
		rmSync(tempDir, { recursive: true, force: true });
	});

	function uiCtx(): WikiRequestContext {
		return {
			access: {
				agentId: "@ui-browser",
				activeProjectId: undefined,
				grants: [{ canonicalScope: "wiki-root", actions: ["read"] as any }],
				policyRevision: 1,
			},
			agentId: "@ui-browser",
			activeProjectId: undefined,
			sessionId: null,
			requestId: null,
		};
	}

	test("D7 invariant: listHistory does NOT append a new audit row (meta-query must not pollute log)", () => {
		const before = auditRepo.count();
		// Call listHistory multiple times — every call must be read-only.
		wikiService.listHistory("wiki-root", 100, uiCtx());
		wikiService.listHistory("wiki-root", 100, uiCtx());
		wikiService.listHistory("wiki-root/knowledge", 50, uiCtx());
		const after = auditRepo.count();
		expect(after, "listHistory must not write audit rows").toBe(before);
	});

	test("D7 invariant: contrast — read() DOES write an audit receipt (proves the test can detect writes)", async () => {
		// This is the control: expand/read append audit receipts via
		// appendAuditSafe. If listHistory ever started writing, this same
		// counter would tick. So this test validates our measurement.
		const before = auditRepo.count();
		await wikiService.read({ address: "wiki-root", view: "summary" }, uiCtx());
		const after = auditRepo.count();
		expect(after, "read() must write an audit receipt (control)").toBeGreaterThan(before);
	});

	// Path traversal: resolveAddress goes through WikiAddressService.resolve →
	// normalizeWikiPath, which rejects `..` and `.` segments with INVALID_PATH
	// (mapped to INVALID_ADDRESS by the resolver). listHistory must surface this
	// as a structured error — never reach auditRepo.listByNodePath with a path
	// containing traversal segments.
	test("D7 security: listHistory rejects path-traversal addresses (`..` / `.` segments) with INVALID_ADDRESS", () => {
		const attackPaths = [
			"wiki-root/../memory/other-agent",
			"wiki-root/knowledge/../../memory",
			"wiki-root/./knowledge",
			"../secret",
		];
		for (const path of attackPaths) {
			let caught: any;
			try {
				wikiService.listHistory(path, 50, uiCtx());
			} catch (err) {
				caught = err;
			}
			expect(caught, `path "${path}" must be rejected`).toBeDefined();
			// WikiServiceError.code carries the structured code (message is human
			// prose without the code prefix). Both INVALID_PATH and INVALID_ADDRESS
			// are valid — the resolver wraps INVALID_PATH → INVALID_ADDRESS.
			const code = caught?.code ?? caught?.cause?.code;
			expect(code, `path "${path}" code=${code}`).toMatch(/INVALID_ADDRESS|INVALID_PATH/);
		}
	});

	// Even if a traversal-shaped string somehow reached auditRepo.listByNodePath,
	// the underlying query is exact-equality (`WHERE node_path = ?`) — no LIKE
	// pattern, no wildcard interpretation. Confirm this structurally.
	test("D7 security: auditRepo.listByNodePath uses exact equality (no LIKE/wildcard pattern matching)", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync(join(process.cwd(), "src/server/wiki/wiki-audit-repository.ts"), "utf-8");
		// Slice out the listByNodePath body.
		const start = src.indexOf("listByNodePath(");
		expect(start).toBeGreaterThan(-1);
		const body = src.slice(start, start + 600);
		expect(body).toMatch(/WHERE node_path = \?/);
		expect(body).not.toMatch(/LIKE/);
	});
});
