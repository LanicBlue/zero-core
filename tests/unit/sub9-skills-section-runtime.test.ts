// 集成测试:skill-system sub-9 skills section 运行时注入(Approach A)
//
// # 文件说明书
//
// ## 核心功能
// 验证 AgentLoop 的 `skills` system section 经 getSkillSection 闭包真的进
// assembleSystemPrompt 输出(运行时 prompt),并覆盖:
//   1. enabled 命中 → prompt 含 [skills]/<id>/SKILL.md 路径
//   2. enabledSkills=[] → 不含
//   3. undefined → legacy 全注入
//   4. sub-12: Authoring 段已移除(即便 enabledSkills 含 skill-creator 也只产 Available)
//   5. applyConfigUpdate({getSkillSection}) 热更 → 下次 assemble 重算(invalidate)
//
// ## 驱动方式
// mock provider-factory.resolveModel 返回内联 LanguageModelV2,其 doStream 捕获
// 收到的 system prompt(镜像 n4-config-hot-sync.test.ts);mock skill-scanner
// .scanSkills 返固定列表(避免磁盘依赖);直接构造 AgentLoop 并触发一次 run()。
//
// ## 范围说明
// 仅验「section 经闭包注入 assembleSystemPrompt」;不动 scanner/CRUD/git
// (sub-1~8 已覆盖)。assembleSystemPrompt 私有,经 doStream 入参侧观察。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// Mock provider-factory BEFORE importing AgentLoop.
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
}));

// Mock skill-scanner.scanSkills so the closure (which calls scanSkills() with
// no args at call time) returns our fixed list — no disk dependency.
const scanSkillsMock = vi.fn();
vi.mock("../../src/server/skill-scanner.js", () => ({
	scanSkills: (...args: unknown[]) => scanSkillsMock(...args),
}));

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import { buildSkillsSection } from "../../src/core/skills-section.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent } from "../../src/runtime/types.js";

const SKILLS = [
	{ id: "pdf", name: "PDF", description: "Read and edit PDF files." },
	{ id: "code-review", name: "Code Review", description: "Review the diff." },
];

// Captures the system prompt handed to streamText on each doStream call.
let capturedSystemPrompts: string[] = [];

function createCapturingModel(): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId: "sub9-mock",
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream(opts: any) {
			// AI SDK: streamText({system, messages}) → doStream({prompt: [{role,content}, ...]}).
			// The system string lands as the first prompt entry with role "system".
			const prompt: any[] = Array.isArray(opts?.prompt) ? opts.prompt : [];
			const sysEntry = prompt.find((p) => p?.role === "system");
			capturedSystemPrompts.push(typeof sysEntry?.content === "string" ? sysEntry.content : "");
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([
						{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
					]);
					controller.close();
				},
			});
			return { stream } as any;
		},
	} as unknown as LanguageModelV2;
}

let tmpDir: string;
let sessionDB: SessionDB;

function makeCallbacks(): RuntimeCallbacks {
	return { onEvent: (_event: StreamEvent) => { /* swallow */ } };
}

function makeConfig(sessionId: string, getSkillSection?: () => string): SessionConfig {
	return {
		agentId: "sub9-agent",
		workspaceDir: tmpDir,
		systemPrompt: "BASE.",
		modelId: "m",
		providerName: "ProviderX",
		sessionId,
		db: sessionDB as any,
		toolPolicy: { tools: {} },
		getSkillSection,
	} as unknown as SessionConfig;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub9-skills-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	capturedSystemPrompts = [];
	scanSkillsMock.mockReturnValue(SKILLS);
	resolveModelMock.mockReturnValue(createCapturingModel());
});

afterEach(() => {
	vi.restoreAllMocks();
	// NOTE: Windows file-lock — AgentService/AgentStore hold the SQLite handle
	// open; rmSync hits EPERM. Leave the temp dir for OS cleanup (mkdtempSync
	// already isolated per-run). This matches other AgentLoop integration tests
	// that don't force-clean.
});

async function runOnce(loop: AgentLoop): Promise<string> {
	await loop.run("hi");
	// Return the last captured system prompt.
	return capturedSystemPrompts[capturedSystemPrompts.length - 1] ?? "";
}

