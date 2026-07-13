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
import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, session } from "electron";
import { join, dirname } from "path";
import { existsSync, writeFileSync, statSync, watchFile, readdirSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { spawnBackend, shutdownBackend } from "./backend-spawn.js";
import { registerProxyHandlers, connectEventBridge } from "./ipc-proxy.js";
import { importCookies } from "../tools/mcp/cookie-jar.js";
import { DEV_SERVER_URL } from "../core/constants.js";
import { ZERO_CORE_DIR } from "../core/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// 区分“藏到托盘”和“真正退出”：托盘菜单 / Cmd+Q / app.quit() 时置 true，
// 使窗口 close 处理器放行，否则关窗一律 hide() 常驻菜单栏。
let isQuitting = false;

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

	mainWindow.on("close", (e) => {
		// 托盘常驻：关窗 → 隐藏到菜单栏；只有真正退出时才放行关闭。
		if (!isQuitting) {
			e.preventDefault();
			mainWindow?.hide();
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	// 窗口显隐时刷新托盘菜单标签(“显示窗口” ⇄ “隐藏窗口”)
	mainWindow.on("show", () => tray?.setContextMenu(buildTrayMenu()));
	mainWindow.on("hide", () => tray?.setContextMenu(buildTrayMenu()));
}

// ---------------------------------------------------------------------------
// Tray(菜单栏常驻;backend 子进程在托盘期间继续运行)
// ---------------------------------------------------------------------------

function showMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) {
		createWindow();
	} else {
		mainWindow.show();
		mainWindow.focus();
	}
}

// 托盘图标：优先用户的 template 图标(macOS 16x16 黑色透明 png)，
// 缺失则空图标兜底——功能(菜单/点击)完整，只是图标空白。
function loadTrayIcon() {
	const candidate = app.isPackaged
		? join(process.resourcesPath, "trayIconTemplate.png")
		: join(__dirname, "../../build/trayIconTemplate.png");
	if (existsSync(candidate)) {
		const img = nativeImage.createFromPath(candidate);
		img.setTemplateImage(true);
		if (!img.isEmpty()) return img;
	}
	log("Tray: 未找到 build/trayIconTemplate.png，用空图标占位");
	return nativeImage.createEmpty();
}

function buildTrayMenu() {
	const visible = !!mainWindow && mainWindow.isVisible();
	return Menu.buildFromTemplate([
		{
			label: visible ? "隐藏窗口" : "显示窗口",
			click: () => {
				if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
				else showMainWindow();
			},
		},
		{ type: "separator" },
		{ label: "退出", click: () => { isQuitting = true; app.quit(); } },
	]);
}

function createTray() {
	tray = new Tray(loadTrayIcon());
	tray.setToolTip("Zero-Core");
	tray.setContextMenu(buildTrayMenu());
	tray.on("click", () => showMainWindow());
}

// ---------------------------------------------------------------------------
// 自更新集成:暴露安装路径 / sentinel 优雅退出 / 启动扫残留 update run
// ---------------------------------------------------------------------------

// 写 <ZERO_CORE_DIR>/runtime.install-path,供 self-update 脚本探测安装位置
// (mac: .app/Contents/MacOS/Zero-Core;win: exe 本体;linux: AppImage 文件)
function writeInstallPath() {
	try {
		// linux AppImage 运行时 process.execPath 是挂载点;APPIMAGE env 才是真实文件
		const installPath = process.env.APPIMAGE || process.execPath;
		writeFileSync(join(ZERO_CORE_DIR, "runtime.install-path"), installPath);
	} catch { /* 数据目录不可写则忽略 */ }
}

// sentinel 优雅退出:helper 写 <ZERO_CORE_DIR>/.quit-requested → 走 before-quit 刷 WAL
// 用 watchFile(跨平台轮询,比 fs.watch 稳;Electron main 常驻不退出,无需 unref)
function watchQuitSentinel() {
	try { mkdirSync(ZERO_CORE_DIR, { recursive: true }); } catch {}
	const sentinel = join(ZERO_CORE_DIR, ".quit-requested");
	let lastMtime = 0;
	try { lastMtime = statSync(sentinel).mtimeMs; } catch {}
	watchFile(sentinel, { interval: 1000 }, (curr) => {
		if (curr.mtimeMs !== lastMtime && curr.mtimeMs > 0) {
			lastMtime = curr.mtimeMs;
			log("Quit sentinel (.quit-requested) triggered — graceful exit");
			isQuitting = true;
			app.quit();
		}
	});
}

// 启动扫残留 update run:result.json 缺失 = 中断的更新,提示用户从 previous 备份恢复
function scanStaleUpdateRuns() {
	try {
		const runsDir = join(ZERO_CORE_DIR, "update-runs");
		if (!existsSync(runsDir)) return;
		for (const entry of readdirSync(runsDir)) {
			const runDir = join(runsDir, entry);
			if (!existsSync(runDir)) continue;
			if (existsSync(join(runDir, "result.json"))) continue; // 已完成
			if (!existsSync(join(runDir, "rollback.json"))) continue; // 未到 P1(P0 失败的空 run)忽略
			log(`[self-update] 检测到未完成的 update run: ${entry}`);
			dialog.showMessageBoxSync({
				type: "warning",
				title: "Zero-Core 自更新未完成",
				message: `检测到一次中断的自更新(${entry})。若新版无法启动,可从备份恢复:\n${runDir}/previous.*`,
				buttons: ["知道了"],
			});
		}
	} catch { /* ignore */ }
}

function setupSelfUpdateIntegration() {
	writeInstallPath();
	watchQuitSentinel();
	scanStaleUpdateRuns();
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
	setupSelfUpdateIntegration();

	// 2. Create window
	createWindow();
	createTray();
	// dev 模式 Dock 用自定义图标替代 Electron 默认(打包后由 .app 图标接管)
	if (!app.isPackaged && process.platform === "darwin" && app.dock) {
		const iconPath = join(__dirname, "../../build/icon.png");
		if (existsSync(iconPath)) app.dock.setIcon(iconPath);
	}

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
	// 托盘常驻：窗口全关后留在菜单栏，不退出。真正退出走托盘菜单“退出”或 Cmd+Q
	// (会触发 before-quit → isQuitting=true → shutdownBackend)。
});

app.on("activate", () => {
	if (mainWindow === null) createWindow();
});

app.on("before-quit", async () => {
	isQuitting = true; // 放行窗口 close 处理器，允许真正关闭
	log("Shutting down backend...");
	await shutdownBackend();
});
