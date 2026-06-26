import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { buildTool } from "../../src/runtime/tools/tool-factory.js";
import { registerExecutionApprovalHooks } from "../../src/runtime/hooks/execution-approval-hooks.js";

function makeTool(name: string, meta: any) {
	const execute = vi.fn(async () => "ok");
	const tool = buildTool({
		name,
		description: `${name} test tool`,
		meta,
		inputSchema: z.object({}),
		execute,
	});
	return { tool, execute };
}

async function run(tool: any, toolPolicy?: any) {
	return tool.execute({}, {
		toolCallId: "tc-approval",
		experimental_context: {
			workingDir: "/tmp",
			agentId: "agent-1",
			emit: () => {},
			toolPolicy,
		},
	});
}

describe("tool execution approval policy", () => {
	beforeEach(() => {
		HookRegistry.getInstance().clear();
		registerExecutionApprovalHooks();
	});

	afterEach(() => {
		HookRegistry.getInstance().clear();
	});
	test("read-only tools execute without pre-approval", async () => {
		const { tool, execute } = makeTool("ReadOnlyTest", {
			category: "runtime",
			isReadOnly: true,
			isDestructive: false,
		});

		await expect(run(tool)).resolves.toBe("ok");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	test("destructive tools are denied without pre-approval", async () => {
		const { tool, execute } = makeTool("DangerTest", {
			category: "runtime",
			isReadOnly: false,
			isDestructive: true,
		});

		await expect(run(tool)).rejects.toThrow(/requires pre-approval/);
		expect(execute).not.toHaveBeenCalled();
	});

	test("autoApprove pre-authorizes destructive tools", async () => {
		const { tool, execute } = makeTool("DangerTest", {
			category: "runtime",
			isReadOnly: false,
			isDestructive: true,
		});

		await expect(run(tool, { autoApprove: ["DangerTest"] })).resolves.toBe("ok");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	test("enabled tool policy pre-authorizes destructive tools", async () => {
		const { tool, execute } = makeTool("DangerTest", {
			category: "runtime",
			isReadOnly: false,
			isDestructive: true,
		});

		await expect(run(tool, { tools: { DangerTest: { enabled: true } } })).resolves.toBe("ok");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	test("blockedTools denies even non-destructive tools", async () => {
		const { tool, execute } = makeTool("ReadOnlyTest", {
			category: "runtime",
			isReadOnly: true,
			isDestructive: false,
		});

		await expect(run(tool, { blockedTools: ["ReadOnlyTest"] })).rejects.toThrow(/blocked by agent policy/);
		expect(execute).not.toHaveBeenCalled();
	});
});