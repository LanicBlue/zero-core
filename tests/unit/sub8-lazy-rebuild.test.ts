// sub-8 acceptance tests:懒重建 + interrupted-status seed.
//
// # 文件说明书
//
// 验收 8 条(acceptance-8.md),逐条对抗判定:
//   懒重建 (1-5):
//     1. restoreAllSessions 只给 incomplete-turn session 建 loop;completed
//        turn 的 session 无 loop(用 seeded delegated task 作探针:getRuntimeTaskTree
//        返 [] 表示无 loop;返 [task] 表示 loop 已建 + 已 seed)。
//     2. activateSession 打开未建 loop 的 session → 建 loop。
//     3. activeSessions 锚定保留:每个 agent 仍指向最近 session。
//     4. 假设审计:getRuntimeTaskTree 在 loop 缺失时不报错(返 [])。
//     5. recovery 不回归:incomplete chat session 仍 auto-resume;delegated
//        不 resume(sessions.phase 留 non-terminal,loop 不被建)。
//   interrupted seed (6-8):
//     6. 冻结子(delegated session + incomplete turn)seed 进父 registry 时
//        status=interrupted。
//     7. 非冻结子不误标:completed/failed/killed 终态 record 即使 childIncomplete
//        也保持原 status;childComplete 的也保持原 status。
//     8. (数据源 seed 正确性 —— restoreDelegatedTasks 对 interrupted seed 带
//        startedAt = createdAt,TaskGet 算 waited 用,sub-4 已实现,这里只验 seed
//        数据正确)。
//
// ## 驱动方式
// 真实 CoreDatabase + AgentService(无 provider,只调 restoreAllSessions /
// activateSession / getRuntimeTaskTree)。不跑 loop.resume(测恢复语义的话另用
// sub8-recovery-resume.test.ts 仿 step-resume)。loop 是否"被建"通过
// getRuntimeTaskTree(sessionId) 是否回填 seeded delegated task 判定 —— loop 存在
// ⇒ restoreDelegatedTasks 已跑 ⇒ tree 非空;loop 不存在 ⇒ tree 为空。
//
// ## steps-overhaul sub-1 schema note
// turn_state 表已合并进 sessions(phase/last_completed_step_seq/source/error/
// turn_count/step_count/token_usage 列)。createTurnState/completeTurnState/
// failTurnState 现在都写 sessions.phase + sessions.updated_at 等。术语
// "turn state" / "incomplete turn" 仍指 sessions.phase 非 'completed'/'failed'。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CoreDatabase } from "../../src/server/core-database.js";
import { AgentService } from "../../src/server/agent-service.js";

// 注:createSession(agentId, title?, context?, options?) —— sessionKind 在第 4
// 参 options.sessionKind,不在第 2 参 title。误用 "chat"/"delegated" 作 title 会把
// sessionKind 留默认 "chat",delegated session 被误当 chat 处理(freeze 失效)。
function createChat(db: CoreDatabase, agentId: string, title = "chat"): string {
	return db.createSession(agentId, title).id;
}
function createDelegated(db: CoreDatabase, agentId: string, title = "delegated"): string {
	return db.createSession(agentId, title, undefined, { sessionKind: "delegated", visibility: "hidden" }).id;
}

// sessions.phase 常量(参考):'pending' / 'streaming' / ... = 非终态(incomplete);
// 'completed' / 'failed' = 终态。getIncompleteTurnSessionIds 只排除终态两类。
// createTurnState 默认写 phase='pending',即 incomplete。

