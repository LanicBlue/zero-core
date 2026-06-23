// E2E 测试：反复切换「多条历史消息」的会话不产生 DOM 累积
//
// # 文件说明书
//
// ## 核心功能
// 复现并守住：当 session 含多条 user 历史（经 session_init 从 DB 加载，消息 id
// 形如 m${turnGroup}）时，反复 A↔B 切换不能让 DOM 里的 user 气泡数超过 store。
//
// 触发条件（session-switch.spec.ts 漏掉的）：
//   1) 每个 session 有 ≥2 条 user 消息（多个 turn group）→ 后端 buildStepLevelMessages
//      给同 group 的 user/assistant 都赋同一个 id `m${tg}`，造成 React key 重复。
//   2) 反复切换多次 → React 按重复 key 对账时残留旧 DOM 节点，DOM user 数 > store。
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

async function switchToFirstNonActiveSession(window: import("@playwright/test").Page): Promise<void> {
	await window.locator(".btn-sessions").click();
	const sessionItems = window.locator(".session-item");
	const count = await sessionItems.count();
	for (let i = 0; i < count; i++) {
		const item = sessionItems.nth(i);
		const isActive = await item.evaluate((el) => el.classList.contains("active"));
		if (!isActive) {
			await item.locator(".session-item-label").click();
			await window.waitForFunction(() => {
				const el = document.querySelector(".chat-panel");
				return el && el.getAttribute("data-session-id") !== "";
			}, { timeout: 10_000 });
			return;
		}
	}
	throw new Error("No non-active session to switch to");
}

async function domUserCount(window: import("@playwright/test").Page): Promise<number> {
	return window.locator(".message.message-user").count();
}

async function storeUserCount(window: import("@playwright/test").Page): Promise<number> {
	return window.evaluate(() => {
		const s = (window as any).__chatStore?.getState?.();
		if (!s) return -1;
		const sid = s.activeSessionId;
		const msgs = sid ? (s.messagesBySession[sid] ?? []) : [];
		return msgs.filter((m: any) => m.role === "user").length;
	});
}

// Return all message ids in the active session bucket. React keys must be
// unique within a list; the old backend gave user+assistant in the same
// turnGroup the SAME id (`m${tg}`), which broke reconciliation on switch.
async function storeMessageIds(window: import("@playwright/test").Page): Promise<string[]> {
	return window.evaluate(() => {
		const s = (window as any).__chatStore?.getState?.();
		if (!s) return [];
		const sid = s.activeSessionId;
		const msgs = sid ? (s.messagesBySession[sid] ?? []) : [];
		return msgs.map((m: any) => m.id);
	});
}

test.describe("Repeated switching of multi-message sessions", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("A(4 msgs) ↔ B(3 msgs) repeated switch: DOM user count == store user count", async () => {
		// Build up multi-message history in A (4 user messages → turn groups).
		for (let i = 1; i <= 4; i++) {
			await sendChatMessage(window, `A${i}`);
		}
		expect(await storeUserCount(window)).toBe(4);

		// Create B and put 3 user messages in it.
		await window.locator(".btn-new-session").click();
		await expect(window.locator(".chat-empty")).toBeVisible();
		for (let i = 1; i <= 3; i++) {
			await sendChatMessage(window, `B${i}`);
		}
		expect(await storeUserCount(window)).toBe(3);

		// Repeatedly switch. Each landing must have DOM user count exactly equal
		// to that session's store user count — never more.
		for (let i = 0; i < 10; i++) {
			await switchToFirstNonActiveSession(window);
			await window.waitForTimeout(150);
			const dom = await domUserCount(window);
			const store = await storeUserCount(window);
			expect(dom, `iter ${i}: DOM user (${dom}) must equal store user (${store})`).toBe(store);

			// Root-cause guard (only meaningful after session_init has replaced
			// the optimistic numeric ids with DB-sourced `u${tg}`/`a${tg}` ids,
			// which happens once we've switched away and back). Every message id
			// in the bucket MUST be unique — the old backend gave user+assistant
			// in the same group the SAME id (`m${tg}`), producing duplicate React
			// keys and stale DOM bubbles on switch.
			if (i >= 1) {
				const ids = await storeMessageIds(window);
				const dupes = ids.filter((id, k) => ids.indexOf(id) !== k);
				expect(dupes, `iter ${i}: duplicate message ids ${JSON.stringify(dupes)}`).toEqual([]);
			}
		}
	});
});
