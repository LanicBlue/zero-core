// Verifier tests for effort `tool-quality-pass` sub-1.
// Independent, adversarial verification of acceptance-1.md:
//   #5 single-file grep (native fallback) + #6 truncation hint.
//
// Strategy: drive `nativeGrepSearch` (exported pure fn) directly for #5/#6,
// and mock `node:child_process.execFile` to exercise the rg path for #3/#10.
// No reliance on implementer's claims — only on assertions run here.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeGrepSearch, grepTool } from "../../src/tools/grep.js";

// --- rg path mocking (for #3 and #10): hoisted so it's ready before module load.
// Critical: the real node:child_process.execFile carries a [util.promisify.custom]
// symbol that resolves to {stdout, stderr}. A bare vi.fn() lacks it, so the default
// promisify returns just the first cb arg (a string), and `const {stdout}` becomes
// undefined. We mirror Node's contract so `promisify(execFile)` behaves identically.
// Note: vi.hoisted runs BEFORE module-scope initializers, so everything it needs
// (the symbol) must be created inside the callback — not as an outer const.
const { execFileMock } = vi.hoisted(() => {
	const fn: any = vi.fn();
	const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");
	fn[PROMISIFY_CUSTOM] = (file: string, args: string[], opts: any) =>
		new Promise((resolve, reject) => {
			fn(file, args, opts, (err: any, stdout: string, stderr: string) => {
				if (err) reject(err);
				else resolve({ stdout, stderr });
			});
		});
	return { execFileMock: fn };
});
vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

// --- fixtures ---
let root: string;
let singleFile: string;       // #5 single file (has "ZERO" + "zero")
let noMatchFile: string;      // #5.6 single file no match
let manyMatchesFile: string;  // #6 truncation: 30 matches
let exactLimitFile: string;   // #6.9 boundary: exactly head_limit matches
let overByOneFile: string;    // #6.9 boundary: head_limit + 1 matches

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zc-grep-qual-"));

	singleFile = join(root, "single.ts");
	writeFileSync(singleFile, "const ZERO = 1;\nexport { zero };\n// nothing here\n");

	noMatchFile = join(root, "nomatch.ts");
	writeFileSync(noMatchFile, "alpha\nbeta\ngamma\n");

	manyMatchesFile = join(root, "many.ts");
	{
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) lines.push("match line " + i);
		writeFileSync(manyMatchesFile, lines.join("\n") + "\n");
	}

	exactLimitFile = join(root, "exact.ts");
	writeFileSync(exactLimitFile, ["hit a", "hit b", "hit c", "hit d", "hit e"].join("\n") + "\n");

	overByOneFile = join(root, "over.ts");
	writeFileSync(overByOneFile, ["hit a", "hit b", "hit c", "hit d", "hit e", "hit f"].join("\n") + "\n");

	// Directory fixture for #5.5 (dir regression) + #5.6 (dir no-match)
	mkdirSync(join(root, "sub"), { recursive: true });
	writeFileSync(join(root, "dir_a.ts"), "const ZERO = 1;\n");
	writeFileSync(join(root, "sub", "dir_b.ts"), "export { zero };\n");
});

afterAll(() => {
	try { rmSync(root, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
	execFileMock.mockReset();
});

// ============================================================================
// #5 single-file (native fallback)
// ============================================================================

describe("#5.1 single file content mode returns matches", () => {
	it("returns matching line, non-empty, not 'No matches found.'", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZERO", searchPath: singleFile, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).not.toBe("No matches found.");
		expect(out.length).toBeGreaterThan(0);
		expect(out).toContain("ZERO");
	});

	it("all three output modes return non-empty for a matching file", async () => {
		for (const mode of ["content", "files_with_matches", "count"] as const) {
			const out = await nativeGrepSearch({
				pattern: "zero", searchPath: singleFile, output_mode: mode,
				caseInsensitive: true, head_limit: 50, max_columns: 500,
			});
			expect(out).not.toBe("No matches found.");
			expect(out.length).toBeGreaterThan(0);
		}
	});
});

describe("#5.2 single file files_with_matches / count modes", () => {
	it("files_with_matches returns the file basename (single.ts)", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZERO", searchPath: singleFile, output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("single.ts");
	});

	it("count mode reports the per-file match count for the single file", async () => {
		// "zero" with -i matches both "ZERO" (line 1) and "zero" (line 2) → 2
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: singleFile, output_mode: "count",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("single.ts:2");
	});
});

