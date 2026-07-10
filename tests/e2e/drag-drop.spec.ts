// E2E:multimodal 拖拽修复验证(model-tag-polish)
//
// 用合成 DragEvent + DataTransfer 在真实 Electron app 里验证:
// 1. document dragover 真 preventDefault → 光标可放(修复"全窗口禁止光标")。
// 2. drop 到 chat-panel 真 ingest(pending attachment chip 出现)。
//
// Playwright 无法模拟真实 OS 文件拖拽的光标视觉,但 defaultPrevented 是
// Chromium 决定 drop 光标的机制 —— preventDefault 即"允许 drop、不禁止"。

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");
const PNG_FIXTURE = resolve(__dirname, "fixtures/red-2x2.png");
const PNG_BYTES = readFileSync(PNG_FIXTURE);

test.describe("multimodal drag-drop", () => {
	test("document dragover is preventDefault'd (drop cursor allowed window-wide)", async () => {
		const { window, cleanup } = await launchApp(FIXTURE);
		try {
			await waitForAppReady(window);
			await selectTestAgent(window);
			const armed = await window.evaluate(() => {
				const e = new DragEvent("dragover", { bubbles: true, cancelable: true });
				document.dispatchEvent(e);
				return e.defaultPrevented;
			});
			// 关键断言:document 级 preventDefault 已生效 → Chromium 会显示可放置光标,
			// 不再是"禁止"。这是修复"整个窗口禁止光标"的机制。
			expect(armed).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("drop a file over chat-panel ingests it (pending attachment chip)", async () => {
		const { window, cleanup } = await launchApp(FIXTURE);
		try {
			await waitForAppReady(window);
			await selectTestAgent(window);
			await window.evaluate(([bytes, name]) => {
				const target = document.querySelector(".chat-panel") as HTMLElement | null;
				if (!target) throw new Error("chat-panel not found");
				const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
				// @ts-ignore — File ctor accepts (bits, name)
				const file = new File([blob], name as string, { type: "image/png" });
				const dt = new DataTransfer();
				dt.items.add(file);
				target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
				target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
			}, [Array.from(PNG_BYTES), "1.png"] as const);
			// 上传是异步(base64 → IPC → 落盘);chip 出现即说明 drop→ingestFiles→upload 走通。
			await expect(window.locator(".attach-chip").first()).toBeVisible({ timeout: 15000 });
		} finally {
			await cleanup();
		}
	});
});
