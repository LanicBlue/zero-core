// 单元测试:工具名迁移(Wiki 等域工具的小写别名)
//
// # 文件说明书
//
// ## 核心功能
// 锁死:旧配置里小写键 {wiki:{enabled:true}} 必须迁移到 PascalCase 的 "Wiki",
// 使 (a) buildToolsSet 产出 Wiki 工具,且 (b) AgentService 的能力注入
// (capabilityHandlesFor,经 toolEnabled)注入 wikiStore —— 两边对迁移达成一致。
// 修复前:RENAMED_TOOLS 缺 wiki→Wiki,且 toolEnabled 不迁移 → 即便想开 Wiki,
// 能力侧 on("Wiki") 返回 false → 不注入 wikiStore → 工具开了也跑不起来
// (CONDITIONAL_TOOLS 已于 2026-07 移除,门控现为单一 toolPolicy)。
//
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolsSet } from "../../src/tools/index.js";
import { AgentService } from "../../src/server/agent-service.js";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";

describe("tool-name migration — legacy lowercase → PascalCase domain tools", () => {
	describe("buildToolsSet", () => {
		test("lowercase {wiki:true} yields Wiki when wikiStore is present", () => {
			const tools = buildToolsSet(
				{ tools: { wiki: { enabled: true } } },
				{ wikiStore: {} } as any,
			);
			expect("Wiki" in tools).toBe(true);
		});

		test("PascalCase {Wiki:true} still works (no regression)", () => {
			const tools = buildToolsSet(
				{ tools: { Wiki: { enabled: true } } },
				{ wikiStore: {} } as any,
			);
			expect("Wiki" in tools).toBe(true);
		});

		test("wiki disabled → absent even with wikiStore", () => {
			const tools = buildToolsSet(
				{ tools: { wiki: { enabled: false } } },
				{ wikiStore: {} } as any,
			);
			expect("Wiki" in tools).toBe(false);
		});

		test("other domain tools migrate too (project / cron / agent_registry)", () => {
			const tools = buildToolsSet(
				{ tools: { project: { enabled: true }, cron: { enabled: true }, agent_registry: { enabled: true } } },
				{ management: {} } as any,
			);
			expect("Project" in tools).toBe(true);
			expect("Cron" in tools).toBe(true);
			expect("AgentRegistry" in tools).toBe(true);
		});

		test("Subagent rename: old 'Agent' canonical + lowercase aliases all map to 'Subagent'", () => {
			// The delegate tool was renamed "Agent" → "Subagent". RENAMED_TOOLS must
			// map the old canonical name AND the lowercase aliases so pre-rename
			// policy/config keys (toolPolicy.tools / toolConfig) keep working.
			// (buildToolsSet doesn't surface Subagent without a delegation context, so
			// we assert the map directly — the same map buildToolsSet + getToolConfig
			// apply.)
			expect(RENAMED_TOOLS["Agent"]).toBe("Subagent");
			expect(RENAMED_TOOLS["agent"]).toBe("Subagent");
			expect(RENAMED_TOOLS["subagent"]).toBe("Subagent");
		});
	});

	describe("AgentService.capabilityHandlesFor (toolEnabled migration)", () => {
		let dir: string;
		beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "zc-migrate-")); });
		afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

		// plan-08 §1: Wiki v2 tool reads the wiki-service singleton directly;
		// capabilityHandlesFor no longer injects `wikiStore` for {wiki:true}.
		// These two tests document the retirement of legacy wikiStore injection.
		test("plan-08 §1: does NOT inject wikiStore for legacy {wiki:true} (singleton instead)", () => {
			const svc = new AgentService(dir);
			(svc as any).wikiStore = { stub: true };
			const caps = (svc as any).capabilityHandlesFor({ tools: { wiki: { enabled: true } } });
			expect(caps.wikiStore).toBeUndefined();
		});

		test("does not inject wikiStore when wiki disabled", () => {
			const svc = new AgentService(dir);
			(svc as any).wikiStore = { stub: true };
			const caps = (svc as any).capabilityHandlesFor({ tools: { wiki: { enabled: false } } });
			expect(caps.wikiStore).toBeUndefined();
		});
	});
});
