// 单元测试:重启后委派任务树恢复(DB → runtime,在 loop 创建时回填)
//
// # 文件说明书
//
// ## 核心功能
// 锁死:读路径 getRuntimeTaskTree 保持纯内存(单源,含 bash 后台任务);重启恢复
// 发生在 loop 创建时 —— createLoopForSession 把该 chat session 的 delegated_tasks
// 行(parent_session_id 根 + root_task_id 子树)经 loop.restoreDelegatedTasks 灌进
// live TaskRegistry。所以 restoreAllSessions 后无 live sub-loop,内存树仍能映出历史。
//
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CoreDatabase } from "../../src/server/core-database.js";
import { AgentService } from "../../src/server/agent-service.js";

describe("delegated task restart restore (DB → runtime at loop creation)", () => {
	let tmp: string;
	let db: CoreDatabase;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "zc-tasktree-"));
		db = new CoreDatabase(join(tmp, "core.db"));
	});
	afterEach(() => {
		db?.close();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	test("restoreAllSessions seeds a chat session's task tree from delegated_tasks", async () => {
		const chat = db.createSession("agent-1", "chat");
		db.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: chat.id, task: "do X",
		});
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		// sub-8 lazy rebuild (design §2.4): a chat session with no incomplete
		// turn gets NO loop at startup, so the seeded task tree is not visible
		// until the session is activated (which builds the loop on demand).
		expect(svc.getRuntimeTaskTree(chat.id)).toEqual([]);
		await svc.activateSession("agent-1", chat.id);

		const tree = svc.getRuntimeTaskTree(chat.id);
		expect(tree.map((t) => t.id)).toEqual(["t1"]);
		expect(tree[0].type).toBe("subagent");
		expect(tree[0].status).toBe("running");
	});

	test("nested sub-agents restored via root_task_id expansion", async () => {
		const chat = db.createSession("agent-1", "chat");
		db.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: chat.id, task: "root",
		});
		// Nested child: parent_session_id is a delegated session, NOT the chat,
		// so only the root_task_id expansion pulls it into the chat session's tree.
		db.createDelegatedTask({
			id: "t2", parentTaskId: "t1", rootTaskId: "t1", ownerAgentId: "dev",
			targetAgentId: "rev", task: "child", depth: 2,
		});
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		// sub-8 lazy rebuild (design §2.4): no loop at startup → tree empty
		// until activateSession pulls the loop (which seeds the delegated tree).
		expect(svc.getRuntimeTaskTree(chat.id)).toEqual([]);
		await svc.activateSession("agent-1", chat.id);

		const tree = svc.getRuntimeTaskTree(chat.id);
		expect(tree.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
	});

	test("terminal status (interrupted/completed) is preserved on restore", async () => {
		const chat = db.createSession("agent-1", "chat");
		db.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: chat.id, task: "x",
			status: "interrupted",
		});
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();

		// sub-8 lazy rebuild (design §2.4): no loop at startup → tree empty.
		expect(svc.getRuntimeTaskTree(chat.id)).toEqual([]);
		await svc.activateSession("agent-1", chat.id);

		const tree = svc.getRuntimeTaskTree(chat.id);
		expect(tree[0].status).toBe("interrupted");
	});

	test("a session with no persisted tasks stays empty", async () => {
		const chat = db.createSession("agent-1", "chat");
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		expect(svc.getRuntimeTaskTree(chat.id)).toEqual([]);
	});

	test("bash background tasks are not restored (not persisted) — memory-only", async () => {
		// Bash bg tasks live only in the in-memory registry; they have no
		// delegated_tasks row, so restart correctly drops them. Verified by the
		// absence of any non-subagent type after restore.
		const chat = db.createSession("agent-1", "chat");
		const svc = new AgentService(tmp, db);
		await svc.restoreAllSessions();
		const tree = svc.getRuntimeTaskTree(chat.id);
		expect(tree.every((t) => t.type === "subagent")).toBe(true);
	});
});
