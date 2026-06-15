// 用 Electron BrowserWindow 对 SPA 页面做真实浏览器渲染并抓取最终 HTML。
//
// # 文件说明书
//
// ## 核心功能
// renderWithBrowser 用 persist:webfetch 分区的隐藏 BrowserWindow 加载 URL，等待 JS 渲染
// （renderDelay 默认 3s），再通过 executeJavaScript 抓取 outerHTML / title / 最终 URL。复用
// persist:webfetch 分区可直接拿到登录 cookie，无需手动注入。
//
// ## 输入
// - url：目标页面地址
// - opts.renderDelay：加载后等待 JS 渲染秒数（默认 3）
// - opts.timeout：含加载在内的总超时秒数（默认 30）
//
// ## 输出
// - RenderResult：{ html, title, finalUrl }
//
// ## 定位
// runtime/mcp-tools 层，被 fetch-tools 等 WebFetch 类工具在判定目标为 SPA / 需要登录态时调用；
// 仅在 Electron 主进程可用。
//
// ## 依赖
// - electron（BrowserWindow、session）
// - persist:webfetch 分区与 cookie-jar 维护的登录态
//
// ## 维护规则
// - 修改分区名或 cookie 注入策略时需同步 cookie-jar 与 webfetch 相关 UI。
// - 调整超时/渲染等待默认值后，应在真实 SPA 站点验证抓取完整性，避免截断未渲染内容。

import { BrowserWindow, session } from "electron";

export interface RenderResult {
	html: string;
	title: string;
	finalUrl: string;
}

export interface RenderOptions {
	/** Seconds to wait after page load for JS to finish rendering (default: 3) */
	renderDelay?: number;
	/** Total timeout in seconds including page load (default: 30) */
	timeout?: number;
}

export async function renderWithBrowser(
	url: string,
	opts?: RenderOptions,
): Promise<RenderResult> {
	const renderDelay = opts?.renderDelay ?? 3;
	const timeout = opts?.timeout ?? 30;

	const ses = session.fromPartition("persist:webfetch");

	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		show: false,
		webPreferences: {
			partition: "persist:webfetch",
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	try {
		// Load page with timeout
		const loaded = await Promise.race([
			win.loadURL(url),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Page load timed out after ${timeout}s`)), timeout * 1000),
			),
		]);

		// Wait for JS to render content
		await new Promise((resolve) => setTimeout(resolve, renderDelay * 1000));

		// Extract rendered HTML
		const html = await win.webContents.executeJavaScript(
			"document.documentElement.outerHTML",
		);
		const title = await win.webContents.executeJavaScript("document.title");
		const finalUrl = win.webContents.getURL();

		return { html, title, finalUrl };
	} finally {
		if (!win.isDestroyed()) win.close();
	}
}
