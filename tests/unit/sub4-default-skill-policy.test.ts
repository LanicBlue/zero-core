// 单元测试:skill-system sub-4 新 agent 默认全不开(acceptance-4 用例 2)
//
// # 文件说明书
//
// ## 核心功能
// 验证 AgentStore.create 的 skillPolicy 默认填充(对齐 design 决策 5):
//   - 不传 skillPolicy → 写入 { enabledSkills: [] }(显式空,全不开)。
//   - 传 { enabledSkills: undefined } → 同样填 []。
//   - 传 { enabledSkills: ["pdf"] } → 原样保留(不被默认值覆盖)。
//   - round-trip 经 DB 持久化后读回仍是上述值。
// UI 表单(agentToForm)对 legacy 记录(undefined)也归一化为 []。
//
// ## 输入
// 临时 SessionDB + runMigrations;AgentStore;agent-editor-types.agentToForm。
//
// ## 输出
// Vitest 用例覆盖 acceptance-4.md 用例 2。
//
// ## 定位
// tests/unit/ —— store 层 round-trip 单测。
//
// ## 依赖
// vitest、../../src/server/{session-db,agent-store,db-migration}.js、
// ../../src/renderer/components/agents/agent-editor-types.js。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { agentToForm } from "../../src/renderer/components/agents/agent-editor-types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let agentStore: AgentStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub4-skill-policy-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	agentStore = new AgentStore(sessionDB);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentStore.create — skillPolicy 默认全不开(sub-4 决策 5)", () => {
	test("不传 skillPolicy → enabledSkills === [] (显式空,全不开)", () => {
		const a = agentStore.create({ name: "NewAgent" } as any);
		const fetched = agentStore.get(a.id)!;
		expect(fetched.skillPolicy).toBeDefined();
		expect(fetched.skillPolicy!.enabledSkills).toEqual([]);
	});

	test("传 { enabledSkills: undefined } → 归一化为 []", () => {
		const a = agentStore.create({ name: "N", skillPolicy: { enabledSkills: undefined } } as any);
		const fetched = agentStore.get(a.id)!;
		expect(fetched.skillPolicy!.enabledSkills).toEqual([]);
	});

	test("传 { enabledSkills: ['pdf'] } → 原样保留,不被默认值覆盖", () => {
		const a = agentStore.create({ name: "N", skillPolicy: { enabledSkills: ["pdf"] } } as any);
		const fetched = agentStore.get(a.id)!;
		expect(fetched.skillPolicy!.enabledSkills).toEqual(["pdf"]);
	});

	test("update 不破坏 enabledSkills(显式写仍透传)", () => {
		const a = agentStore.create({ name: "N", skillPolicy: { enabledSkills: ["pdf"] } } as any);
		const updated = agentStore.update(a.id, { skillPolicy: { enabledSkills: ["pdf", "code-review"] } } as any);
		expect(updated.skillPolicy!.enabledSkills).toEqual(["pdf", "code-review"]);
	});
});

describe("agentToForm — legacy(undefined)归一化为 [](sub-4 决策 5,为 sub-5 UI 兜底)", () => {
	test("legacy 记录无 skillPolicy → form.enabledSkills === []", () => {
		const form = agentToForm({ id: "x", name: "L", createdAt: "", updatedAt: "" } as any);
		expect(form.skillPolicy).toEqual({ enabledSkills: [] });
	});

	test("legacy 记录 enabledSkills===undefined → form.enabledSkills === []", () => {
		const form = agentToForm({ id: "x", name: "L", skillPolicy: { enabledSkills: undefined }, createdAt: "", updatedAt: "" } as any);
		expect(form.skillPolicy).toEqual({ enabledSkills: [] });
	});

	test("有值记录 → form 原样保留", () => {
		const form = agentToForm({ id: "x", name: "L", skillPolicy: { enabledSkills: ["pdf"] }, createdAt: "", updatedAt: "" } as any);
		expect(form.skillPolicy).toEqual({ enabledSkills: ["pdf"] });
	});
});
