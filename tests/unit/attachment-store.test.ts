// Unit tests for attachment-store (effort: multimodal-input, sub-1).
//
// Covers: save → read round-trip; kind inference; per-session dir layout;
// cleanSessionAttachments; and PATH SAFETY (traversal / absolute / null-byte /
// sessionId-with-separator attacks must all be neutralized).
//
// The store roots writes at ATTACHMENTS_ROOT = resolve(ZERO_CORE_DIR/attachments),
// captured at module load (ZERO_CORE_DIR reads process.env.ZERO_CORE_DIR once
// when config.ts is first imported). So we: create ONE temp dir per file,
// set ZERO_CORE_DIR, reset the module registry, THEN import the store — so the
// whole file shares one stable ATTACHMENTS_ROOT pointing at the temp dir.
//

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, test, vi } from "vitest";

let TMP = "";
let store: typeof import("../../src/server/attachment-store.js");

beforeAll(async () => {
	TMP = mkdtempSync(join(tmpdir(), "zero-attach-"));
	process.env.ZERO_CORE_DIR = TMP;
	// Bust the module cache so config.ts re-reads ZERO_CORE_DIR (→ TMP) and the
	// store's ATTACHMENTS_ROOT resolves under TMP for every test in this file.
	vi.resetModules();
	store = await import("../../src/server/attachment-store.js");
});

