// Electron 主进程入口
//
// # 文件说明书
//
// ## 核心功能
// Electron 应用主进程入口，负责窗口创建、后端子进程管理和 IPC 代理。
//
// ## 输入
// - Electron app 事件（ready, window-all-closed 等）
//
// ## 输出
// - BrowserWindow 实例（主窗口）
// - IPC 代理注册
//
// ## 定位
// Electron 主进程入口点（thin shell）。
//
// ## 依赖
// - electron - Electron 框架
// - ./backend-spawn - 后端子进程管理
// - ./ipc-proxy - IPC → HTTP/WS 桥接
//
// ## 维护规则
// - 窗口创建逻辑变更时需更新
// - 新增 IPC 通道需在 ipc-proxy 路由映射中添加
//
import { app, BrowserWindow, dialog, session } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnBackend, shutdownBackend } from "./backend-spawn.js";
import { registerProxyHandlers, connectEventBridge } from "./ipc-proxy.js";
import { importCookies } from "../runtime/mcp-tools/cookie-jar.js";
import { DEV_SERVER_URL } from "../core/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function log(msg: string) {
	console.log(`[main] ${(Date.now() / 1000).toFixed(2)}s ${msg}`);
}

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? reason.message : String(reason);
	console.error(`[main] Unhandled rejection: ${msg}`);
});

process.on("uncaughtException", (err) => {
	console.error(`[main] Uncaught exception: ${err.message}`);
	if (err.stack) console.error(err.stack);
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "Zero-Core",
		titleBarStyle: "hidden",
		frame: false,
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
		},
	});

	log("BrowserWindow created");

	if (isDev && process.env.NODE_ENV !== "test" && !process.env.ZERO_CORE_TEST_FIXTURE) {
		mainWindow.loadURL(DEV_SERVER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

// ---------------------------------------------------------------------------
// Electron-specific handlers (stay in main process)
// ---------------------------------------------------------------------------

function registerLocalHandlers(win: BrowserWindow) {
	// Window controls
	ipcMain.handle("window:minimize", () => win.minimize());
	ipcMain.handle("window:maximize", () => {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	});
	ipcMain.handle("window:close", () => win.close());

	// dialog:openDirectory — native directory picker
	ipcMain.handle("dialog:openDirectory", async () => {
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
		});
		return result.filePaths[0] ?? undefined;
	});

	// webfetch:login — BrowserWindow for cookie-based login
	ipcMain.handle("webfetch:login", async (_e, url: string) => {
		try {
			const hostname = new URL(url).hostname;
			const loginWin = new BrowserWindow({
				width: 1000,
				height: 700,
				title: "Login — " + hostname,
				webPreferences: {
					partition: "persist:webfetch",
					nodeIntegration: false,
					contextIsolation: true,
				},
			});
			await loginWin.loadURL(url);

			let capturedCookies: Electron.Cookie[] = [];
			await new Promise<void>((resolve) => {
				loginWin.on("close", (e) => {
					e.preventDefault();
					loginWin.webContents.session.cookies.get({}).then((cookies) => {
						capturedCookies = cookies;
						loginWin.destroy();
						resolve();
					}).catch(() => {
						loginWin.destroy();
						resolve();
					});
				});
			});

			const relevant = capturedCookies.filter((c) => {
				if (!c.domain) return false;
				const d = c.domain.replace(/^\./, "");
				return d === hostname || hostname.endsWith("." + d);
			});

			let totalImported = 0;
			const byDomain = new Map<string, Electron.Cookie[]>();
			for (const c of relevant) {
				const d = (c.domain ?? "").replace(/^\./, "");
				if (!byDomain.has(d)) byDomain.set(d, []);
				byDomain.get(d)!.push(c);
			}
			for (const [domain, cookies] of byDomain) {
				totalImported += importCookies(
					domain,
					cookies.map((c) => ({
						name: c.name,
						value: c.value,
						expires: c.expirationDate ? Math.floor(c.expirationDate * 1000) : 0,
						path: c.path ?? "/",
					})),
				);
			}
			return { ok: true, cookieCount: totalImported };
		} catch (err: any) {
			return { ok: false, cookieCount: 0, error: err.message };
		}
	});
}

// Need to import ipcMain for local handlers
import { ipcMain } from "electron";

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Fix Windows terminal encoding for UTF-8
if (process.platform === "win32") {
	try { require("child_process").execSync("chcp 65001", { stdio: "ignore" }); } catch {}
}


// Fix GPU disk cache corruption (Electron/Chromium on Windows)
// Prevents "Unable to move the cache: Access Denied" errors
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
log("App starting...");
app.whenReady().then(async () => {
	log("app.whenReady fired");

	// 1. Spawn backend subprocess
	log("Spawning backend...");
	const { port } = await spawnBackend();
	log(`Backend started on port ${port}`);

	// 2. Create window
	createWindow();

	// 3. Register IPC proxy (forwards to backend HTTP)
	registerProxyHandlers(port);
	registerLocalHandlers(mainWindow!);

	// 4. Connect WebSocket event bridge
	connectEventBridge(mainWindow!, port);

	if (isDev && process.env.NODE_ENV !== "test" && !process.env.ZERO_CORE_TEST_FIXTURE) {
		mainWindow?.webContents.openDevTools({ mode: "detach" });
	}
});

app.on("window-all-closed", () => {
	app.quit();
});

app.on("activate", () => {
	if (mainWindow === null) createWindow();
});

app.on("before-quit", async () => {
	log("Shutting down backend...");
	await shutdownBackend();
});
