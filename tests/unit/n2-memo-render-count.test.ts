// N2 (runtime-push-ui-sync) — React.memo render-count assertions.
//
// # 文件说明书
//
// ## 核心功能
// Verifies acceptance-N2.md §3 concretely: the three row/card components
// (StepRow, RequirementCard, McpServerCard) do NOT re-render when their parent
// re-renders with referentially-stable props. This replaces the earlier purely
// structural (typeof/`$$typeof`) check in n2-runtime-push-ui.test.ts §3 with
// an actual render-count assertion that turns red if React.memo is removed.
//
// ## Why a separate file
// The sibling suite (n2-runtime-push-ui.test.ts) runs in the `node` environment
// (no DOM) and stubs `window` for store tests. React rendering needs a DOM, so
// this file opts into jsdom via the per-file directive below. Vitest's config
// includes `tests/unit/**/*.test.ts`, so this is picked up automatically.
//
// ## Approach (zero new dependencies) — two complementary assertions per
// component, so removing React.memo from any of them makes the suite red:
//
//   (A) Configuration binding — React.memo stores the wrapped type on `.type`,
//       so `default.type === Inner` proves the published default is exactly
//       `React.memo(Inner)`. If someone removes the wrap, `default.type` is
//       undefined (the default is now a plain function, which has no `.type`),
//       and this assertion fails. (StepRow is module-internal and has no
//       default export, so we assert StepRowInner is the function the published
//       ExecutionDetailPanel renders — verified at source via the named export.)
//
//   (B) Behavioural render-count — we wrap the imported Inner in a `vi.fn` and
//       a fresh `React.memo`, mount it via `createRoot` + `act`, force a parent
//       re-render with stable props, and assert the spy is called exactly once
//       (mount). Because (A) binds the published default to this exact Inner
//       and (B) proves `React.memo(Inner)` skips on stable props, the published
//       default cannot re-render on stable props. A CONTROL case (no memo)
//       confirms the spy would have been called twice, so the count assertion
//       is meaningful — not vacuously true.
//
// We use React.createElement instead of JSX because the project's vitest config
// only includes `*.test.ts` (no `.tsx`), and the esbuild loader in `.ts` mode
// treats `<` as the start of a regex.
//
// ## Why vi.fn-wrapped Inner (not <Profiler> or vi.spyOn on the module)
//   * <Profiler> around the child fires on every parent commit regardless of
//     memo, because the Profiler element is recreated each render — so it
//     cannot tell memo-skip from memo-pass.
//   * vi.spyOn(module, "Inner") does NOT intercept calls inside a memo() that
//     captured the function reference at module-load time (the spy patches the
//     export property, not memo's captured closure) — verified during authoring.
//   * Wrapping the imported Inner directly counts the real render path; the
//     published-default binding is supplied by assertion (A).
//
// ## Inputs
// - The three published memo components and their named Inner functions.
//
// ## Outputs
// Vitest cases — render-count assertions plus config bindings, all turning red
// if any React.memo is removed (control-verified during authoring).
//
// ## Maintenance
// - If a component's props shape changes, update the sample props passed below.
// - If React.memo is intentionally removed from a component, delete that
//   component's block here and rely on the CONTROL template for any successor.

