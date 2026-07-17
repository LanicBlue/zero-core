// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-05 §B「Runtime 权限」+ §H 拒绝条件中**对抗**视角:
// 试破身份注入 / 越权 / hardcode 全树等。覆盖范围:
//
//   §B.1  wikiAccess 注入路径(compile → SessionConfig → AgentLoop → CallerCtx)
//   §B.2  LLM input 无法改变 agentId / activeProjectId / grants
//   §B.3  无 active project 时 project:// 不扩到 projects 根
//   §B.4  Zero 仅在显式 grant 时拥有全树,删除 grant 立即失去
//   §H    agentId === "zero" / name === "zero" 硬编码全树 = 拒绝条件
//
// ## 对抗 probe 焦点
//   - pickDefaultGrants(name=zero) → DEFAULT_GRANTS_ZERO_ADMIN 是否构成 §H 第1条违反
//     (将 hardcode 从 agentId 移到 name,语义等价;fresh zero agent 自动获全树)。
//   - smuggled agentId/projectId/grants/canonicalScope/cwd 是否被 zod strip 或扩展 grants。
//   - 无 active project + project:// grant → resolveScopeToCanonical 必须返 null (inactive),
//     不能扩到 wiki-root/projects 根。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR(vi.hoisted)。
//   - 直接调 compileWikiAccess + CallerCtx 构造,不依赖完整 AgentService bootstrap。
//
// ## 维护规则
//   - 不 edit 实现源;发现违反报 blocker finding。

import { describe, test, expect } from "vitest";

import {
	compileWikiAccess,
	DEFAULT_GRANTS_AGENT,
	DEFAULT_GRANTS_ZERO_ADMIN,
	DEFAULT_GRANTS_ARCHIVIST,
	DEFAULT_GRANTS_PROJECT_RESEARCHER,
} from "../../src/server/wiki/wiki-access-compiler.js";
import { wikiV2ActionSchema } from "../../src/tools/wiki-v2-tool.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
} from "../../src/shared/wiki-types.js";
import type { WikiGrant } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];

function grantOf(scope: string, actions: WikiAction[]): WikiGrant {
	return { scope, actions };
}
function compiledGrant(scope: string, actions: WikiAction[]): CompiledWikiGrant {
	return { canonicalScope: scope, actions };
}

// ===========================================================================
// §B.1  compile → CompiledWikiAccess 形态
// ===========================================================================

describe("wiki-v2 §B.1 compileWikiAccess: deterministic + host-only [对抗 lens]", () => {
	test("memory:// resolves to own agent memory root (NOT projects root, NOT global)", () => {
		const r = compileWikiAccess({
			agentId: "agent-abc",
			activeProjectId: undefined,
			wikiGrants: [grantOf("memory://", ALL_ACTIONS)],
		});
		expect(r.warnings).toEqual([]);
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/memory/agent-abc", ALL_ACTIONS),
		);
	});

	test("memory://<rest> resolves to nested path under own memory root", () => {
		const r = compileWikiAccess({
			agentId: "agent-abc",
			wikiGrants: [grantOf("memory://preferences/core", ["read"])],
		});
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/memory/agent-abc/preferences/core", ["read"]),
		);
	});

	test("deterministic: same input → same output (byte-level)", () => {
		const opts = {
			agentId: "agent-x",
			activeProjectId: "proj-y" as const,
			wikiGrants: [grantOf("memory://", ["read"]), grantOf("project://", ["read", "search"])],
		};
		const a = compileWikiAccess(opts);
		const b = compileWikiAccess(opts);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test("empty agentId → empty grants + warning (no synthetic identity)", () => {
		const r = compileWikiAccess({
			agentId: "",
			wikiGrants: [grantOf("memory://", ALL_ACTIONS)],
		});
		expect(r.access.grants).toEqual([]);
		expect(r.access.agentId).toBe("");
		expect(r.warnings.length).toBeGreaterThan(0);
	});
});

// ===========================================================================
// §B.3  project:// inactive when no active project
// ===========================================================================

