// wiki-system-redesign pre-acceptance-final fix — directory-junction
// Write-create bypass (integrity-only).
//
// Context: result-08.md 「🔶 安全 follow-up」documents that
// `isProtectedPathRealpath` short-circuited to false when the leaf path did
// not exist, missing Write-create of a NEW file planted inside a directory
// junction into a protected root (wiki/, backups/core, backups/wiki). Existing
// files via junction were already blocked (realpathSync resolves the leaf);
// this is the create-new-file variant.
//
// Impact: integrity-only (plant fake wiki attachments / backup snapshot /
// manifest JSON), NOT confidentiality (reading core.db/wiki.db via junction
// was already blocked by round-2 Fix 2).
//
// This file pins the post-fix behavior:
//   - Write-create of a NEW file inside a directory junction into wiki/ is
//     BLOCKED (the parent-dir walk resolves the junction before the leaf
//     existence check).
//   - Write-create into backups/core and backups/wiki junctions is BLOCKED.
//   - Legit Write-create in the workspace (no junction) still passes.
//   - Confidentiality regression guard: reading an existing file via a
//     junction is still blocked (the round-2 Fix 2 path).

import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin ZERO_CORE_DIR before any wiki import resolves protected-paths.
const { UNIQUE_DIR } = (() => {
	const d = mkdtempSync(join(tmpdir(), "zc-path-guard-junction-create-"));
	process.env.ZERO_CORE_DIR = d;
	return { UNIQUE_DIR: d };
})();

import {
	WIKI_DISK_ROOT,
} from "../../src/core/protected-paths.js";
import {
	coreDbPath,
	wikiDbPath,
	coreBackupDir,
	wikiBackupDir,
	DB_DIR,
} from "../../src/core/database-paths.js";
import {
	isProtectedPathRealpath,
	isWikiDiskPath,
} from "../../src/tools/wiki-path-guard.js";

// Workspace temp dir that survives for the whole file. junctions live inside.
const WS = mkdtempSync(join(tmpdir(), "zc-path-guard-ws-"));

beforeAll(() => {
	// Materialize protected targets so junctions have something to point at.
	mkdirSync(DB_DIR, { recursive: true });
	if (!existsSync(coreDbPath)) writeFileSync(coreDbPath, "");
	if (!existsSync(wikiDbPath)) writeFileSync(wikiDbPath, "");
	mkdirSync(coreBackupDir, { recursive: true });
	mkdirSync(wikiBackupDir, { recursive: true });
	mkdirSync(WIKI_DISK_ROOT, { recursive: true });
});

afterAll(() => {
	try { rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
});

function makeJunction(target: string, linkPath: string): "ok" | "skipped" {
	try {
		const stat = statSync(target);
		const type = process.platform === "win32" && stat.isDirectory() ? "junction" : undefined;
		if (type) symlinkSync(target, linkPath, type);
		else symlinkSync(target, linkPath);
		return "ok";
	} catch (err) {
		if (/privilege|EPERM|ENOSYS/i.test(String((err as Error).message))) return "skipped";
		throw err;
	}
}

describe("[path-guard-junction-create] Write-create into directory junction — BLOCKED post-fix", () => {
	afterEach(() => {
		// Clean any junctions we created between tests.
		for (const entry of readdirSync(WS)) {
			try { rmSync(join(WS, entry), { recursive: true, force: true }); } catch { /* */ }
		}
	});

	function setupJunctionTo(target: string, linkName: string): string | null {
		const link = join(WS, linkName);
		if (makeJunction(target, link) === "skipped") return null;
		// Sanity: the junction really resolves into the protected target.
		const canon = (p: string) =>
			process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
		expect(canon(realpathSync(link)), "junction must resolve into protected target for test to be meaningful").toBe(canon(target));
		// And the LEXICAL guard alone must miss the junction (precondition
		// for the bypass to be real — the link path itself sits in workspace).
		expect(isWikiDiskPath(link, WS), "precondition: lexical guard must MISS the junction").toBe(false);
		return link;
	}

	test("Write-create of a NEW file inside a junction into WIKI_DISK_ROOT is BLOCKED", () => {
		const link = setupJunctionTo(WIKI_DISK_ROOT, "wiki-link");
		if (!link) return; // symlink not permitted on this host — skip gracefully.
		// The planted leaf does NOT exist — pre-fix the guard returned false.
		const leaf = join(link, "planted-attachment.md");
		expect(existsSync(leaf), "precondition: leaf must not exist (Write-create path)").toBe(false);
		// Post-fix: parent-dir walk resolves the junction before the existence
		// short-circuit, so the planted leaf is flagged.
		expect(
			isProtectedPathRealpath(leaf, WS),
			"Write-create via directory junction into wiki/ must be BLOCKED (integrity)",
		).toBe(true);
	});

	test("Write-create of a DEEPLY nested new file inside a wiki/ junction is BLOCKED", () => {
		const link = setupJunctionTo(WIKI_DISK_ROOT, "wiki-link-deep");
		if (!link) return;
		// Multi-segment non-existent suffix — proves the parent-dir walk
		// handles more than one missing path component.
		const leaf = join(link, "subdir", "another", "planted.md");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"Write-create of nested file via junction into wiki/ must be BLOCKED",
		).toBe(true);
	});

	test("Write-create inside a junction into backups/core is BLOCKED (fake snapshot)", () => {
		const link = setupJunctionTo(coreBackupDir, "core-backup-link");
		if (!link) return;
		const leaf = join(link, "core-2099-01-01.db");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"Write-create via junction into backups/core must be BLOCKED (integrity)",
		).toBe(true);
	});

	test("Write-create inside a junction into backups/wiki is BLOCKED (fake snapshot)", () => {
		const link = setupJunctionTo(wikiBackupDir, "wiki-backup-link");
		if (!link) return;
		const leaf = join(link, "wiki-2099-01-01.db");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"Write-create via junction into backups/wiki must be BLOCKED (integrity)",
		).toBe(true);
	});

	test("Write-create of a sidecar manifest JSON next to a (fictional) backup is BLOCKED via junction", () => {
		// The integrity concern in result-08.md calls out fake manifest JSON
		// as one of the planted payloads. Pin that the .json extension is
		// not exempted by the parent-dir walk.
		const link = setupJunctionTo(wikiBackupDir, "wiki-backup-link-json");
		if (!link) return;
		const leaf = join(link, "wiki-2099-01-01.db.json");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"Write-create of manifest JSON via junction into backups/wiki must be BLOCKED",
		).toBe(true);
	});
});