describe("sub-8 lazy rebuild (acceptance #1-#5)", () => {
	let tmp: string;
	let db: CoreDatabase;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zc-sub8-"));
		db = new CoreDatabase(join(tmp, "core.db"));
	});
	afterEach(() => {
		db?.close();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	// 探针:往 chat session 灌一个 delegated task row。若 loop 已建 →
	// getRuntimeTaskTree 回填该 task(非空);loop 未建 → 返 []。这唯一区分
	// "loop 存在但无 task" 与 "loop 不存在"。
	function seedProbeTask(chatId: string, taskId = "probe-1", sessId?: string): void {
		db.createDelegatedTask({
			id: taskId,
			rootTaskId: taskId,
			ownerAgentId: "agent-1",
			targetAgentId: "agent-2",
			parentSessionId: chatId,
			sessionId: sessId,
			task: "probe",
			status: "running",
		});
	}

	function setIncompleteTurn(sessionId: string, turnSeq = 1): void {
		db.createTurnState(sessionId, turnSeq);
		// 默认 createTurnState 写 phase='pending' —— 即非终态,incomplete。
	}

	function setCompletedTurn(sessionId: string, turnSeq = 1): void {
		db.createTurnState(sessionId, turnSeq);
		db.completeTurnState(sessionId, turnSeq);
	}

	test("#1 不 eager 全建:只有 incomplete-turn session 有 loop,completed 的无 loop", async () => {
		const incompleteChat = createChat(db, "agent-1");
		const completedChat = createChat(db, "agent-2");

		setIncompleteTurn(incompleteChat);
		setCompletedTurn(completedChat);

		// 两边都 seed 一个探针 task(若 loop 建则 tree 非空)。
		seedProbeTask(incompleteChat, "t-inc");
		seedProbeTask(completedChat, "t-comp");

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		// incomplete session:loop 已建 → 探针 task 回填。
		const incTree = svc.getRuntimeTaskTree(incompleteChat);
		expect(incTree.map((t) => t.id)).toContain("t-inc");

		// completed session:loop 未建 → tree 空。
		const compTree = svc.getRuntimeTaskTree(completedChat);
		expect(compTree).toEqual([]);
	});

	test("#2 activateSession 按需建 loop:打开未建 loop 的 session 后 tree 回填", async () => {
		const completedChat = createChat(db, "agent-1");
		setCompletedTurn(completedChat);
		seedProbeTask(completedChat, "t-1");

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		// 启动后未 activate → 无 loop → tree 空。
		expect(svc.getRuntimeTaskTree(completedChat)).toEqual([]);

		// activateSession 建 loop(createLoopForSession 内 seed 历史)。
		await svc.activateSession("agent-1", completedChat);

		// loop 已建 + 探针回填。
		const tree = svc.getRuntimeTaskTree(completedChat);
		expect(tree.map((t) => t.id)).toContain("t-1");
	});

	test("#3 activeSessions 锚定保留:每个 agent 指向最近 session", async () => {
		// 一个 agent 多个 session(同 agent 的最近一个应被锚定)。
		// listAllSessions 按 sessions.updated_at DESC —— "最近" = updated_at 最大。
		// 注:steps-overhaul sub-1 后 createTurnState/completeTurnState 现在也写
		// sessions.updated_at(连同 phase/source 等),不再有独立的 turn_state 表。
		// 所以 setCompletedTurn 会刷新 updated_at 到 setCompletedTurn 的调用时刻,
		// 同毫秒建的 session 仍会 tie → 顺序不稳。这里用显式 updated_at 写入锁死
		// 顺序(setCompletedTurn 之后再 UPDATE,覆盖其时间戳)。
		const a1older = createChat(db, "agent-1");
		const a1recent = createChat(db, "agent-1");
		const a2recent = createChat(db, "agent-2");
		setCompletedTurn(a1older);
		setCompletedTurn(a1recent);
		setCompletedTurn(a2recent);

		// 显式锁 updated_at(setCompletedTurn 之后写,覆盖其时间戳):
		// a1recent > a1older(agent-1 下 a1recent 最近);a2recent 任意值
		// (agent-2 只一个 session)。
		const setUpdatedAt = (sid: string, iso: string) =>
			db.getDb().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(iso, sid);
		setUpdatedAt(a1older, "2026-01-01T00:00:00.000Z");
		setUpdatedAt(a1recent, "2026-06-01T00:00:00.000Z");
		setUpdatedAt(a2recent, "2026-06-01T00:00:00.000Z");

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		const active = svc.getActiveSessionsMap();
		// listAllSessions 按 updated_at DESC → 同 agent 第一个 = 最近。
		// 每个 agent 应锚定到最近 session(非 oldest)。
		expect(active.get("agent-1")).toBe(a1recent);
		expect(active.get("agent-2")).toBe(a2recent);
	});

	test("#4 假设审计:getRuntimeTaskTree 在 loop 未建时不报错,返 []", async () => {
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		// 从未存在的 session / 任何未 activate 的 session 取 tree 都不应抛。
		expect(() => svc.getRuntimeTaskTree("never-existed")).not.toThrow();
		expect(svc.getRuntimeTaskTree("never-existed")).toEqual([]);
	});

	test("#5 recovery 不回归:incomplete chat session 仍 auto-resume;delegated 不 resume", async () => {
		// 关键回归点(acceptance #5 + sub-3 行为):delegated session 即便有
		// incomplete turn 也不被 doRecoverIncompleteSessions resume;chat session
		// 仍 resume。
		//
		// 信号:markRunning(sessionId, agentId) 在 loop.resume 前 sync 触发,emit
		// "session_running" 事件带 sessionId。我们 capture 所有 session_running 事件,
		// 断言 chat sessionId 出现(resume 触发)、delegated sessionId 不出现(frozen
		// 跳过)。
		const chatIncomplete = createChat(db, "agent-1");
		const delegatedIncomplete = createDelegated(db, "agent-2");

		setIncompleteTurn(chatIncomplete);
		setIncompleteTurn(delegatedIncomplete);

		const svc = new AgentService(tmp, db);

		const resumed: Set<string> = new Set();
		const unsub = svc.subscribe((ev) => {
			if (ev.type === "session_running" && typeof ev.sessionId === "string") {
				resumed.add(ev.sessionId);
			}
		});

		await svc.restoreAllSessions();
		// 触发 doRecoverIncompleteSessions 的 gate(providers + agentStore + pmService)。
		svc.setProviders([], undefined, undefined);
		// AgentStore 最小 stub:list/get/onChange(setAgentStore 注册 onChange 监听)。
		// 此处只验 resume-跳过,agent identity 不重要。
		svc.setAgentStore({
			list: () => [],
			get: () => undefined,
			onChange: () => () => {},
		} as any);
		svc.setPmService({}, {});
		svc.recoverIncompleteSessions();
		// 等事件 settle(markRunning sync 触发,但 loop.resume fire-and-forget;
		// session_running 在 resume 调用前已 emit,微任务轮即可)。
		await new Promise((r) => setTimeout(r, 50));
		unsub();

		// chat session 触发 session_running(被 resume)。
		expect(resumed.has(chatIncomplete), "chat session must be resumed").toBe(true);
		// delegated session 不触发 session_running(frozen,sub-3 跳过 resume)。
		expect(resumed.has(delegatedIncomplete), "delegated session must NOT be resumed (frozen)").toBe(false);
	});
});