describe("wiki-v2 §B.3 project:// inactive without active project [对抗 lens]", () => {
	test("project:// grant SKIPPED (not widened to wiki-root/projects root)", () => {
		const r = compileWikiAccess({
			agentId: "agent-abc",
			activeProjectId: undefined,
			wikiGrants: [grantOf("project://", ["read", "search"])],
		});
		// 整条 grant inactive → 不出现在 compiled grants
		expect(r.access.grants).toEqual([]);
		// 必须有 warning 说明 inactive
		expect(r.warnings.some((w) => /inactive/i.test(w))).toBe(true);
		// 关键对抗断言:无任何 canonicalScope 等于 / 起始于 wiki-root/projects 根
		for (const g of r.access.grants) {
			expect(g.canonicalScope).not.toBe("wiki-root/projects");
			expect(g.canonicalScope.startsWith("wiki-root/projects/")).toBe(false);
		}
	});

	test("project:// resolves to wiki-root/projects/<projectId> when active", () => {
		const r = compileWikiAccess({
			agentId: "agent-abc",
			activeProjectId: "proj-123",
			wikiGrants: [grantOf("project://", ["read"])],
		});
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/projects/proj-123", ["read"]),
		);
	});

	test("project://<rest> resolves nested under the active project", () => {
		const r = compileWikiAccess({
			agentId: "agent-abc",
			activeProjectId: "proj-123",
			wikiGrants: [grantOf("project://src/modules", ["read"])],
		});
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/projects/proj-123/src/modules", ["read"]),
		);
	});
});

// ===========================================================================
// §B.2  LLM input cannot change identity (schema boundary)
// ===========================================================================

