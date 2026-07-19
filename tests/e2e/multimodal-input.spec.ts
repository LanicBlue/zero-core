// E2E 测试:多模态输入全链路(multimodal-input sub-7)
//
// # 文件说明书
//
// ## 核心功能
// 覆盖多模态输入从入口(粘贴/+号)→ 落盘 → 发送 → mock provider 收到正确 content
// shape(inline image vs 元信息文本)→ 历史附件缩略图显示 → context-usage 模态标识
// → 仅附件无文本可发送 的完整链路。
//
// ## 场景(对应 acceptance-7)
// 1. 粘贴图片 → 待发送区缩略图 → 发送 → mock 支持 provider(multimodal=true)
//    收到 inline image content(mock 捕获的 prompt 含 image/* file part)。
// 2. 不支持 provider(multimodal=false)→ 收到元信息文本(无 image part,
//    有含 attachment 元信息的 text part)。
// 3. 发送后切走再切回 → 历史附件缩略图经 attachments:content 端点正常显示。
// 4. context-usage 条旁模态标识三态(支持 🖼 image / 未知 模态未知 / 不支持 无标识)。
// 5. 仅附件无文本可发送(无文本 + 有附件,Send 不禁用,发出)。
// 6. +号导入 / 粘贴 两入口(拖拽 Playwright 难稳定模拟,以 +号 + 粘贴 覆盖;
//    拖拽逻辑(ingestFiles)与 +号 共代码,单测已覆盖)。
//
// ## mock provider 捕获机制
// createMockLanguageModel(src/runtime/mock-language-model.ts)在 doStream/doGenerate
// 把收到的 options.prompt 写到 ZERO_CORE_DIR/mock-captures/call-<n>.json。bytes 部件
// 被替换成 descriptor(type/mediaType/byteLength),便于断言 part 形态(inline image
// 在 provider 层 = { type:"file", mediaType:"image/..." };非 inline = 无 file part,
// attachment 元信息在 text part 文本里)。本 spec 读这些文件做断言。
//
// ## multimodal control
// The seed provides three immutable-capability models: mock-1 (unknown),
// mock-image (true), and mock-text (false). Tests switch TestAgent through
// agentsUpdate instead of restoring the removed providersUpdateModel API.
//
// ## 定位
// tests/e2e/ — Playwright Electron E2E。
//
// ## 依赖
// @playwright/test、./helpers/test-app、node:fs、node:path
//

import { test, expect } from "@playwright/test";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");
const PNG_FIXTURE = resolve(__dirname, "fixtures/red-2x2.png");

// A small base64-encoded image clipboard payload (matches red-2x2.png bytes).
// Used to simulate an image paste event (DataTransfer with image/png blob).
const PNG_BYTES = readFileSync(PNG_FIXTURE);

/**
 * Read all captured mock-provider calls under <zeroDir>/mock-captures/, ordered
 * by call index. Returns the parsed prompt array per call.
 */
function readMockCaptures(zeroDir: string): Array<{ prompt: any[] }> {
	const dir = join(zeroDir, "mock-captures");
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir)
		.filter((f) => f.startsWith("call-") && f.endsWith(".json"))
		.sort((a, b) => {
			const na = parseInt(a.replace(/^call-/, "").replace(/\.json$/, ""), 10);
			const nb = parseInt(b.replace(/^call-/, "").replace(/\.json$/, ""), 10);
			return na - nb;
		});
	return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/**
 * Reset captures so a test starts from a known call index.
 */
