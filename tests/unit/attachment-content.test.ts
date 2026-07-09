// Unit tests for attachments:content endpoint (effort: multimodal-input sub-5).
//
// Covers the UI-rendering edge (component 8): reading attachment bytes back from
// disk for a HISTORY attachment thumbnail. The endpoint is mounted under
// /api/attachments/content on createAttachmentRouter().
//
// Cases:
//   - happy path: upload → content round-trip returns the SAME bytes (base64),
//     binary content is NOT rejected (unlike file-router), and the mime +
//     size fields are correct.
//   - path safety: a crafted diskPath that escapes the session dir is rejected
//     (400); a sessionId containing a path separator is rejected (400); a
//     sessionId with a sibling-prefix masquerade (`s` vs `s-other`) is rejected.
//   - 404 when the file is gone (ENOENT).
//   - 400 on missing params.
//
// The store roots writes at ATTACHMENTS_ROOT = resolve(ZERO_CORE_DIR/attachments),
// captured at module load. So we set ZERO_CORE_DIR to a temp dir, reset the
// module registry, THEN import the router + store — one stable root per file.

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";

let TMP = "";
let routerMod: typeof import("../../src/server/attachment-router.js");
let store: typeof import("../../src/server/attachment-store.js");

beforeAll(async () => {
	TMP = mkdtempSync(join(tmpdir(), "zero-attach-content-"));
	process.env.ZERO_CORE_DIR = TMP;
	// Bust the module cache so config.ts re-reads ZERO_CORE_DIR (→ TMP) and the
	// store's ATTACHMENTS_ROOT resolves under TMP for every test.
	vi.resetModules();
	routerMod = await import("../../src/server/attachment-router.js");
	store = await import("../../src/server/attachment-store.js");
});