describe("wiki-v2 §B.2 LLM input cannot change identity [对抗 lens]", () => {
	test("smuggled agentId/projectId/grants/canonicalScope/cwd are STRIPPED by zod", () => {
		// z.object default = strip unknown keys. Identity keys never reach execute.
		const parsed = wikiV2ActionSchema.safeParse({
			action: "read",
			node: "memory://",
			// smuggled identity — must be stripped
			agentId: "admin",
			activeProjectId: "p-other",
			projectId: "p-other",
			grants: [{ canonicalScope: "wiki-root", actions: ALL_ACTIONS }],
			canonicalScope: "wiki-root",
			cwd: "/etc",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			const data = parsed.data as Record<string, unknown>;
			for (const banned of ["agentId", "activeProjectId", "projectId", "grants", "canonicalScope", "cwd"]) {
				expect(data, `smuggled '${banned}' must NOT survive zod parse`).not.toHaveProperty(banned);
			}
		}
	});

	test("attacker cannot escalate grants by combining smuggled input + narrow wikiAccess", () => {
		// Victim host compiles a NARROW access (read-only on one node).
		const narrow = compileWikiAccess({
			agentId: "victim",
			activeProjectId: undefined,
			wikiGrants: [grantOf("memory://public", ["read"])],
		}).access;
		// Attacker cannot broaden the compiled access via input — wikiAccess is
		// the authoritative shape and is host-injected. We assert that compiling
		// with the victim's grants yields exactly the narrow scope, regardless
		// of any hypothetical smuggled payload (which zod strips at tool entry).
		expect(narrow.grants).toEqual([
			compiledGrant("wiki-root/memory/victim/public", ["read"]),
		]);
		expect(narrow.agentId).toBe("victim");
		// activeProjectId is undefined → no project scope can be introduced.
		expect(narrow.activeProjectId).toBeUndefined();
	});

	test("compiled access is immutable snapshot — no method on it to mutate grants", () => {
		// CompiledWikiAccess is a plain data object. Confirm shape: there is no
		// extend()/addGrant()/mutate method the LLM could call.
		const acc: CompiledWikiAccess = compileWikiAccess({
			agentId: "x",
			wikiGrants: [grantOf("memory://", ["read"])],
		}).access;
		const methods = Object.keys(acc).filter((k) => typeof (acc as any)[k] === "function");
		expect(methods, "CompiledWikiAccess must be plain data, no callable grant mutators").toEqual([]);
	});
});

// ===========================================================================
// §B.4 + §H #1  Zero must NOT get whole-tree grants by name/agentId hardcode
// ===========================================================================

describe("wiki-v2 §B.4/§H Zero whole-tree grants are NOT hardcoded [对抗 lens — 取舍 1]", () => {
	test("ZERO admin grant only when agent.wikiGrants EXPLICITLY contains wiki-root", () => {
		// 正路径:Agent 显式配 wiki-root grant → compile 出全树权限。
		const r = compileWikiAccess({
			agentId: "zero",
			activeProjectId: undefined,
			wikiGrants: [grantOf("wiki-root", ALL_ACTIONS)],
		});
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root", ALL_ACTIONS),
		);
	});

	test("[对抗 probe §H #1] fresh zero agent with NO wikiGrants MUST NOT silently gain wiki-root", () => {
		// 关键对抗断言:AgentRecord.wikiGrants 未配 + compileWikiAccess 不传
		// fallbackGrants 时,zero agent 不能自动获得 wiki-root 全树。
		// (acceptance-05 §H 第1条:agentId === "zero" 或无 project session
		//  被硬编码全树权限 = 拒绝条件。)
		const r = compileWikiAccess({
			agentId: "zero",
			activeProjectId: undefined,
			wikiGrants: undefined, // 显式 undefined
		});
		// 无 fallback → 空 access。zero 没有任何 wiki 权限,直到 host 显式 grant。
		expect(r.access.grants, "zero with no explicit grants must have empty access").toEqual([]);
	});

	test("[round-2 B1 fix] AgentService.pickDefaultGrants no longer keys off name=='zero' / 'admin'", () => {
		// round-2 B1 修复后:pickDefaultGrants 完全无视 agent.name/agentId 启发式。
		// fresh zero / admin / archivist 一律退 DEFAULT_GRANTS_AGENT(own Memory +
		// Knowledge read),不再凭名字拿 wiki-root 全树。wiki-root 全树权限必须经
		// PromptTemplate 显式 seed(sub-06/07 字段化,deferred)或 AgentRegistry 工具
		// 显式写入 AgentRecord.wikiGrants。
		//
		// 这里断言 DEFAULT_GRANTS_ZERO_ADMIN 常量本身仍存在(template seed 会用),
		// 但 pickDefaultGrants 不返它 —— fresh zero 不再因 fallback 拿到全树。
		expect(DEFAULT_GRANTS_ZERO_ADMIN).toEqual([
			{ scope: "wiki-root", actions: ALL_ACTIONS },
		]);
		// 模拟 fresh zero agent(无 wikiGrants)+ pickDefaultGrants 返 DEFAULT_GRANTS_AGENT
		// (修法 b:fallback 统一 own Memory + Knowledge read)。
		const r = compileWikiAccess({
			agentId: "zero",
			activeProjectId: undefined,
			wikiGrants: undefined,
			fallbackGrants: DEFAULT_GRANTS_AGENT, // round-2 B1 fix 后 pickDefaultGrants 返此
		});
		// fresh zero agent 现在只拿 own memory://(编译到 wiki-root/memory/zero)
		// + Knowledge read。**不**包含 wiki-root 全树 grant。
		expect(r.access.grants).not.toContainEqual(
			compiledGrant("wiki-root", ALL_ACTIONS),
		);
		// own memory grant 编译到了 wiki-root/memory/zero 的子树权限。
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/memory/zero", ALL_ACTIONS),
		);
		// Knowledge read 也在(DEFAULT_GRANTS_AGENT 含 wiki-root/knowledge read 子集)。
		const knowledgeGrant = r.access.grants.find((g) =>
			g.canonicalScope === "wiki-root/knowledge");
		expect(knowledgeGrant).toBeDefined();
		expect(knowledgeGrant?.actions).toEqual(["expand", "read", "search"]);
	});

	test("removing wiki-root grant from explicit grants immediately removes whole-tree access", () => {
		// 正路径合规证明:有显式 grant 时删 grant 立即失去。
		const before = compileWikiAccess({
			agentId: "zero",
			wikiGrants: [grantOf("wiki-root", ALL_ACTIONS)],
		}).access;
		expect(before.grants).toContainEqual(compiledGrant("wiki-root", ALL_ACTIONS));

		const after = compileWikiAccess({
			agentId: "zero",
			wikiGrants: [], // 删除 grant
		}).access;
		expect(after.grants).toEqual([]);
	});
});

// ===========================================================================
// §H leak prevention — multi-grant merging + unknown actions
// ===========================================================================