describe("#5.4 relPath is basename", () => {
	it("content output path segment is basename (single.ts:1:), not full path or empty", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZERO", searchPath: singleFile, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("single.ts:1:");
		// Must NOT leak the absolute path (root) or a Windows drive prefix.
		expect(out).not.toContain(root);
		expect(out).not.toMatch(/^[A-Z]:\\/);
		// No empty relPath segment like ":1:" at the start of a line.
		expect(out).not.toMatch(/\n:1:/);
	});

	it("files_with_matches output is exactly the basename (no directory part)", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZERO", searchPath: singleFile, output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("single.ts");
		expect(out).not.toContain("\\");
		expect(out).not.toContain("/");
	});
});

describe("#5.5 directory search does not regress (walkFiles recursion)", () => {
	it("walks directory and matches across nested files (-i)", async () => {
		const out = await nativeGrepSearch({
			pattern: "zero", searchPath: root, output_mode: "files_with_matches",
			caseInsensitive: true, head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("dir_a.ts");
		expect(out).toContain("dir_b.ts");
		expect(out).toContain("single.ts");
	});

	it("directory content mode returns relative paths", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZERO", searchPath: root, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toContain("dir_a.ts:");
		expect(out).toContain("single.ts:");
	});
});

describe("#5.6 no match still returns 'No matches found.'", () => {
	it("single file, no match → 'No matches found.'", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZZZ definitely not present", searchPath: singleFile, output_mode: "content",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("No matches found.");
	});

	it("single file, files_with_matches mode, no match → 'No matches found.'", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZZZ definitely not present", searchPath: singleFile, output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("No matches found.");
	});

	it("directory, no match → 'No matches found.'", async () => {
		const out = await nativeGrepSearch({
			pattern: "ZZZ definitely not present", searchPath: root, output_mode: "files_with_matches",
			head_limit: 50, max_columns: 500,
		});
		expect(out).toBe("No matches found.");
	});
});

// ============================================================================
// #6 truncation hint (native fallback content mode)
// ============================================================================

describe("#6.7 native fallback content truncation emits hint", () => {
	it("30 matches, head_limit=10 → ends with '... (20 more matches truncated, refine your pattern)'", async () => {
		const out = await nativeGrepSearch({
			pattern: "match", searchPath: manyMatchesFile, output_mode: "content",
			head_limit: 10, max_columns: 500,
		});
		expect(out).toContain("... (20 more matches truncated, refine your pattern)");
	});
});

describe("#6.8 truncation N reflects real total (no early-stop counting)", () => {
	it("N = real total (30) - shown (10) = 20, not 0 or a partial count", async () => {
		const out = await nativeGrepSearch({
			pattern: "match", searchPath: manyMatchesFile, output_mode: "content",
			head_limit: 10, max_columns: 500,
		});
		// Exact-match the hint; an early-stop-counting impl would emit "0 more"
		// or omit the hint entirely. (We use the literal string rather than
		// not.toContain("0 more...") because "20 more" is a substring super-set.)
		expect(out).toContain("... (20 more matches truncated, refine your pattern)");
		// And the body must contain exactly the first 10 shown lines (not fewer).
		const bodyLines = out.split("\n").filter((l) => l.startsWith("many.ts:"));
		expect(bodyLines.length).toBe(10);
	});

	it("head_limit=5 → '... (25 more ...)' proves counting continued past 5", async () => {
		const out = await nativeGrepSearch({
			pattern: "match", searchPath: manyMatchesFile, output_mode: "content",
			head_limit: 5, max_columns: 500,
		});
		expect(out).toContain("... (25 more matches truncated, refine your pattern)");
	});
});