afterAll(() => {
	delete process.env.ZERO_CORE_DIR;
	if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ─── Express harness (mirrors rest-routers.test.ts) ─────────────────────────

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

async function request(port: number, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}/api/attachments/content`;
	const opts: RequestInit = { method: "POST" };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}

let app: Express;
let server: Server;
let port: number;

beforeEach(async () => {
	app = express();
	app.use(express.json({ limit: "50mb" }));
	app.use("/api/attachments", routerMod.createAttachmentRouter());
	const r = await listen(app);
	server = r.server;
	port = r.port;
});

afterEach(async () => { await close(server); });

describe("attachments:content endpoint (sub-5 / component 8)", () => {
	test("upload → content round-trip returns the SAME bytes (base64); binary NOT rejected", async () => {
		// PNG-ish binary header — file-router would reject this as "(binary file)",
		// but the content endpoint must serve it. Mix in a zero byte to prove
		// binary-safe transport.
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
		const meta = await store.saveAttachment({
			sessionId: "sess-rt",
			fileName: "photo.png",
			mimeType: "image/png",
			dataBase64: bytes.toString("base64"),
		});

		const res = await request(port, {
			sessionId: "sess-rt",
			diskPath: meta.diskPath,
			mimeType: meta.mimeType,
		});

		expect(res.status).toBe(200);
		expect(res.data.data).toBe(bytes.toString("base64"));
		expect(res.data.mimeType).toBe("image/png");
		expect(res.data.size).toBe(bytes.length);
		// Decoded bytes equal the original (binary-safe).
		expect(Buffer.from(res.data.data, "base64").equals(bytes)).toBe(true);
	});

	test("falls back to application/octet-stream when mimeType is omitted", async () => {
		const bytes = Buffer.from([1, 2, 3, 4, 5]);
		const meta = await store.saveAttachment({
			sessionId: "sess-mime",
			fileName: "blob",
			mimeType: "application/octet-stream",
			dataBase64: bytes.toString("base64"),
		});

		const res = await request(port, {
			sessionId: "sess-mime",
			diskPath: meta.diskPath,
			// mimeType intentionally omitted
		});

		expect(res.status).toBe(200);
		expect(res.data.mimeType).toBe("application/octet-stream");
		expect(Buffer.from(res.data.data, "base64").equals(bytes)).toBe(true);
	});

	// ── PATH SAFETY (the load-bearing part for the content endpoint) ────────

	test("REJECTS a diskPath that escapes the session dir (traversal)", async () => {
		// A crafted absolute path outside attachments entirely. readAttachment's
		// assertWithinSession must throw → endpoint surfaces 400 (no path echo).
		const res = await request(port, {
			sessionId: "sess-real",
			diskPath: join(TMP, "secret.txt"),
		});
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/path escapes|invalid sessionId/);
		// The path itself is NEVER echoed back (no path disclosure).
		expect(JSON.stringify(res.data)).not.toContain("secret.txt");
	});

	test("REJECTS a sibling-prefix masquerade (s vs s-other)", async () => {
		// Even a path that LOOKS like it belongs to the session (s-other/x) but
		// is requested under sessionId "s" must be rejected — the canonical
		// `dir/` prefix check prevents `/attachments/s-other/` from matching
		// session `s`.
		const other = await store.saveAttachment({
			sessionId: "s-other",
			fileName: "x.png",
			mimeType: "image/png",
			dataBase64: Buffer.from([1]).toString("base64"),
		});
		const res = await request(port, {
			sessionId: "s",
			diskPath: other.diskPath,
		});
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/path escapes/);
	});

	test("REJECTS a sessionId containing a path separator", async () => {
		// A traversal via sessionId itself (the diskPath is plausibly inside
		// "../other-session" if that were accepted as a session id).
		const res = await request(port, {
			sessionId: "../other-session",
			diskPath: join(TMP, "attachments", "other-session", "x"),
		});
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/invalid sessionId|path escapes/);
	});

	test("REJECTS an absolute Windows path diskPath", async () => {
		const res = await request(port, {
			sessionId: "sess-w",
			// eslint-disable-next-line no-useless-escape
			diskPath: "C:\\Windows\\System32\\drivers\\etc\\hosts",
		});
		expect(res.status).toBe(400);
		expect(res.data.error).toMatch(/path escapes|invalid sessionId/);
	});

	test("404 when the attachment file is gone (ENOENT)", async () => {
		// Save then delete on disk; the path still passes containment but the
		// file is missing → 404.
		const meta = await store.saveAttachment({
			sessionId: "sess-gone",
			fileName: "tmp.png",
			mimeType: "image/png",
			dataBase64: Buffer.from([1]).toString("base64"),
		});
		rmSync(meta.diskPath, { force: true });
		expect(existsSync(meta.diskPath)).toBe(false);

		const res = await request(port, {
			sessionId: "sess-gone",
			diskPath: meta.diskPath,
		});
		expect(res.status).toBe(404);
		expect(res.data.error).toMatch(/not found/);
	});

	test("400 on missing params (no sessionId / no diskPath)", async () => {
		const r1 = await request(port, { diskPath: "/tmp/x" });
		expect(r1.status).toBe(400);

		const r2 = await request(port, { sessionId: "s" });
		expect(r2.status).toBe(400);

		const r3 = await request(port, {});
		expect(r3.status).toBe(400);
	});

	test("serves a larger binary file (>500KB) — file-router would have refused", async () => {
		// 1 MB of pseudo-random-ish bytes. Proves the content endpoint has no
		// file-router-style size cap and handles binary transparently.
		const big = Buffer.alloc(1024 * 1024, 0xab);
		const meta = await store.saveAttachment({
			sessionId: "sess-big",
			fileName: "big.bin",
			mimeType: "application/octet-stream",
			dataBase64: big.toString("base64"),
		});

		const res = await request(port, {
			sessionId: "sess-big",
			diskPath: meta.diskPath,
		});
		expect(res.status).toBe(200);
		expect(res.data.size).toBe(big.length);
		expect(Buffer.from(res.data.data, "base64").equals(big)).toBe(true);
	});

	test("cannot read a file planted OUTSIDE the attachments root via a hand-crafted path", async () => {
		// Plant a sensitive file OUTSIDE the attachments dir.
		const secretPath = join(TMP, "leaked-secret.txt");
		writeFileSync(secretPath, "TOPSECRET");
		// Even though the file exists, requesting it under any session id is
		// rejected because its path doesn't resolve under that session's dir.
		const res = await request(port, {
			sessionId: "sess-leak",
			diskPath: secretPath,
		});
		expect(res.status).toBe(400);
		// The secret contents are never returned.
		expect(JSON.stringify(res.data)).not.toContain("TOPSECRET");
	});

	test("cannot read a file planted in a sibling session dir by faking the diskPath with ..", async () => {
		// Even if a caller knows another session's file structure and tries to
		// reach it via .., the containment check rejects it.
		mkdirSync(join(TMP, "attachments", "victim"), { recursive: true });
		const victimFile = join(TMP, "attachments", "victim", "id-private.png");
		writeFileSync(victimFile, Buffer.from([0xff]));

		// Construct a path that starts inside attacker's session dir but escapes.
		const attackerDir = join(TMP, "attachments", "attacker") + sep;
		const crafted = `${attackerDir}../victim/id-private.png`;

		const res = await request(port, {
			sessionId: "attacker",
			diskPath: crafted,
		});
		expect(res.status).toBe(400);
		expect(JSON.stringify(res.data)).not.toMatch(/private/);
	});
});