describe("[path-guard-junction-create] legitimate Write-create is NOT blocked (no false positive)", () => {
	afterEach(() => {
		for (const entry of readdirSync(WS)) {
			try { rmSync(join(WS, entry), { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("Write-create of a new file directly in the workspace passes", () => {
		const leaf = join(WS, "brand-new-module.ts");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"legit Write-create in workspace must NOT be blocked",
		).toBe(false);
	});

	test("Write-create of a deeply nested new file in the workspace passes", () => {
		const leaf = join(WS, "packages", "p1", "src", "deep", "new.ts");
		expect(existsSync(leaf)).toBe(false);
		expect(
			isProtectedPathRealpath(leaf, WS),
			"legit deep Write-create in workspace must NOT be blocked",
		).toBe(false);
	});

	test("Write-create through a junction into a NON-protected temp dir passes", () => {
		// Legitimate scenario: user symlinks an external project dir into the
		// workspace and creates a new file through the link. The realpath
		// stays in the external temp dir → must not be flagged.
		const external = mkdtempSync(join(tmpdir(), "zc-external-proj-"));
		try {
			const link = join(WS, "linked-external");
			const status = makeJunction(external, link);
			if (status === "skipped") return;
			const leaf = join(link, "freshly-created.ts");
			expect(existsSync(leaf)).toBe(false);
			expect(
				isProtectedPathRealpath(leaf, WS),
				"Write-create via junction into a non-protected dir must NOT be blocked",
			).toBe(false);
		} finally {
			try { rmSync(external, { recursive: true, force: true }); } catch { /* */ }
		}
	});
});

describe("[path-guard-junction-create] confidentiality regression guard (round-2 Fix 2 still holds)", () => {
	afterEach(() => {
		for (const entry of readdirSync(WS)) {
			try { rmSync(join(WS, entry), { recursive: true, force: true }); } catch { /* */ }
		}
	});

	test("Read of an EXISTING file via a directory junction into WIKI_DISK_ROOT is BLOCKED", () => {
		// Pre-create a leaf inside the protected root so the junction can
		// resolve to an existing file through it.
		const leafInWiki = join(WIKI_DISK_ROOT, "existing-leaf.md");
		writeFileSync(leafInWiki, "wiki body");
		try {
			const link = join(WS, "wiki-link-existing");
			if (makeJunction(WIKI_DISK_ROOT, link) === "skipped") return;
			const leaf = join(link, "existing-leaf.md");
			expect(existsSync(leaf), "precondition: leaf exists through junction").toBe(true);
			expect(
				isProtectedPathRealpath(leaf, WS),
				"Read of existing file via junction into wiki/ must remain BLOCKED",
			).toBe(true);
		} finally {
			try { rmSync(leafInWiki, { force: true }); } catch { /* */ }
		}
	});
});