describe("#6.9 no truncation hint when matches <= head_limit", () => {
	it("5 matches, head_limit=10 → no hint", async () => {
		const out = await nativeGrepSearch({
			pattern: "hit", searchPath: exactLimitFile, output_mode: "content",
			head_limit: 10, max_columns: 500,
		});
		expect(out).not.toContain("truncated");
		expect(out).not.toContain("refine your pattern");
	});

	it("exactly head_limit matches (5 == 5) → no hint (boundary)", async () => {
		const out = await nativeGrepSearch({
			pattern: "hit", searchPath: exactLimitFile, output_mode: "content",
			head_limit: 5, max_columns: 500,
		});
		expect(out).not.toContain("truncated");
	});

	it("one over the boundary (6 vs head_limit=5) → hint says '1 more'", async () => {
		const out = await nativeGrepSearch({
			pattern: "hit", searchPath: overByOneFile, output_mode: "content",
			head_limit: 5, max_columns: 500,
		});
		expect(out).toContain("... (1 more matches truncated, refine your pattern)");
	});
});

// ============================================================================
// #3 + #10: rg path (mocked execFile) — single-file + truncation hint regression
//
// We exercise the rg path by mocking `node:child_process.execFile` and invoking
// the tool's RAW execute (grepTool.__execute — the unwrapped function inside
// buildTool). The wrapped `grepTool.execute` would run the full host pipeline
// (hooks / rate-limit / experimental_context plumbing) which is orthogonal to
// what these two acceptance items verify (rg path behavior under a file input
// and the rg-specific truncation hint). __execute takes (input, callerCtx) and
// returns a ToolResult — the cleanest seam.
// ============================================================================

describe("#3 rg path: single-file search returns matches (no regression)", () => {
	it("execute routes single file through rg and returns matches", async () => {
		execFileMock.mockImplementation((_file, _args, _opts, cb) => {
			cb(null, "single.ts:1:const ZERO = 1;\n", "");
		});
		const result = await (grepTool as any).__execute(
			{ pattern: "ZERO", path: singleFile, output_mode: "content" },
			{ caller: "ui", workingDir: root, toolConfig: {} },
		);
		const text = (result.data as any)?.text;
		expect(text).toContain("ZERO");
		expect(text).not.toBe("No matches found.");
		expect(execFileMock).toHaveBeenCalled();
		// Adversarial: confirm the file path is what rg received as the searchPath
		// (last positional arg), proving execute didn't mangle single-file routing.
		const callArgs = execFileMock.mock.calls[0];
		const passedArgs = callArgs[1] as string[];
		const lastArg = passedArgs[passedArgs.length - 1];
		expect(lastArg).toBe(singleFile);
	});
});

describe("#10 rg path: keeps original '... (truncated, N total matches)' hint", () => {
	it("rg returning > head_limit lines → '... (truncated, N total matches)' (rg wording, not native)", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `f.ts:${i + 1}:match${i}`);
		execFileMock.mockImplementation((_file, _args, _opts, cb) => {
			cb(null, lines.join("\n") + "\n", "");
		});
		const result = await (grepTool as any).__execute(
			{ pattern: "match", path: singleFile, output_mode: "content", head_limit: 10 },
			{ caller: "ui", workingDir: root, toolConfig: {} },
		);
		const text = (result.data as any)?.text;
		expect(text).toContain("... (truncated,");
		expect(text).toContain("total matches)");
		// rg path must NOT use the native "more matches truncated, refine" wording.
		expect(text).not.toContain("refine your pattern");
		expect(text).not.toContain("more matches truncated");
	});
});