function resetMockCaptures(zeroDir: string): void {
	const dir = join(zeroDir, "mock-captures");
	try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Switch TestAgent to one of the seeded immutable-capability Mock models through
 * the supported Agent update surface. AgentService hot-applies the model to the
 * idle loop, so the next send and context refresh use the selected capability.
 */
async function selectModelCapability(
	window: import("@playwright/test").Page,
	multimodal: true | false | undefined,
): Promise<void> {
	await window.evaluate(async (capability) => {
		const api = (window as any).api;
		const providers = await api.providersList();
		const mock = providers.find((p: any) => p.type === "mock") ?? providers[0];
		const model = mock.models.find((m: any) => m.multimodal === capability);
		if (!model) throw new Error(`seeded Mock model missing multimodal=${String(capability)}`);
		const agents = await api.agentsList();
		const agent = agents.find((a: any) => a.name === "TestAgent") ?? agents[0];
		if (!agent) throw new Error("seeded TestAgent missing");
		await api.agentsUpdate(agent.id, { provider: mock.name, model: model.id });
	}, multimodal);
}

/**
 * Inject an image paste event into the chat textarea. Playwright has no native
 * clipboard-paste-of-image API, so we dispatch a synthetic `paste` event carrying
 * a DataTransfer with an image/png Blob. This exercises the same `handlePaste`
 * handler sub-5 wired (it reads e.clipboardData.files).
 */
async function pasteImage(window: import("@playwright/test").Page, pngBytes: Uint8Array, fileName = "red-2x2.png"): Promise<void> {
	await window.evaluate(async ([bytes, name]) => {
		const textarea = document.querySelector(".chat-input-bar textarea") as HTMLTextAreaElement;
		if (!textarea) throw new Error("chat textarea not found");
		const blob = new Blob([bytes], { type: "image/png" });
		// @ts-ignore — File ctor accepts (bits, name)
		const file = new File([blob], name, { type: "image/png" });
		const dt = new DataTransfer();
		dt.items.add(file);
		// also populate files for handlers that read clipboardData.files
		const pasteEvent = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData: dt as any,
		});
		textarea.dispatchEvent(pasteEvent);
	}, [pngBytes as unknown as number[], fileName] as const);
}

/**
 * Drive the hidden file input (+ button) to import a file. This is the most
 * reliable import path in Playwright (inputFileChooser / setInputFiles).
 */
async function importFileViaPlus(window: import("@playwright/test").Page, filePath: string): Promise<void> {
	const fileInput = window.locator(".chat-input-bar input[type=\"file\"]");
	await fileInput.setInputFiles(filePath);
}

/**
 * Click Send (the non-abort, non-attach button in the input bar).
 */
async function clickSend(window: import("@playwright/test").Page): Promise<void> {
	// round-3 review P1-1:统一用 accessible-name 定位 Send(抗未来输入按钮)。
	await window.getByRole("button", { name: "Send" }).click();
}

/**
 * Wait for streaming to complete on the active session (cursor-blink detached).
 */
async function waitForStreamEnd(window: import("@playwright/test").Page): Promise<void> {
	await window.waitForSelector(".cursor-blink", { timeout: 5_000, state: "attached" }).catch(() => {});
	await window.waitForSelector(".cursor-blink", { timeout: 30_000, state: "detached" });
}

/**
 * Force ChatPanel to re-pull sessionsGetInit (refreshes context-usage modality
 * badge after a runtime multimodal change). We toggle the agent dropdown to a
 * DIFFERENT agent and back — re-selecting the same value would not fire React's
 * onChange, so the active-session effect wouldn't re-run. The seed provides
 * TestAgent + TestAgent2; we flip to the other one then back to the first.
 */
async function refreshContextInfo(window: import("@playwright/test").Page): Promise<void> {
	// There are (rarely) two .chat-agent-select in the DOM (a hidden page mounts
	// alongside the active one), which trips Playwright strict mode. Use the
	// VISIBLE one. The active session is the one that already has a session id.
	const dropdown = window.locator(".chat-agent-select").first();
	await dropdown.waitFor({ state: "visible", timeout: 10_000 });
	// Grab both option values.
	const options = await dropdown.locator("option[value]:not([value=''])").all();
	if (options.length < 2) {
		// Only one agent — fall back to clicking Chat away and back via sidebar.
		await window.locator("button[title='Chat']").click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 10_000 });
		await selectTestAgent(window);
		return;
	}
	const first = await options[0].getAttribute("value");
	const second = await options[1].getAttribute("value");
	// Switch away then back to re-fire the activation effect.
	await dropdown.selectOption(second!);
	await window.waitForSelector(`.chat-panel[data-session-id]:not([data-session-id=""])`, { timeout: 15_000 });
	await dropdown.selectOption(first!);
	await window.waitForSelector(`.chat-panel[data-session-id]:not([data-session-id=""])`, { timeout: 15_000 });
}

