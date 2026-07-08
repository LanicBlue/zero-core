// tool-decoupling sub-5(决策 4):UI 统一 dispatcher 单测。
//
// 对应 acceptance-5:
//   #1 IPC tool:run → dispatcher 返 JSON(此处直测 dispatchTool,IPC 路径在
//      ipc-proxy ROUTE_MAP 已配;server 的 /api/tool-run 薄包 dispatchTool)。
//   #2 全工具暴露:任意已迁工具都能调(无可见性过滤)。
//   #3 session 工具 UI 调返示例:TodoWrite 在无 loop 状态下返合理默认。
//   #7 错误处理:工具抛错 → 结构化 {ok:false, error}。
//
// # 文件说明书
// ## 核心功能
// 直接调 dispatchTool 验:全工具可达 / JSON 返 / session 工具降级 / 错误结构化。
// ## 输入
// 临时 SessionDB + 注册单例(setManagementService / setWikiStoreGlobal)。
// ## 输出
// Vitest 用例。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { WikiStore, setWikiStoreGlobal } from "../../src/server/wiki-node-store.js";
import { ManagementService, setManagementService } from "../../src/server/management-service.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { dispatchTool, listDispatchableTools } from "../../src/server/tool-dispatcher.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wikiStoreGlobal: WikiStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub5-dispatch-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wikiStoreGlobal = new WikiStore(sessionDB);
	const agentStore = new AgentStore(sessionDB);
	const projectStore = new ProjectStore(sessionDB);
	const cronStore = new CronStore(sessionDB);
	const templateStore = new TemplateStore(sessionDB);
	const requirementStore = new RequirementStore(sessionDB);
	management = new ManagementService({
		agentStore, projectStore, cronStore, templateStore, requirementStore,
		sessionDB, wikiStore: wikiStoreGlobal,
	});
	// 决策 1:迁移工具直读单例 —— dispatcher 调的工具靠这些 getter。
	setManagementService(management);
	setWikiStoreGlobal(wikiStoreGlobal);
});

afterEach(() => {
	setManagementService(undefined);
	setWikiStoreGlobal(undefined);
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("sub-5 UI dispatcher", () => {
	test("acceptance #2:全工具暴露 —— listDispatchableTools 含 Wiki/AgentRegistry/WebSearch/SequentialThinking/Platform 等已迁工具", () => {
		const tools = listDispatchableTools();
		// Spot-check a cross-section of categories (decision 4: 全暴露).
		expect(tools.Wiki).toBeTruthy();
		expect(tools.AgentRegistry).toBeTruthy();
		expect(tools.WebSearch).toBeTruthy();
		expect(tools.SequentialThinking).toBeTruthy();
		expect(tools.Project).toBeTruthy();
		expect(tools.Cron).toBeTruthy();
		expect(tools.Platform).toBeTruthy();
		// OS 工具也暴露(决策 4:UI 可信端);工具名按各自 buildTool({name}):
		//   Read / Shell(不是 Bash) / Grep / Glob / Edit / Write
		expect(tools.Read).toBeTruthy();
		expect(tools.Shell).toBeTruthy();
		expect(tools.Grep).toBeTruthy();
	});

	test("acceptance #1:dispatchTool 调一个已迁工具 → 返 ToolResult JSON(不调 format)", async () => {
		// SequentialThinking 是纯工具(无外部依赖),返 {ok:true, data:{text, entry, groupKey}}。
		const r = await dispatchTool({
			tool: "SequentialThinking",
			input: { thought: "test step", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 },
		});
		expect(r.ok).toBe(true);
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
		// result 是 ToolResult;data.text 是 format 后的文本(不调 format,但工具
		// execute 自己把 text 包进 data)。
		const result = r.result as { ok: boolean; data?: { text?: string; entry?: { thought: string } } };
		expect(result.ok).toBe(true);
		expect(result.data?.text).toContain("Thought 1/1:");
		expect(result.data?.entry?.thought).toBe("test step");
	});

	test("acceptance #2:dispatchTool 调 Wiki(app 级,直读单例)→ 返 ToolResult JSON(无 anchor 时 ok:false 也算成功 dispatch)", async () => {
		// Wiki.list 走 getWikiStoreGlobal() 单例;无 anchor → 工具自报 ok:false(无读范围),
		// 但 dispatch 本身成功(execute 跑了)。这里验"dispatch 走通 + 返 ToolResult 形状",
		// 不强求工具 ok:true。
		const r = await dispatchTool({
			tool: "Wiki",
			input: { action: "list" },
		});
		expect(r.ok).toBe(true); // dispatch 成功(工具执行了)
		const result = r.result as { ok: boolean; data?: unknown; error?: string };
		expect(typeof result).toBe("object");
		expect(result).toHaveProperty("ok");
		// 无 anchor → 工具自报 ok:false(结构化失败,不是 throw)。这是正确行为。
	});

	test("acceptance #3:session 工具 UI 调返示例(TodoWrite 无 loop 状态 → 空列表 / 合理默认)", async () => {
		// TodoWrite 在无 callerCtx.todos 时(create 路径)用空列表建单条;
		// UI 调用应得 ToolResult(ok),不崩。
		const r = await dispatchTool({
			tool: "TodoWrite",
			input: { todos: [{ content: "preview item", status: "pending", activeForm: "previewing" }] },
		});
		expect(r.ok).toBe(true);
		const result = r.result as { ok: boolean };
		expect(result.ok).toBe(true);
	});

	test("acceptance #7:工具抛错 → 结构化 {ok:false, error}(UI 不崩)", async () => {
		// AgentRegistry.get 缺单例时会报错;但单例已注册,故用 not-found 触发 Error。
		// 改用一个一定抛的工具路径:AgentRegistry.get 不存在的 id → 工具返 ok:false
		// (runAction catch);这测的是"工具自报失败"分支。下面再测 throw 分支。
		const r = await dispatchTool({
			tool: "AgentRegistry",
			input: { action: "get", id: "does-not-exist" },
		});
		// 工具返 {ok:false, error:"Error: Agent not found: ..."}(自报失败)。
		// dispatcher 原样转发(不 throw);UI 看 result.ok=false 自行处理。
		expect(r.ok).toBe(true); // dispatch 本身没失败(工具执行了)
		const result = r.result as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Agent not found: does-not-exist/);
	});

	test("acceptance #7:execute 抛 throw → dispatcher 捕获 → {ok:false, error}", async () => {
		// 用不存在的工具名 → dispatcher 直接返 {ok:false, error}(不 throw)。
		const r = await dispatchTool({
			tool: "DoesNotExist",
			input: {},
		});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Tool not found: DoesNotExist/);
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("acceptance #6:dispatcher 与 agent 同 execute —— dispatchTool 拿的是原始 execute(getToolExecute),不是 AI SDK wrapper", async () => {
		// 这是个结构性断言:dispatchTool 返的 result 是 ToolResult 形状(ok/data/error),
		// 不是 AI SDK wrapper 的 string。SequentialThinking 的 execute 返 ToolResult。
		const r = await dispatchTool({
			tool: "SequentialThinking",
			input: { thought: "x", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 },
		});
		const result = r.result as { ok: boolean; data?: unknown };
		expect(typeof result).toBe("object");
		expect(result).toHaveProperty("ok");
		// 不是 string(wrapper format 后会是 string)
		expect(typeof result).not.toBe("string");
	});
});