afterAll(() => {
	delete process.env.ZERO_CORE_DIR;
	if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("attachment-store", () => {
	test("save → read round-trip; kind inferred from mimeType; per-session dir layout", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG-ish header
		const meta = await store.saveAttachment({
			sessionId: "sess-1",
			fileName: "photo.png",
			mimeType: "image/png",
			dataBase64: bytes.toString("base64"),
		});

		expect(meta.id).toBeTruthy();
		expect(meta.kind).toBe("image");
		expect(meta.fileName).toBe("photo.png");
		expect(meta.mimeType).toBe("image/png");
		expect(meta.size).toBe(bytes.length);
		// diskPath lives under TMP/<attachments>/<sess-1>/ and the filename is
		// prefixed with the id.
		expect(meta.diskPath).toContain(join("attachments", "sess-1"));
		expect(meta.diskPath.endsWith(`-${meta.fileName}`)).toBe(true);

		// File actually exists at diskPath.
		expect(existsSync(meta.diskPath)).toBe(true);

		// Read returns the same bytes.
		const readBack = await store.readAttachment("sess-1", meta.diskPath);
		expect(Buffer.from(readBack).equals(bytes)).toBe(true);
	});

	test("kind inference: pdf and arbitrary file", async () => {
		const pdf = await store.saveAttachment({
			sessionId: "s", fileName: "doc.pdf", mimeType: "application/pdf",
			dataBase64: Buffer.from("%PDF-1.4").toString("base64"),
		});
		expect(pdf.kind).toBe("pdf");

		const txt = await store.saveAttachment({
			sessionId: "s", fileName: "notes.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("hi").toString("base64"),
		});
		expect(txt.kind).toBe("file");

		// Unknown mime → file; case-insensitive image prefix.
		const unk = await store.saveAttachment({
			sessionId: "s", fileName: "x", mimeType: "application/octet-stream",
			dataBase64: Buffer.from([1]).toString("base64"),
		});
		expect(unk.kind).toBe("file");

		const imgCaps = await store.saveAttachment({
			sessionId: "s", fileName: "y", mimeType: "IMAGE/JPEG",
			dataBase64: Buffer.from([1]).toString("base64"),
		});
		expect(imgCaps.kind).toBe("image");
	});

	test("cleanSessionAttachments removes the per-session dir (and is a no-op when absent)", async () => {
		await store.saveAttachment({
			sessionId: "s-clean", fileName: "a.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("a").toString("base64"),
		});
		await store.saveAttachment({
			sessionId: "s-clean", fileName: "b.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("b").toString("base64"),
		});
		const sessionDir = join(TMP, "attachments", "s-clean");
		expect(existsSync(sessionDir)).toBe(true);
		expect(readdirSync(sessionDir).length).toBe(2);

		const removed = await store.cleanSessionAttachments("s-clean");
		expect(removed).toBe(1);
		expect(existsSync(sessionDir)).toBe(false);

		// No-op when already gone.
		const again = await store.cleanSessionAttachments("s-clean");
		expect(again).toBe(0);
	});

	// ── PATH SAFETY (the load-bearing part) ──────────────────────────

	test("REJECTS fileName traversal via ../ — saved as basename only", async () => {
		// A bare ../ escape attempt. basename collapses it; the saved file lands
		// inside the session dir, NOT in the attachments root or above.
		const meta = await store.saveAttachment({
			sessionId: "s-safe",
			fileName: "../../../../etc/evil.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		});
		// Final segment only; resolves inside the session dir.
		expect(meta.fileName).toBe("evil.txt");
		expect(meta.diskPath.startsWith(join(TMP, "attachments", "s-safe") + sep)).toBe(true);
		expect(existsSync(meta.diskPath)).toBe(true);
		// Nothing escaped to TMP root or siblings.
		expect(existsSync(join(TMP, "evil.txt"))).toBe(false);
		expect(existsSync(join(TMP, "etc", "evil.txt"))).toBe(false);
	});

	test("REJECTS absolute Windows path fileName (saved as basename)", async () => {
		const meta = await store.saveAttachment({
			sessionId: "s-abs",
			fileName: "C:\\Windows\\System32\\evil.dll",
			mimeType: "application/octet-stream",
			dataBase64: Buffer.from([0]).toString("base64"),
		});
		expect(meta.fileName).toBe("evil.dll");
		// Lands inside the session dir.
		expect(meta.diskPath.startsWith(join(TMP, "attachments", "s-abs") + sep)).toBe(true);
	});

	test("REJECTS unix absolute path fileName (saved as basename)", async () => {
		const meta = await store.saveAttachment({
			sessionId: "s-uabs",
			fileName: "/etc/passwd",
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		});
		expect(meta.fileName).toBe("passwd");
		expect(meta.diskPath.startsWith(join(TMP, "attachments", "s-uabs") + sep)).toBe(true);
	});

	test("REJECTS null-byte injection in fileName", async () => {
		// A null byte in the name would truncate to "foo" on some APIs; we reject
		// the control char outright. Built via String.fromCharCode so the test
		// source stays clean (a literal NUL would confuse tsc/vitest).
		const NUL = String.fromCharCode(0);
		await expect(store.saveAttachment({
			sessionId: "s-null",
			fileName: `foo${NUL}../../escape.txt`,
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);

		// Even a clean basename with an embedded null is rejected.
		await expect(store.saveAttachment({
			sessionId: "s-null",
			fileName: `clean${NUL}.txt`,
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);
	});

	test("REJECTS sessionId containing a path separator", async () => {
		await expect(store.saveAttachment({
			sessionId: "../other-session",
			fileName: "ok.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid sessionId/);

		// Backslash variant (Windows-style).
		await expect(store.saveAttachment({
			sessionId: "..\\other-session",
			fileName: "ok.txt",
			mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid sessionId/);

		// `.` and `..` as sessionId are rejected.
		await expect(store.saveAttachment({
			sessionId: "..",
			fileName: "ok.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid sessionId/);
	});

	test("readAttachment rejects a diskPath that escapes the session dir", async () => {
		// Even if a caller hand-crafts a diskPath, readAttachment re-validates
		// containment and throws. The check uses a canonical `dir/` prefix so a
		// sibling like "s-prefix" can't masquerade as "s".
		await expect(store.readAttachment("s-real", join(TMP, "attachments", "s-other", "x.txt")))
			.rejects.toThrow(/path escapes/);

		// A path outside attachments entirely is also rejected.
		await expect(store.readAttachment("s-real", join(TMP, "secret.txt")))
			.rejects.toThrow(/path escapes/);
	});

	test("REJECTS empty / traversal-only fileName", async () => {
		await expect(store.saveAttachment({
			sessionId: "s", fileName: "", mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);

		await expect(store.saveAttachment({
			sessionId: "s", fileName: "../", mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);
	});

	test("REJECTS Windows reserved device names (CON, NUL, …)", async () => {
		await expect(store.saveAttachment({
			sessionId: "s", fileName: "CON", mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);

		await expect(store.saveAttachment({
			sessionId: "s", fileName: "NUL.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("x").toString("base64"),
		})).rejects.toThrow(/invalid fileName/);
	});

	test("uuid prefix dedupes identical filenames (flag 'wx' prevents overwrite)", async () => {
		// Two saves of the same filename get distinct uuids → distinct paths,
		// both succeed. This is the dedup guarantee (no overwrite via flag 'wx').
		const a = await store.saveAttachment({
			sessionId: "s-dedup", fileName: "same.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("a").toString("base64"),
		});
		const b = await store.saveAttachment({
			sessionId: "s-dedup", fileName: "same.txt", mimeType: "text/plain",
			dataBase64: Buffer.from("b").toString("base64"),
		});
		expect(a.id).not.toBe(b.id);
		expect(a.diskPath).not.toBe(b.diskPath);
		// Both files persist independently.
		expect((await store.readAttachment("s-dedup", a.diskPath)).toString()).toBe("a");
		expect((await store.readAttachment("s-dedup", b.diskPath)).toString()).toBe("b");
	});
});