test.describe("Multimodal input (sub-7)", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];
	let zeroDir: string;

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		zeroDir = app.zeroDir;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);
		// Reset captures so each test starts at call-0.
		resetMockCaptures(zeroDir);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	// ─── 场景 1:粘贴图片 → 缩略图 → 发送 → 支持 provider 收到 inline image ────

	test("case 1: paste image → pending thumbnail → send → multimodal provider receives inline image part", async () => {
		// Arrange: make the Mock model support image input.
		await selectModelCapability(window, true);

		// Act: paste an image into the textarea.
		await pasteImage(window, PNG_BYTES);

		// Assert: pending-attachment thumbnail appears (image chip).
		const chip = window.locator(".chat-input-attachments .attach-chip");
		await expect(chip).toBeVisible({ timeout: 10_000 });
		await expect(chip.locator(".attach-chip-thumb")).toBeVisible();
		await expect(chip.locator(".attach-chip-name")).toContainText("red-2x2.png");

		// Send it (with a little text so the message is identifiable).
		await window.locator(".chat-input-bar textarea").fill("look at this");
		await clickSend(window);
		await waitForStreamEnd(window);

		// Assert: the mock provider received an INLINE IMAGE. At the provider layer
		// the AI SDK serializes an image ModelMessage part to a `file` part with an
		// image/* mediaType. We assert the last user message in the captured prompt
		// contains exactly such a part (and a text part).
		const captures = readMockCaptures(zeroDir);
		expect(captures.length).toBeGreaterThan(0);
		const last = captures[captures.length - 1];
		const userMsgs = last.prompt.filter((m: any) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThan(0);
		const lastUser = userMsgs[userMsgs.length - 1];
		const parts = lastUser.content as any[];
		const imagePart = parts.find((p: any) => p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
		expect(imagePart, "expected an inline image (file) part in the captured prompt").toBeTruthy();
		// The text part is preserved alongside.
		const textPart = parts.find((p: any) => p.type === "text" && typeof p.text === "string" && p.text.includes("look at this"));
		expect(textPart, "expected the user text part alongside the image").toBeTruthy();
	});

	// ─── 场景 2:不支持 provider → 收到元信息文本(无 image part)──────────

	test("case 2: non-multimodal provider → attachment meta-info TEXT (no inline image part)", async () => {
		// Arrange: the Mock model does NOT support image input.
		await selectModelCapability(window, false);

		// Act: paste + send.
		await pasteImage(window, PNG_BYTES);
		await expect(window.locator(".chat-input-attachments .attach-chip")).toBeVisible({ timeout: 10_000 });
		await clickSend(window); // attachment-only send (no text)
		await waitForStreamEnd(window);

		// Assert: the captured prompt has NO inline image/file part — the
		// attachment collapsed to a meta-info TEXT part (per design D3 / 组件 3).
		const captures = readMockCaptures(zeroDir);
		expect(captures.length).toBeGreaterThan(0);
		const last = captures[captures.length - 1];
		const userMsgs = last.prompt.filter((m: any) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThan(0);
		const lastUser = userMsgs[userMsgs.length - 1];
		const parts = lastUser.content as any[];

		// No image/file part at all.
		const imagePart = parts.find((p: any) =>
			(p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) ||
			p.type === "image");
		expect(imagePart, "non-multimodal provider must NOT receive an inline image part").toBeFalsy();

		// There IS a text part mentioning the attachment meta (filename + hint).
		const metaPart = parts.find((p: any) =>
			p.type === "text" && typeof p.text === "string" && p.text.includes("red-2x2.png"));
		expect(metaPart, "expected an attachment meta-info text part").toBeTruthy();
		// The meta text should carry a "not multimodal / use file-read" hint per D3.
		expect((metaPart as any).text).toMatch(/multimodal|file-read|delegate/i);
	});

	// ─── 场景 3:历史附件缩略图(attachments:content 端点)──────────────────

	test("case 3: history attachment thumbnail renders via attachments:content endpoint after re-select", async () => {
		// Send an image (model multimodal setting irrelevant for DISPLAY path —
		// history attachments always render via the content endpoint).
		await pasteImage(window, PNG_BYTES);
		await expect(window.locator(".chat-input-attachments .attach-chip")).toBeVisible({ timeout: 10_000 });
		await clickSend(window);
		await waitForStreamEnd(window);

		// The sent user message should now show a HISTORY attachment thumbnail
		// (rendered via attachments:content). It may take a moment for the
		// content fetch + img load.
		const historyImg = window.locator(".message-attachments .attach-history-image img");
		await expect(historyImg.first()).toBeVisible({ timeout: 15_000 });

		// Force ChatPanel to re-pull sessionsGetInit for the SAME session, so
		// history messages (incl. the attachment) are rebuilt from turns and the
		// thumbnail is fetched fresh from disk via attachments:content. We
		// navigate away to Dashboard then back to Chat — this re-mounts
		// ChatPanel and re-runs the active-session effect without switching
		// agents (which would create a new session).
		await window.locator(".icon-sidebar-top button[title='Dashboard']").click();
		await window.waitForSelector(".dashboard-page", { timeout: 10_000 });
		await window.locator(".icon-sidebar-top button[title='Chat']").click();
		await window.waitForSelector(".page-chat.page-active", { timeout: 10_000 });
		// Wait for the session's messages to reload (history img reappears via
		// the content endpoint on this fresh mount).
		await expect(historyImg.first()).toBeVisible({ timeout: 15_000 });
	});

	// ─── 场景 4:context-usage 模态标识三态 ────────────────────────────────

	test("case 4a: context-usage modality badge = 🖼 image when model multimodal=true", async () => {
		await selectModelCapability(window, true);
		await refreshContextInfo(window);
		await expect(window.locator(".context-usage .modality-image")).toBeVisible({ timeout: 15_000 });
		await expect(window.locator(".context-usage .modality-unknown")).toHaveCount(0);
	});

	test("case 4b: context-usage modality badge = 模态未知 when model multimodal=undefined (seed default)", async () => {
		// Seed model has NO multimodal field → undefined → "模态未知".
		await selectModelCapability(window, undefined);
		await refreshContextInfo(window);
		await expect(window.locator(".context-usage .modality-unknown")).toBeVisible({ timeout: 15_000 });
		await expect(window.locator(".context-usage .modality-image")).toHaveCount(0);
	});

	test("case 4c: context-usage modality badge = none when model multimodal=false", async () => {
		await selectModelCapability(window, false);
		await refreshContextInfo(window);
		// false → NO badge at all (neither image nor unknown).
		await expect(window.locator(".context-usage .modality-image")).toHaveCount(0);
		await expect(window.locator(".context-usage .modality-unknown")).toHaveCount(0);
	});

	// ─── 场景 5:仅附件无文本可发送 ───────────────────────────────────────

	test("case 5: attachment-only (no text) send is enabled and goes through", async () => {
		await selectModelCapability(window, true);

		// No text typed. Paste an image.
		await expect(window.locator(".chat-input-bar textarea")).toHaveValue("");
		await pasteImage(window, PNG_BYTES);
		await expect(window.locator(".chat-input-attachments .attach-chip")).toBeVisible({ timeout: 10_000 });

		// Send button is NOT disabled (attachment-only is allowed per sub-5).
		const sendBtn = window.getByRole("button", { name: "Send" });
		await expect(sendBtn).not.toHaveAttribute("disabled");

		// Send — should succeed and the mock receives the image.
		await clickSend(window);
		await waitForStreamEnd(window);

		// User message bubble appears (attachment-only still creates a user msg).
		await expect(window.locator(".message.message-user").first()).toBeVisible({ timeout: 10_000 });

		// Mock captured an inline image (proves the attachment made it through).
		const captures = readMockCaptures(zeroDir);
		expect(captures.length).toBeGreaterThan(0);
		const last = captures[captures.length - 1];
		const lastUser = last.prompt.filter((m: any) => m.role === "user").pop()!;
		const hasImage = (lastUser.content as any[]).some((p: any) =>
			p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
		expect(hasImage, "attachment-only send should deliver an inline image to the provider").toBeTruthy();
	});

	// ─── 场景 6:+号导入入口(拖拽 Playwright 难稳定模拟,以 +号 覆盖)──────

	test("case 6: + button file import → pending thumbnail → send → provider receives image", async () => {
		await selectModelCapability(window, true);

		// Drive the hidden file input via setInputFiles (most reliable import).
		await importFileViaPlus(window, PNG_FIXTURE);

		// Pending chip appears.
		const chip = window.locator(".chat-input-attachments .attach-chip");
		await expect(chip).toBeVisible({ timeout: 10_000 });
		await expect(chip.locator(".attach-chip-thumb")).toBeVisible();

		// Send and verify the provider received the inline image.
		await clickSend(window);
		await waitForStreamEnd(window);

		const captures = readMockCaptures(zeroDir);
		expect(captures.length).toBeGreaterThan(0);
		const last = captures[captures.length - 1];
		const lastUser = last.prompt.filter((m: any) => m.role === "user").pop()!;
		const hasImage = (lastUser.content as any[]).some((p: any) =>
			p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
		expect(hasImage, "+ import should deliver an inline image to the provider").toBeTruthy();
	});
});