describe("sub-8 interrupted-status seed (acceptance #6-#8)", () => {
	let tmp: string;
	let db: CoreDatabase;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zc-sub8-seed-"));
		db = new CoreDatabase(join(tmp, "core.db"));
	});
	afterEach(() => {
		db?.close();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	// restoreDelegatedTasks 是 AgentLoop 的方法,但其逻辑纯粹(读 db +
	// registry.seed),不依赖 loop 完整初始化。我们通过 AgentService.activateSession
	// 拉起父 chat loop(触发 createLoopForSession → restoreDelegatedTasks),
	// 然后读 getRuntimeTaskTree 验 seed status。父 chat loop 必须 activate 才建
	// (sub-8 懒重建)。

	function setupParentChatWithChild(childSessId: string, childStatus: any, childHasIncompleteTurn: boolean): string {
		const parentChat = createChat(db, "parent-agent");
		// 父 chat 自己有 completed turn(避免父自己被当成 incomplete → 直接建 loop)。
		db.createTurnState(parentChat, 1);
		db.completeTurnState(parentChat, 1);

		// 子 delegated session + 它的 turn state(incomplete 或 completed)。
		// steps-overhaul sub-1:turn state 合并进 sessions.phase/source 等。
		// session_kind 通过 createDelegated helper 写(options.sessionKind='delegated');
		// 子 session 由调用方建好传入。

		// delegated task row 指向子 session(restoreDelegatedTasks 用 rec.sessionId
		// 查 sessions.phase 判 incomplete)。
		db.createDelegatedTask({
			id: "task-x",
			rootTaskId: "task-x",
			ownerAgentId: "parent-agent",
			targetAgentId: "child-agent",
			parentSessionId: parentChat,
			sessionId: childSessId,
			task: "do thing",
			status: childStatus,
		});

		if (childHasIncompleteTurn) {
			db.createTurnState(childSessId, 1);
			// phase 默认 'pending' = incomplete。
		} else {
			db.createTurnState(childSessId, 1);
			db.completeTurnState(childSessId, 1);
		}
		return parentChat;
	}

	test("#6 冻结子(delegated + incomplete turn)seed 时 status=interrupted", async () => {
		const child = createDelegated(db, "child-agent");
		const parentId = setupParentChatWithChild(child, "running", true);

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		// 父 chat 自身 turn completed → 启动不建 loop。activate 父 chat 建 loop,
		// 触发 restoreDelegatedTasks → seed。
		await svc.activateSession("parent-agent", parentId);

		const tree = svc.getRuntimeTaskTree(parentId);
		const task = tree.find((t) => t.id === "task-x");
		expect(task, "task should be seeded").toBeDefined();
		expect(task!.status).toBe("interrupted");
	});

	test("#6b 父 chat 直接 incomplete 时,loop 启动即建,seed 仍标 interrupted", async () => {
		// 补例:父 chat 自身也 incomplete(典型恢复场景)。restoreAllSessions
		// 建父 loop → seed 子为 interrupted。
		const parentChat = createChat(db, "parent-agent");
		const child = createDelegated(db, "child-agent");
		db.createTurnState(parentChat, 1); // 父 incomplete → loop 启动建
		db.createTurnState(child, 1); // 子 incomplete → frozen

		db.createDelegatedTask({
			id: "task-y",
			rootTaskId: "task-y",
			ownerAgentId: "parent-agent",
			targetAgentId: "child-agent",
			parentSessionId: parentChat,
			sessionId: child,
			task: "do",
			status: "running",
		});

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		const tree = svc.getRuntimeTaskTree(parentChat);
		const task = tree.find((t) => t.id === "task-y");
		expect(task, "task should be seeded").toBeDefined();
		expect(task!.status).toBe("interrupted");
	});

	test("#7 非冻结子不误标:终态 record(childIncomplete)保持原 status", async () => {
		// 关键负例:子 session incomplete 但 task record 已是 completed/failed/killed
		// → 必须保持原 status,不被误标 interrupted。
		const statuses = ["completed", "failed", "killed"] as const;
		for (const st of statuses) {
			const parentChat = createChat(db, `p-${st}`);
			const child = createDelegated(db, `c-${st}`);
			db.createTurnState(parentChat, 1);
			db.completeTurnState(parentChat, 1);
			db.createTurnState(child, 1); // child incomplete(frozen)
			// 但 task record 已终态:
			db.createDelegatedTask({
				id: `task-${st}`,
				rootTaskId: `task-${st}`,
				ownerAgentId: `p-${st}`,
				targetAgentId: `c-${st}`,
				parentSessionId: parentChat,
				sessionId: child,
				task: "x",
				status: st,
			});

			const svc = new AgentService(tmp, db);
			await svc.restoreAllSessions();
			await svc.activateSession(`p-${st}`, parentChat);

			const tree = svc.getRuntimeTaskTree(parentChat);
			const task = tree.find((t) => t.id === `task-${st}`);
			expect(task, `task for status=${st} should be seeded`).toBeDefined();
			expect(task!.status, `terminal record must keep status=${st}, not be mislabeled interrupted`).toBe(st);
			svc.shutdown?.();
		}
	});

	test("#7b 非冻结子不误标:childComplete(running record)保持 running", async () => {
		// 另一负例:子 session 没 incomplete(turn completed),task record 仍 running
		// → 不应被标 interrupted(子不冻结,无中断语义)。
		const parentChat = createChat(db, "p");
		const child = createDelegated(db, "c");
		db.createTurnState(parentChat, 1);
		db.completeTurnState(parentChat, 1);
		db.createTurnState(child, 1);
		db.completeTurnState(child, 1); // child turn completed

		db.createDelegatedTask({
			id: "task-cc",
			rootTaskId: "task-cc",
			ownerAgentId: "p",
			targetAgentId: "c",
			parentSessionId: parentChat,
			sessionId: child,
			task: "x",
			status: "running",
		});

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		await svc.activateSession("p", parentChat);

		const tree = svc.getRuntimeTaskTree(parentChat);
		const task = tree.find((t) => t.id === "task-cc");
		expect(task, "task should be seeded").toBeDefined();
		expect(task!.status, "running record over childComplete must stay running").toBe("running");
	});

	test("#7c interrupted record + childComplete 保持 interrupted(不被改成 running)", async () => {
		// 边界:record 已 interrupted,childComplete —— 应保持 interrupted
		// (实现:rec.status==='interrupted' 在 non-frozen 分支落 default 保持)。
		const parentChat = createChat(db, "p");
		const child = createDelegated(db, "c");
		db.createTurnState(parentChat, 1);
		db.completeTurnState(parentChat, 1);
		db.createTurnState(child, 1);
		db.completeTurnState(child, 1);

		db.createDelegatedTask({
			id: "task-ic",
			rootTaskId: "task-ic",
			ownerAgentId: "p",
			targetAgentId: "c",
			parentSessionId: parentChat,
			sessionId: child,
			task: "x",
			status: "interrupted",
		});

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		await svc.activateSession("p", parentChat);

		const tree = svc.getRuntimeTaskTree(parentChat);
		const task = tree.find((t) => t.id === "task-ic");
		expect(task).toBeDefined();
		expect(task!.status).toBe("interrupted");
	});

	test("#8 seed startedAt = Date.parse(createdAt):TaskGet waited 数据源正确", async () => {
		// 验证 seed 的 startedAt 来自 record.createdAt(parse)。TaskGet(interrupted)
		// 算 waited = now - startedAt;startedAt 错 → waited 错。这里只验 seed 数据源。
		const parentChat = createChat(db, "p");
		const child = createDelegated(db, "c");
		db.createTurnState(parentChat, 1);
		db.completeTurnState(parentChat, 1);
		db.createTurnState(child, 1); // child incomplete

		// createdAt 由 createDelegatedTask 写 now()。读回 record 拿到真实 ISO。
		db.createDelegatedTask({
			id: "task-t",
			rootTaskId: "task-t",
			ownerAgentId: "p",
			targetAgentId: "c",
			parentSessionId: parentChat,
			sessionId: child,
			task: "x",
			status: "running",
		});
		const rec = db.getDelegatedTask("task-t")!;
		const expectedStartedAt = Date.parse(rec.createdAt);

		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		await svc.activateSession("p", parentChat);

		const tree = svc.getRuntimeTaskTree(parentChat);
		const task = tree.find((t) => t.id === "task-t");
		expect(task).toBeDefined();
		// seed 时 status 应是 interrupted(child incomplete)。
		expect(task!.status).toBe("interrupted");
		// startedAt 必须 = Date.parse(rec.createdAt)(TaskGet 算 waited 的数据源)。
		expect(task!.startedAt).toBe(expectedStartedAt);
		expect(task!.startedAt).toBeGreaterThan(0);
	});
});
