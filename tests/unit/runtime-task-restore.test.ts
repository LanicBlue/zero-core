// 单元测试:重启后委派任务树恢复(getRuntimeTaskTree 的 live ⊕ DB 合并)
//
// # 文件说明书
//
// ## 核心功能
// 锁死:getRuntimeTaskTree(sessionId) 在无 live loop 时仍返回持久化的
// delegated_tasks 行(重启恢复),嵌套子代理按 rootTaskId 整树展开;live loop
// 存在时其条目覆盖同 id 的 DB 行(running 实时态优先)并补上 DB 没有的 bash
// 后台任务。这是 ADR-024 持久化补的"重启回填"环节。
//
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/server/session-db.js";
import { AgentService } from "../../src/server/agent-service.js";

describe("AgentService.getRuntimeTaskTree — live ⊕ DB merge (restart restore)", () => {
	let tmp: string | undefined;
	let db: SessionDB | undefined;
	let svc: AgentService | undefined;

	function fresh(): void {
		tmp = mkdtempSync(join(tmpdir(), "zc-tasktree-"));
		db = new SessionDB(join(tmp, "sessions.db"));
		svc = new AgentService(tmp, db);
	}

	afterEach(() => {
		db?.close();
		db = undefined;
		svc = undefined;
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	test("returns persisted delegated tasks when no live loop exists (restart)", () => {
		fresh();
		db!.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: "chat-1", task: "do X",
		});
		const tree = svc!.getRuntimeTaskTree("chat-1");
		expect(tree.map((t) => t.id)).toEqual(["t1"]);
		expect(tree[0].type).toBe("subagent");
		expect(tree[0].status).toBe("running");
	});

	test("expands nested sub-agents via rootTaskId (sub-agent of sub-agent)", () => {
		fresh();
		db!.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: "chat-1", task: "root",
		});
		// Nested child: parent_session_id is a delegated session, NOT chat-1, so
		// only the rootTaskId expansion pulls it in.
		db!.createDelegatedTask({
			id: "t2", parentTaskId: "t1", rootTaskId: "t1", ownerAgentId: "dev",
			targetAgentId: "rev", task: "child", depth: 2,
		});
		const tree = svc!.getRuntimeTaskTree("chat-1");
		expect(tree.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
	});

	test("empty for a session with no persisted tasks and no live loop", () => {
		fresh();
		expect(svc!.getRuntimeTaskTree("chat-empty")).toEqual([]);
	});

	test("live loop entries overlay DB (running wins over completed) and add bash bg tasks", () => {
		fresh();
		db!.createDelegatedTask({
			id: "t1", rootTaskId: "t1", ownerAgentId: "lead",
			targetAgentId: "dev", parentSessionId: "chat-1", task: "x",
			status: "completed",
		});
		// Inject a fake live loop: t1 still running (overrides DB completed) plus
		// a bash background task that is live-only (not in delegated_tasks).
		(svc as any).loops.set("chat-1", {
			getRuntimeTaskTree: () => [
				{ id: "t1", type: "subagent", task: "x", status: "running", step: 3, turns: 5, tokens: 100, startedAt: 1 },
				{ id: "b1", type: "bash", task: "sleep 10", status: "running", step: 0, turns: 0, tokens: 0, startedAt: 2 },
			],
		});
		const tree = svc!.getRuntimeTaskTree("chat-1");
		const byId = new Map(tree.map((t) => [t.id, t]));
		expect(byId.get("t1")!.status).toBe("running"); // live overrides DB
		expect(byId.has("b1")).toBe(true); // bash bg task added (live-only)
	});
});
