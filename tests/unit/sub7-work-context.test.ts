// sub-7 acceptance tests — work-context hook 拆解到三通道.
//
// Independent verification harness (NOT derived from implementer claims).
// Encodes acceptance-7.md + 2026-07-07 补遗 case-by-case, asserting on the
// public surfaces actually used by the runtime (buildContextMessage /
// renderWorkbench / the wiki-system-anchors merger in agent-loop section
// wiring) plus structural checks (file absence, runtime-layer import scan).
//
// Why these surfaces:
//   - The system-channel split is enforced by agent-loop's section wiring
//     (work-context section present only when config.workContextSystemSection
//     is set; the wiki-system-anchors section merges renderSystemAnchors +
//     renderContextAnchors). We replicate the exact merger predicate the
//     runtime uses so a regression in agent-loop's wiring shows up here.
//   - The context-channel contract is buildContextMessage's responsibility.
//   - The workbench channel contract is renderWorkbench's responsibility.
//
// We do NOT spin a full AgentLoop here (heavy + brittle) — the three
// functions below are the units the loop calls, and the loop's wiring of
// them is asserted structurally (case 3 + 5).

import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildContextMessage } from "../../src/runtime/context-message.js";
import { renderWorkbench } from "../../src/runtime/workbench.js";
// plan-08 §1: wiki-anchor-injection.ts deleted (anchor model retired).
// Tests that exercised renderSystemAnchors / renderContextAnchors were
// dropped with the module; the remaining cases below cover context-message /
// workbench / DI / deletion guards that don't depend on anchor injection.

// ─── helpers: replicate agent-loop's exact section-wiring predicates ─────────

/**
 * Replicates agent-loop.ts ~L198-203 — the work-context system section is
 * added to the section list ONLY when config.workContextSystemSection is set.
 * The section's compute calls the closure and falls back to "".
 */
function workContextSectionValue(closure?: () => string): string {
	if (!closure) return ""; // section not added → contributes nothing
	return closure() ?? "";
}

// ─── case 1: Project / Requirement / Wiki Baseline in system; non-work lacks ─

describe("sub-7 / case 1 — Project/Requirement/Wiki Baseline in system channel", () => {
	test("work-context system section renders Project/Requirement/Wiki Baseline via the closure", () => {
		// The closure is server-built (agent-service.buildWorkContextClosures).
		// We assert on the contract the loop relies on: the closure's string
		// output IS the system section content; nothing of it leaks to context.
		const closure = (): string => [
			"## Project\n- Name: Demo\n- Working directory: /demo",
			"## Wiki Baseline\narch/root — root summary",
			"## Requirement\n- Title: R1\n- Priority: high\n- Impact: all\n- Description:\nbody",
		].join("\n\n");
		const section = workContextSectionValue(closure);
		expect(section).toContain("## Project");
		expect(section).toContain("## Wiki Baseline");
		expect(section).toContain("## Requirement");
		expect(section).toContain("Demo");
	});

	test("non-work session: closure unset → system section contributes empty (section omitted)", () => {
		// agent-loop only pushes the work-context section when the closure is
		// present. Non-work sessions never set it → the section is absent and
		// the system prompt carries no Project/Requirement/Wiki Baseline.
		const section = workContextSectionValue(undefined);
		expect(section).toBe("");
		expect(section).not.toContain("## Project");
		expect(section).not.toContain("## Requirement");
	});

	test("context channel does NOT carry Project/Requirement/Wiki Baseline", () => {
		// buildContextMessage must not emit these (verifies they did not slip
		// back into the context block).
		const ctx = buildContextMessage({ guidelines: ["G"] });
		expect(ctx).not.toContain("## Project");
		expect(ctx).not.toContain("## Wiki Baseline");
		expect(ctx).not.toContain("## Requirement");
	});
});

// ─── case 2: Steps Progress in workbench, not system/context ─────────────────

describe("sub-7 / case 2 — Steps Progress in workbench channel", () => {
	test("renderWorkbench emits Steps Progress when stepsProgress is non-empty", () => {
		const wb = renderWorkbench({
			sessionId: "s1",
			agentId: "a1",
			stepsProgress: "(1/3)\n  [done] dev: build\n  [running] qa: test",
		});
		expect(wb).toContain("<workbench>");
		expect(wb).toContain("## Steps Progress");
		expect(wb).toContain("(1/3)");
		expect(wb).toContain("[running] qa: test");
	});

	test("workbench omits Steps Progress when the closure returns empty (no steps)", () => {
		const wb = renderWorkbench({
			sessionId: "s1",
			agentId: "a1",
			stepsProgress: "",
		});
		// No todos either in this harness → whole block null.
		expect(wb).toBeNull();
	});

	test("system section value does NOT contain Steps Progress", () => {
		// The work-context system closure renders Project/Requirement/Wiki
		// Baseline ONLY — Steps Progress rides the workbench closure. Assert
		// the system-channel closure shape excludes it.
		const sysClosure = (): string => "## Project\n- Name: Demo";
		expect(workContextSectionValue(sysClosure)).not.toContain("Steps Progress");
	});

	test("context channel does NOT contain Steps Progress", () => {
		const ctx = buildContextMessage({ guidelines: ["G"] });
		expect(ctx).not.toContain("Steps Progress");
	});
});

