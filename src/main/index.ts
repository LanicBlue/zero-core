import { app, BrowserWindow } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerIpc } from "./ipc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function log(msg: string) {
	console.log(`[main] ${(Date.now() / 1000).toFixed(2)}s ${msg}`);
}

// ---------------------------------------------------------------------------
// Global error handlers — catch unhandled rejections and exceptions
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason, promise) => {
	const msg = reason instanceof Error ? reason.message : String(reason);
	const stack = reason instanceof Error ? reason.stack : "";
	console.error(`[main] Unhandled rejection: ${msg}`);
	if (stack) console.error(stack);
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
		titleBarOverlay: {
			color: "#0d1117",
			symbolColor: "#8b949e",
			height: 36,
		},
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
		},
	});

	log("BrowserWindow created");

	if (isDev && !process.env.ZERO_CORE_TEST_FIXTURE) {
		mainWindow.loadURL("http://localhost:5173");
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Fix Windows terminal encoding for UTF-8 (Chinese text etc.)
if (process.platform === 'win32') {
	try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

log("App starting...");
app.whenReady().then(() => {
	log("app.whenReady fired");
	createWindow();

	// Load modules in background — window is already visible
	registerIpc(mainWindow!);

	if (isDev && !process.env.ZERO_CORE_TEST_FIXTURE) {
		mainWindow?.webContents.openDevTools({ mode: "detach" });
	}
});

app.on("window-all-closed", () => {
	app.quit();
});

app.on("activate", () => {
	if (mainWindow === null) createWindow();
});