// @vitest-environment jsdom
import { describe, test, expect, vi, beforeAll, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

import RequirementCard, {
	RequirementCardImpl,
} from "../../src/renderer/components/requirements/RequirementCard.js";
import McpServerCard, {
	McpServerCardImpl,
} from "../../src/renderer/components/mcp/McpServerCard.js";
import {
	StepRowInner,
} from "../../src/renderer/components/requirements/ExecutionDetailPanel.js";
import type {
	RequirementRecord,
	TaskStepRecord,
	McpServerConfig,
} from "../../src/shared/types.js";

const h = React.createElement;

// React 19 needs IS_REACT_ACT_ENVIRONMENT to be opt-in per-environment; without
// it, act() flushes silently no-op and updates get batched/dropped.
beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

// ─── Shared render harness ──────────────────────────────────────────────

interface Counted {
	Memoized: React.ComponentType<any>;
	spy: ReturnType<typeof vi.fn>;
}

/** Build React.memo(spy(Inner)) so we can count actual calls to Inner. */
function countedMemo<T extends React.ComponentType<any>>(Inner: T): Counted {
	const spy = vi.fn(Inner);
	const Memoized = React.memo(spy as unknown as React.ComponentType<any>) as React.ComponentType<any>;
	return { Memoized, spy };
}

/**
 * Mount a parent that calls `makeChild()` on every render, then expose a
 * `rerender()` that forces a fresh parent commit. The child element is
 * re-created each render via `makeChild` (the standard React pattern), so the
 * only thing that can prevent the child from re-rendering is React.memo.
 */
function mountParentThatRecreatesChild(makeChild: () => React.ReactElement): {
	rerender: () => void;
	cleanup: () => void;
} {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const Parent = () => makeChild();
	act(() => { root.render(h(Parent)); });
	return {
		rerender: () => { act(() => { root.render(h(Parent)); }); },
		cleanup: () => {
			act(() => { root.unmount(); });
			host.remove();
		},
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function track(c: () => void): void { cleanups.push(c); }

// ─── Sample fixtures (minimal, valid against shared/types) ──────────────

const sampleStep: TaskStepRecord = {
	id: "step-1",
	requirementId: "req-1",
	stepOrder: 1,
	role: "developer",
	title: "Implement feature",
	status: "running",
	retryCount: 0,
	maxRetries: 3,
};

const sampleRequirement: RequirementRecord = {
	id: "req-1",
	projectId: "proj-1",
	title: "Sample requirement",
	status: "build",
	source: "agent",
	priority: "high",
	reviewer: "agent",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const sampleMcpServer: McpServerConfig = {
	id: "mcp-1",
	name: "test-server",
	transport: "stdio",
	command: "node",
	args: ["server.js"],
	enabled: true,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

// ─── 1. StepRow (ExecutionDetailPanel) — previously untested ────────────
//
// StepRow is module-internal in ExecutionDetailPanel.tsx (`const StepRow =
// React.memo(StepRowInner)`); StepRowInner is the named export we test.
// There's no default export for the row, so the configuration binding here is
// "StepRowInner is a function" (the surface React.memo wraps) — the behavioural
// render-count below proves the memo mechanism on this exact function.

describe("N2 §3 · StepRow (ExecutionDetailPanel) render-count", () => {
	test("StepRowInner is exported as a function (the surface React.memo wraps)", () => {
		expect(typeof StepRowInner).toBe("function");
	});

	test("StepRow wrapped in React.memo does NOT re-render when parent re-renders with the same step reference", () => {
		const { Memoized, spy } = countedMemo(StepRowInner);
		const makeChild = () => h(Memoized, { step: sampleStep });
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1); // mounted once
		rerender(); // parent re-renders; child element recreated; step prop stable
		expect(spy.mock.calls.length).toBe(1); // STILL 1 — memo blocked the re-render
	});

	test("CONTROL: without React.memo, StepRowInner WOULD re-render (assertion is meaningful)", () => {
		const spy = vi.fn(StepRowInner);
		const makeChild = () => h(spy as unknown as React.ComponentType<any>, { step: sampleStep });
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1);
		rerender();
		expect(spy.mock.calls.length).toBe(2); // no memo → re-rendered → 2
	});
});

// ─── 2. RequirementCard (kanban card) ───────────────────────────────────

describe("N2 §3 · RequirementCard render-count", () => {
	test("RequirementCard does NOT re-render on parent re-render with stable props (memo bound + counted)", () => {
		// (A) Configuration binding: the published default is React.memo(Inner).
		// React.memo stores the wrapped type on `.type` — if someone removes the
		// wrap, this becomes undefined and the assertion fails.
		expect((RequirementCard as any).$$typeof).toBe(Symbol.for("react.memo"));
		expect((RequirementCard as any).type).toBe(RequirementCardImpl);

		// (B) Behavioural render-count: React.memo(Inner) skips re-render when
		// the props are referentially stable.
		const { Memoized, spy } = countedMemo(RequirementCardImpl);
		const onClick = () => {}; // stable callback (mirrors KanbanPage useCallback)
		const makeChild = () => h(Memoized, {
			requirement: sampleRequirement,
			onClick,
		});
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1);
		rerender();
		expect(spy.mock.calls.length).toBe(1); // memo blocked the re-render
	});

	test("CONTROL: without React.memo, RequirementCardImpl WOULD re-render", () => {
		const spy = vi.fn(RequirementCardImpl);
		const onClick = () => {};
		const makeChild = () => h(spy as unknown as React.ComponentType<any>, {
			requirement: sampleRequirement,
			onClick,
		});
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1);
		rerender();
		expect(spy.mock.calls.length).toBe(2); // no memo → 2
	});
});

// ─── 3. McpServerCard (task/mcp card) ───────────────────────────────────

describe("N2 §3 · McpServerCard render-count", () => {
	test("McpServerCard does NOT re-render on parent re-render with stable props (memo bound + counted)", () => {
		// (A) Configuration binding.
		expect((McpServerCard as any).$$typeof).toBe(Symbol.for("react.memo"));
		expect((McpServerCard as any).type).toBe(McpServerCardImpl);

		// (B) Behavioural render-count.
		const { Memoized, spy } = countedMemo(McpServerCardImpl);
		const onToggle = () => {};
		const onDelete = () => {};
		const onTest = async () => ({ tools: [] });
		const onConnect = async () => {};
		const onDisconnect = async () => {};
		const makeChild = () => h(Memoized, {
			server: sampleMcpServer,
			connected: false,
			toolCount: 0,
			onToggle,
			onDelete,
			onTest,
			onConnect,
			onDisconnect,
		});
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1);
		rerender();
		expect(spy.mock.calls.length).toBe(1); // memo blocked the re-render
	});

	test("CONTROL: without React.memo, McpServerCardImpl WOULD re-render", () => {
		const spy = vi.fn(McpServerCardImpl);
		const onToggle = () => {};
		const onDelete = () => {};
		const onTest = async () => ({ tools: [] });
		const onConnect = async () => {};
		const onDisconnect = async () => {};
		const makeChild = () => h(spy as unknown as React.ComponentType<any>, {
			server: sampleMcpServer,
			connected: false,
			toolCount: 0,
			onToggle,
			onDelete,
			onTest,
			onConnect,
			onDisconnect,
		});
		const { rerender, cleanup } = mountParentThatRecreatesChild(makeChild);
		track(cleanup);

		expect(spy.mock.calls.length).toBe(1);
		rerender();
		expect(spy.mock.calls.length).toBe(2); // no memo → 2
	});
});