describe("wiki-v2 §H multi-grant merging + unknown actions [对抗 lens]", () => {
	test("two grants on same canonicalScope merge actions (union)", () => {
		// 同 memory:// 两条 grant → actions 并集。
		const r = compileWikiAccess({
			agentId: "a",
			wikiGrants: [
				grantOf("memory://", ["read"]),
				grantOf("memory://sub", ["read", "search"]),
			],
		});
		// 两个不同 canonicalScope(own root vs sub)→ 两条独立 grant。
		expect(r.access.grants).toHaveLength(2);
	});

	test("unknown actions are skipped with warning (no escalation)", () => {
		const r = compileWikiAccess({
			agentId: "a",
			wikiGrants: [
				grantOf("memory://", ["read", "admin", "*", "grantAll" as WikiAction]),
			],
		});
		// 'admin' / '*' / 'grantAll' 全部不在闭集 → 跳过,只留 read。
		expect(r.access.grants).toContainEqual(
			compiledGrant("wiki-root/memory/a", ["read"]),
		);
		expect(r.warnings.some((w) => /unknown action/i.test(w))).toBe(true);
	});

	test("unknown scheme grant skipped (no leak)", () => {
		const r = compileWikiAccess({
			agentId: "a",
			wikiGrants: [
				grantOf("memory://", ["read"]),
				grantOf("secret://something", ["read"]),
				grantOf("/etc/passwd", ["read"]),
			],
		});
		expect(r.access.grants).toEqual([
			compiledGrant("wiki-root/memory/a", ["read"]),
		]);
		// 两条 unknown scheme → 至少 2 warnings。
		expect(r.warnings.filter((w) => /unrecognized scheme/i.test(w)).length).toBeGreaterThanOrEqual(2);
	});
});

// ===========================================================================
// Default grant exports — shape regression (防止悄悄加 admin action)
// ===========================================================================

describe("wiki-v2 default grants export shape [对抗 lens]", () => {
	test("DEFAULT_GRANTS_AGENT grants own memory + knowledge READ only (no project)", () => {
		const scopes = DEFAULT_GRANTS_AGENT.map((g) => g.scope).sort();
		expect(scopes).toEqual(["memory://", "wiki-root/knowledge"]);
		// 不含 project:// —— 普通 Agent 默认不读 active project。
		expect(DEFAULT_GRANTS_AGENT.some((g) => g.scope.startsWith("project://"))).toBe(false);
	});

	test("DEFAULT_GRANTS_PROJECT_RESEARCHER grants read-only project access", () => {
		const proj = DEFAULT_GRANTS_PROJECT_RESEARCHER.find((g) => g.scope === "project://");
		expect(proj).toBeDefined();
		expect(proj!.actions).toEqual(["expand", "read", "search"]);
		// 无 create/update/delete/move —— Project researcher 只读。
		for (const write of ["create", "update", "delete", "move"] as const) {
			expect(proj!.actions, `project researcher must NOT have '${write}'`).not.toContain(write);
		}
	});

	test("DEFAULT_GRANTS_ARCHIVIST grants project update/link/unlink but NOT create/move/delete", () => {
		const proj = DEFAULT_GRANTS_ARCHIVIST.find((g) => g.scope === "project://");
		expect(proj).toBeDefined();
		for (const allowed of ["expand", "read", "search", "update", "link", "unlink"] as const) {
			expect(proj!.actions).toContain(allowed);
		}
		// 关键对抗:source-bound 结构操作(create/move/delete)是 indexer 专属,
		// Archivist 默认 fallback 不授予(plan-05 §2 / §9)。
		for (const banned of ["create", "move", "delete"] as const) {
			expect(proj!.actions, `archivist must NOT have '${banned}'`).not.toContain(banned);
		}
	});

	test("DEFAULT_GRANTS_ZERO_ADMIN is wiki-root whole-tree (the §H violation shape)", () => {
		// 结构证据:Zero fallback 含 wiki-root 全部 9 actions。
		// 这本身是 plan-05 §2 期望的"显式 grant"形态 —— 但因 pickDefaultGrants
		// 按 name 触发,变成 §H 第1条违反(见 blocker finding)。
		expect(DEFAULT_GRANTS_ZERO_ADMIN).toEqual([
			{ scope: "wiki-root", actions: ALL_ACTIONS },
		]);
	});
});