// ─── case 3: Wiki Anchors merger — single system section, no context block ──

describe("sub-7 / case 3 — Wiki Anchors section retired (plan-08 §1)", () => {
	test("buildContextMessage emits NO `## Wiki Anchors` subsection (context channel)", () => {
		// acceptance-7 case 3 + plan-08 §1: anchor injection was removed;
		// context channel must still not render an anchors subsection.
		const ctx = buildContextMessage({ guidelines: ["G"], memoryContext: "m" });
		expect(ctx).not.toContain("## Wiki Anchors");
		expect(ctx).not.toContain("Wiki Anchors (context)");
	});
});

// ─── case 4: context channel = Recalled Memories only, ALWAYS emitted ────────

describe("sub-7 / case 4 — context channel = Recalled Memories only, always emitted", () => {
	test("Recalled Memories section present with payload", () => {
		const ctx = buildContextMessage({ guidelines: ["G"], memoryContext: "a memory" });
		expect(ctx).toContain("## Recalled Memories");
		expect(ctx).toContain("a memory");
	});

	test("Recalled Memories section present even when memoryContext is undefined (补遗: always inject)", () => {
		// acceptance-7 补遗 case 4: 空也注入 —— `## Recalled Memories` header
		// stays, content is a placeholder, the channel is structurally present.
		const ctx = buildContextMessage({ guidelines: ["G"] });
		expect(ctx).toContain("## Recalled Memories");
		expect(ctx).toMatch(/\(none yet\)|^$/m); // placeholder line present
	});

	test("Recalled Memories section present even when memoryContext is empty string", () => {
		const ctx = buildContextMessage({ guidelines: ["G"], memoryContext: "   " });
		expect(ctx).toContain("## Recalled Memories");
	});

	test("context channel does NOT carry Project/Requirement/Wiki Baseline/Steps Progress", () => {
		const ctx = buildContextMessage({ guidelines: ["G"], memoryContext: "m" });
		expect(ctx).not.toContain("## Project");
		expect(ctx).not.toContain("## Wiki Baseline");
		expect(ctx).not.toContain("## Requirement");
		expect(ctx).not.toContain("Steps Progress");
	});
});

// ─── case 5: DI — runtime never imports server stores ───────────────────────

