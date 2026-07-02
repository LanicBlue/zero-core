// Unit tests for TaskRegistry — parentTaskId stamping (live task tree) and the
// terminal-only acknowledge lifecycle (Part C).
import { describe, test, expect } from "vitest";
import { TaskRegistry } from "../../src/runtime/task-registry.js";
import { delegatedToolPolicy } from "../../src/runtime/subagent-delegator.js";

describe("TaskRegistry parentTaskId + acknowledge", () => {
	test("create stamps parentTaskId onto the task", () => {
		const reg = new TaskRegistry();
		reg.create("root-1", "subagent", "root task", undefined, undefined);
		reg.create("child-1", "subagent", "child task", undefined, "root-1");
		const root = reg.get("root-1");
		const child = reg.get("child-1");
		expect(root?.parentTaskId).toBeUndefined();
		expect(child?.parentTaskId).toBe("root-1");
		// list() carries the link through.
		expect(reg.list().find((t) => t.id === "child-1")?.parentTaskId).toBe("root-1");
	});

	test("acknowledge removes a terminal task but refuses a running one", () => {
		const reg = new TaskRegistry();
		const ac = new AbortController();
		reg.create("t", "bash", "work", ac);
		// Running → refuse.
		expect(reg.acknowledge("t")).toBe(false);
		expect(reg.get("t")).toBeDefined();
		// Complete → ack removes it.
		reg.complete("t", "done");
		expect(reg.acknowledge("t")).toBe(true);
		expect(reg.get("t")).toBeUndefined();
	});
});

describe("delegatedToolPolicy force-blocks AskUser for sub-agents", () => {
	test("adds AskUser to blockedTools and preserves existing blocks", () => {
		const p = delegatedToolPolicy({ blockedTools: ["WebSearch"], autoApprove: ["*"] });
		expect(p.blockedTools).toContain("AskUser");
		expect(p.blockedTools).toContain("WebSearch");
		expect(p.autoApprove).toEqual(["*"]);
	});

	test("blocks AskUser even when base has no blockedTools", () => {
		const p = delegatedToolPolicy(undefined as any);
		expect(p.blockedTools).toEqual(["AskUser"]);
	});
});
