// E2E test: session archive model.
//
// This spec replaces the four obsolete session-switch / session-delete /
// session-streaming-restore specs, which targeted the removed manual
// A->B->A multi-session switcher (selectors .btn-new-session /
// .btn-sessions / .session-item no longer exist in the renderer).
//
// The current model is "archive": the ChatPanel exposes a single
// .btn-archive-session. Archiving soft-deletes the active session
// (the row is kept, marked archived=1) and the backend hands the agent
// a fresh, clean session of the same project as the active one. There is
// no session list / dropdown / switch UI anymore.
//
// Three guarantees this spec locks down:
//   1. Archiving the active session activates a fresh (empty) session.
//   2. The archived session's messages survive in the store (soft delete).
//   3. Archiving mid-stream cleanly interrupts the stream and yields a
//      fresh session.
//
// # File sheet
// Core: archive flow (active -> archived + new clean session)
// Input: fixtures/simple-response.json (mock provider)
// Output: Playwright tests x3
// Location: tests/e2e/
// Deps: @playwright/test, ./helpers/test-app
// Maintenance: confirm-button text is "归档" (ConfirmModal confirmLabel,
//              rendered via .btn-danger — see ChatPanel.tsx + ConfirmModal.tsx)

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

// ConfirmModal (src/renderer/components/common/ConfirmModal.tsx) renders the
// confirm button with class .btn-danger and the label text passed via
// confirmLabel. ChatPanel passes confirmLabel="归档" for the archive dialog.
const ARCHIVE_CONFIRM = ".modal-confirm button.btn-danger";

test.describe("Session archive model", () => {
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

	test("archiving the active session activates a fresh empty session", async () => {
		// Seed a conversation so the panel has a real session id to archive.
		await sendChatMessage(window, "first message");
		await expect(window.locator(".message.message-user")).toHaveCount(1);
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);

		const panel = window.locator(".chat-panel");
		const oldId = await panel.getAttribute("data-session-id");
		expect(oldId).toBeTruthy();

		// Open the archive confirm dialog and confirm.
		await window.locator(".btn-archive-session").click();
		await expect(window.locator(ARCHIVE_CONFIRM)).toBeVisible();
		await window.locator(ARCHIVE_CONFIRM).click();

		// The active session id flips to the replacement. We wait on the id
		// change (not on .chat-empty) because the renderer clears the old
		// session's messages before flipping activeSessionId, so .chat-empty
		// can appear transiently under the OLD id during the archive sequence.
		const newId = await window.waitForFunction(
			(prev) => {
				const el = document.querySelector(".chat-panel");
				const id = el?.getAttribute("data-session-id") ?? "";
				return id && id !== prev ? id : "";
			},
			oldId,
			{ timeout: 15_000 },
		).then((r) => r.jsonValue());
		expect(newId).not.toBe(oldId);

		// Once the replacement is active, the panel must show the empty state.
		await expect(window.locator(".chat-empty")).toBeVisible();
	});

	test("archived session messages survive in the store (soft delete)", async () => {
		await sendChatMessage(window, "first message");
		await expect(window.locator(".message.message-assistant")).toHaveCount(1);

		const oldId = await window.locator(".chat-panel").getAttribute("data-session-id");
		expect(oldId).toBeTruthy();

		// Archive.
		await window.locator(".btn-archive-session").click();
		await window.locator(ARCHIVE_CONFIRM).click();
		// Wait for the replacement session to take over (see test 1 for why
		// we gate on the id change rather than .chat-empty).
		await window.waitForFunction(
			(prev) => {
				const el = document.querySelector(".chat-panel");
				const id = el?.getAttribute("data-session-id") ?? "";
				return id && id !== prev ? id : "";
			},
			oldId!,
			{ timeout: 15_000 },
		);

		// Resolve the active agent id from the dropdown, then query both the
		// active list (archived = 0 filter in SessionDB.listSessions) and the
		// archived session's init payload directly.
		const agentId = await window.locator(".chat-agent-select").first().inputValue();

		const activeSessions: { id: string }[] = await window.evaluate(
			([aid]) => (window as any).api.sessionsList(aid),
			[agentId],
		);
		const activeIds = activeSessions.map((s) => s.id);
		expect(activeIds).not.toContain(oldId);

		// The archived session row + its messages must still be retrievable
		// via the pull-on-display init endpoint (soft delete, not hard).
		const initPayload = await window.evaluate(
			([sid]) => (window as any).api.sessionsGetInit(sid),
			[oldId],
		);
		expect(initPayload).toBeTruthy();
		const archivedMessages: unknown[] = initPayload?.messages ?? [];
		// At least the user message we sent should be retained.
		expect(archivedMessages.length).toBeGreaterThan(0);
	});

	test("archiving mid-stream cleanly interrupts and starts a fresh session", async () => {
		// Kick off a message but don't wait for streaming to finish.
		await window.locator(".chat-input-bar textarea").fill("streaming message");
		await window.locator(".chat-input-bar button:not(.btn-abort)").click();

		// Wait until streaming is visibly in progress.
		await expect(window.locator(".cursor-blink")).toBeAttached({ timeout: 10_000 });

		const oldId = await window.locator(".chat-panel").getAttribute("data-session-id");
		expect(oldId).toBeTruthy();

		// Archive while streaming.
		await window.locator(".btn-archive-session").click();
		await window.locator(ARCHIVE_CONFIRM).click();

		// The streaming cursor must be gone (stream aborted).
		await expect(window.locator(".cursor-blink")).toHaveCount(0);

		// And a fresh, empty session is active (wait on the id flip — see
		// test 1 for why .chat-empty alone is not a reliable gate).
		const newId = await window.waitForFunction(
			(prev) => {
				const el = document.querySelector(".chat-panel");
				const id = el?.getAttribute("data-session-id") ?? "";
				return id && id !== prev ? id : "";
			},
			oldId!,
			{ timeout: 15_000 },
		).then((r) => r.jsonValue());
		expect(newId).not.toBe(oldId);
		await expect(window.locator(".chat-empty")).toBeVisible();
	});
});