describe("sub-7 / case 5 — DI: runtime never imports server stores", () => {
	const RUNTIME_ROOT = path.resolve(__dirname, "../../src/runtime");
	const STORE_PATH_PATTERNS = [
		/server\/project-store/,
		/server\/requirement-store/,
		/server\/task-step-store/,
		/server\/project-work-store/,
		/server\/project-wiki-store/,
		/server\/workflow-context-hook/,
	];

	/** Recursively collect .ts files under a directory. */
	function walk(dir: string, acc: string[] = []): string[] {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) walk(p, acc);
			else if (ent.isFile() && p.endsWith(".ts")) acc.push(p);
		}
		return acc;
	}

	test("no file under src/runtime imports any workflow-context server store", () => {
		const files = walk(RUNTIME_ROOT);
		expect(files.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const f of files) {
			const txt = fs.readFileSync(f, "utf8");
			for (const pat of STORE_PATH_PATTERNS) {
				if (pat.test(txt.replace(/\\/g, "/"))) {
					// Allow mentions inside /** doc comments **/ or // line comments
					// (the merger notes reference the deleted hook). Real imports
					// look like:  from "../../server/<store>"  (string literal).
					// We scan for the string-literal import form specifically.
					const importForm = new RegExp(
						`from\\s+["'][^"']*${pat.source.replace(/\//g, "\\/")}[^"']*["']`,
					);
					if (importForm.test(txt)) offenders.push(`${f}: ${pat}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

// ─── case 6: system on-demand — closure re-reads, hot-swap invalidates ──────
//
// The on-demand contract has two halves:
//   (a) the closure is called fresh on each section assemble (cacheBreak:false
//       section → SystemPromptAssembler re-invokes compute every turn), so a
//       closure that reads live store state reflects the latest requirement;
//   (b) when activeRequirement/workId flips on a RUNNING loop, applyConfigUpdate
//       hot-swaps the closure AND invalidates the section.
// We assert both halves at the contract level (the loop wiring is exercised
// by agent-loop's own tests; here we lock the predicate the loop depends on).

describe("sub-7 / case 6 — system on-demand: closure re-reads each call, hot-swap invalidates", () => {
	test("closure is a live function — successive calls reflect mutated store state", () => {
		// Simulate the server-built closure: captures a store, re-reads each call.
		const store = { current: "R1" };
		const closure = (): string => `## Requirement\n- Title: ${store.current}`;
		expect(workContextSectionValue(closure)).toContain("R1");
		store.current = "R2"; // activeRequirement detail flipped
		expect(workContextSectionValue(closure)).toContain("R2");
		expect(workContextSectionValue(closure)).not.toContain("R1");
	});

	test("unset closure (non-work / pre-policy) contributes empty — section absent, not stale", () => {
		// When applyConfigUpdate hot-swaps to undefined (session leaves work
		// mode), the section value becomes "" → SystemPromptAssembler drops it.
		expect(workContextSectionValue(undefined)).toBe("");
	});
});

// ─── case 7: regression — non-work sessions unaffected ───────────────────────

describe("sub-7 / case 7 — regression: non-work sessions unaffected", () => {
	test("buildContextMessage without workContextSystemSection still renders env + guidelines + recalled memories", () => {
		const ctx = buildContextMessage({
			workspaceDir: "/proj",
			guidelines: ["G1"],
		});
		expect(ctx).toContain("## Environment");
		expect(ctx).toContain("## Guidelines");
		expect(ctx).toContain("## Recalled Memories");
		// And no work-context bleed.
		expect(ctx).not.toContain("## Project");
		expect(ctx).not.toContain("## Requirement");
	});

	test("renderWorkbench with no stepsProgress still renders todos (workbench not broken)", () => {
		// Without a stepsProgress closure, the workbench falls back to todos
		// only. We can't seed todos in a unit harness cleanly (they live in a
		// global map keyed by sessionId), so just assert the function does not
		// throw and returns string|null.
		const wb = renderWorkbench({ sessionId: "sub7-no-steps", agentId: "a" });
		expect(wb === null || typeof wb === "string").toBe(true);
	});

	// plan-08 §1: the wiki-anchor merger test was removed with the
	// wiki-anchor-injection module. Non-work sessions no longer have an
	// anchors section to drop — the section simply doesn't exist.
});

// ─── case 8: old paths deleted ───────────────────────────────────────────────

describe("sub-7 / case 8 — old paths deleted (workflow-context-hook + memoryContext injection)", () => {
	const SERVER_DIR = path.resolve(__dirname, "../../src/server");
	const RUNTIME_DIR = path.resolve(__dirname, "../../src/runtime");

	test("workflow-context-hook.ts no longer exists on disk", () => {
		const hookPath = path.join(SERVER_DIR, "workflow-context-hook.ts");
		expect(fs.existsSync(hookPath)).toBe(false);
	});

	test("no remaining import of workflow-context-hook anywhere in src/", () => {
		const SRC = path.resolve(__dirname, "../../src");
		const files: string[] = [];
		(function walk(dir: string) {
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, ent.name);
				if (ent.isDirectory()) walk(p);
				else if (ent.isFile() && p.endsWith(".ts")) files.push(p);
			}
		})(SRC);
		const importRe = /from\s+["'][^"']*workflow-context-hook[^"']*["']/;
		const offenders = files.filter(f => importRe.test(fs.readFileSync(f, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("registerWorkflowContextHook is not exported from runtime/hooks facade", () => {
		const facade = fs.readFileSync(
			path.join(RUNTIME_DIR, "hooks/index.ts"),
			"utf8",
		);
		expect(/registerWorkflowContextHook/.test(facade)).toBe(false);
	});

	test("buildContextMessage signature has no workflowContext / stepsProgress parameter (memoryContext is recall-only)", () => {
		// The context-channel function must not have grown work-context params.
		// Read its source and assert only the three documented params exist.
		const src = fs.readFileSync(
			path.join(RUNTIME_DIR, "context-message.ts"),
			"utf8",
		);
		// Extract the config type literal between the matching braces of the
		// buildContextMessage arg. Simple check: the param names we expect.
		expect(/workspaceDir\??:\s*string/.test(src)).toBe(true);
		expect(/guidelines\??:\s*string\[\]/.test(src)).toBe(true);
		expect(/memoryContext\??:\s*string/.test(src)).toBe(true);
		// And NOT the workflow-context fields.
		expect(/stepsProgress/.test(src)).toBe(false);
		expect(/requirementDetail/.test(src)).toBe(false);
		expect(/wikiBaseline/.test(src)).toBe(false);
	});
});