describe("sub-9 skills section — 运行时注入 assembleSystemPrompt", () => {
	test("enabled 命中 → prompt 含 [skills]/pdf/SKILL.md 路径 + 指引", async () => {
		// Mirror agent-service.buildSkillSectionClosure: closure re-reads scanSkills +
		// (here inline) policy at call time.
		const closure = (): string => buildSkillsSection({
			skills: scanSkillsMock(),
			enabledSkills: ["pdf"],
		});
		const loop = new AgentLoop(makeConfig("s1", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).toContain("## Available Skills");
		expect(prompt).toContain("[skills]/pdf/SKILL.md");
		expect(prompt).not.toContain("[skills]/code-review/SKILL.md");
		expect(prompt).toContain("**Load**");
	});

	test("enabledSkills=[] → prompt 不含 Available Skills 段", async () => {
		const closure = (): string => buildSkillsSection({
			skills: scanSkillsMock(),
			enabledSkills: [],
		});
		const loop = new AgentLoop(makeConfig("s2", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).not.toContain("## Available Skills");
		expect(prompt).not.toContain("[skills]/pdf/SKILL.md");
	});

	test("enabledSkills=undefined (legacy) → 全注入", async () => {
		const closure = (): string => buildSkillsSection({
			skills: scanSkillsMock(),
		});
		const loop = new AgentLoop(makeConfig("s3", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).toContain("[skills]/pdf/SKILL.md");
		expect(prompt).toContain("[skills]/code-review/SKILL.md");
	});

	test("sub-12: Authoring 段已移除 —— 即便 enabledSkills 含 skill-creator 也只产 Available", async () => {
		// sub-12 移除了原 canAuthorSkills=true 注入的 Authoring 引导段。即便闭包
		// 注入 skill-creator(skillPolicy.enabledSkills 含它),prompt 也只有 Available
		// Skills 段(skill-creator 的 name+desc 在该段),不再有 Authoring 段。
		const closure = (): string => buildSkillsSection({
			skills: [{ id: "skill-creator", name: "skill-creator", description: "create skills" }, ...scanSkillsMock()],
			enabledSkills: ["skill-creator"],
		});
		const loop = new AgentLoop(makeConfig("s4", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).toContain("## Available Skills");
		expect(prompt).not.toContain("## Authoring Skills");
		expect(prompt).not.toContain("[skills]/<skill-id>/SKILL.md");
	});

	test("无 getSkillSection 闭包 → 段不出现(向后兼容,non-skill agent)", async () => {
		const loop = new AgentLoop(makeConfig("s5", undefined), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).not.toContain("## Available Skills");
		expect(prompt).not.toContain("## Authoring Skills");
		// base prompt 仍在
		expect(prompt).toContain("BASE.");
	});
});

describe("sub-9 skills section — applyConfigUpdate 热更(invalidate)", () => {
	test("热更 getSkillSection 闭包 → 下次 assemble 用新闭包", async () => {
		// 初始闭包:enabled=[] → 段不出现
		let closure = (): string => buildSkillsSection({
			skills: scanSkillsMock(),
			enabledSkills: [],
		});
		const loop = new AgentLoop(makeConfig("s6", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		let prompt = await runOnce(loop);
		expect(prompt).not.toContain("## Available Skills");

		// 热更:换 enabled=["pdf"]
		closure = (): string => buildSkillsSection({
			skills: scanSkillsMock(),
			enabledSkills: ["pdf"],
		});
		loop.applyConfigUpdate({ getSkillSection: closure });
		capturedSystemPrompts = [];
		prompt = await runOnce(loop);
		// 新闭包生效 —— 段出现
		expect(prompt).toContain("## Available Skills");
		expect(prompt).toContain("[skills]/pdf/SKILL.md");
	});
});

describe("sub-9 skills section — agent-service 闭包集成(getAgentRecord + scanSkills)", () => {
	test("buildSkillSectionClosure 经 agent-service 注入 → prompt 含 enabled skill", async () => {
		// 真实 AgentService + AgentStore:持久化一个带 skillPolicy 的 agent,
		// createLoopForSession 应自动注入 getSkillSection 闭包。
		const svc = new AgentService(tmpDir, sessionDB);
		const store = new AgentStore(sessionDB);
		svc.setAgentStore(store);
		// agent 带 skillPolicy.enabledSkills = ["pdf"] (sub-12:canAuthorSkills 已移除)
		const created = store.create({
			name: "Sub9",
			systemPrompt: "AGENT BASE.",
			toolPolicy: { tools: {} },
			skillPolicy: { enabledSkills: ["pdf"] },
		} as any);

		// 验 skillPolicy 持久化可读(sub-8 已覆盖 getAgentRecord;这里验闭包链)。
		const agent = svc.getAgentRecord(created.id);
		expect(agent?.skillPolicy?.enabledSkills).toEqual(["pdf"]);

		// 闭包链:scanSkillsMock 已 beforeEach 返 SKILLS;模拟 svc 的闭包逻辑
		// (与 buildSkillSectionClosure 同款)。sub-12:不再传 canAuthorSkills。
		const closure = (): string => {
			const a = svc.getAgentRecord(created.id);
			const policy = a?.skillPolicy;
			return buildSkillsSection({
				skills: scanSkillsMock().map((s: any) => ({ id: s.id, name: s.name, description: s.description })),
				enabledSkills: policy?.enabledSkills,
			});
		};
		const loop = new AgentLoop(makeConfig("s7", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		expect(prompt).toContain("[skills]/pdf/SKILL.md");
		expect(prompt).not.toContain("[skills]/code-review/SKILL.md");
		// sub-12:Authoring 段已移除(即便有 skill-creator 也只在 Available 段)
		expect(prompt).not.toContain("## Authoring Skills");
	});

	test("agent 无 skillPolicy(create 默认填 enabledSkills=[])→ 段不出现(sub-4 默认全不开)", async () => {
		const svc = new AgentService(tmpDir, sessionDB);
		const store = new AgentStore(sessionDB);
		svc.setAgentStore(store);
		// create 不传 skillPolicy → AgentStore.create 归一化为 {enabledSkills:[]}
		// (sub-4 decision 5: 新 agent 默认全不开;sub-12:canAuthorSkills 已移除)。
		const created = store.create({
			name: "FreshAgent",
			systemPrompt: "BASE.",
			toolPolicy: { tools: {} },
		} as any);
		expect(created.skillPolicy?.enabledSkills).toEqual([]);

		const closure = (): string => {
			const a = svc.getAgentRecord(created.id);
			const policy = a?.skillPolicy;
			return buildSkillsSection({
				skills: scanSkillsMock().map((s: any) => ({ id: s.id, name: s.name, description: s.description })),
				enabledSkills: policy?.enabledSkills,
			});
		};
		const loop = new AgentLoop(makeConfig("s8", closure), [], makeCallbacks());
		registerTurnHooks(sessionDB, loop.registry);
		const prompt = await runOnce(loop);
		// 默认 enabledSkills=[] → 段不出现
		expect(prompt).not.toContain("## Available Skills");
		expect(prompt).not.toContain("## Authoring Skills");
	});
});
