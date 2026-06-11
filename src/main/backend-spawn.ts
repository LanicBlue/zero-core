// 后端子进程生命周期管理
//
// 负责启动、监控、优雅关闭后端 Node.js 子进程。
//
// 开发模式：用系统 Node.js spawn 后端，避免 Electron ABI 与 better-sqlite3 不匹配。
// 打包模式：用 fork()，electron-builder 的 npmRebuild=true 已将 better-sqlite3 重新编译给 Electron。

import { fork, spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { app } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg: string) {
	console.log(`[backend-spawn] ${msg}`);
}

export interface BackendHandle {
	process: ChildProcess;
	port: number;
}

let _handle: BackendHandle | null = null;
let _shuttingDown = false;

export function spawnBackend(): Promise<BackendHandle> {
	return new Promise((resolve, reject) => {
		const backendPath = join(__dirname, "../../dist/backend.js");
		const isPackaged = app.isPackaged;

		let child: ChildProcess;
		if (isPackaged) {
			// 打包模式：用户机器可能无 Node.js，用 Electron fork
			// electron-builder npmRebuild=true 已将 better-sqlite3 重新编译给 Electron ABI
			log(`Forking (packaged): ${backendPath}`);
			child = fork(backendPath, ["--port=0"], {
				stdio: ["pipe", "pipe", "pipe", "ipc"],
			});
		} else {
			// 开发模式：用系统 Node.js spawn，better-sqlite3 由 npm install 编译给系统 Node
			log(`Spawning (dev): node ${backendPath}`);
			child = spawn("node", [backendPath, "--port=0"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});
		}

		log(`Child PID: ${child.pid}`);

		let ready = false;
		const timeout = setTimeout(() => {
			if (!ready) {
				child.kill();
				reject(new Error("Backend process failed to start within 30s"));
			}
		}, 30_000);

		child.stdout!.on("data", (data: Buffer) => {
			const raw = data.toString();
			const lines = raw.split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const msg = JSON.parse(line);
					if (msg.type === "ready" && msg.port) {
						ready = true;
						clearTimeout(timeout);
						_handle = { process: child, port: msg.port };
						log(`Backend ready on port ${msg.port}`);
						resolve(_handle);
					}
				} catch { /* not JSON, ignore */ }
			}
		});

		child.stderr!.on("data", (data: Buffer) => {
			console.error(`[backend:stderr] ${data.toString().trim()}`);
		});

		child.on("exit", (code) => {
			clearTimeout(timeout);
			if (!_shuttingDown && !ready) {
				reject(new Error(`Backend process exited with code ${code} before becoming ready`));
			} else if (!_shuttingDown) {
				log(`Backend process exited unexpectedly with code ${code}, restarting...`);
				_handle = null;
				spawnBackend().catch((err) => console.error(`[backend] Restart failed: ${err.message}`));
			}
		});
	});
}

export async function shutdownBackend(): Promise<void> {
	if (!_handle) return;
	_shuttingDown = true;
	const child = _handle.process;

	// 1. Send graceful shutdown via stdin
	try {
		child.stdin!.write(JSON.stringify({ type: "shutdown" }) + "\n");
	} catch { /* stdin might be closed */ }

	// 2. Wait up to 5 seconds for graceful exit
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			log("Graceful shutdown timed out, sending SIGTERM");
			child.kill("SIGTERM");
			setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3000);
		}, 5000);

		child.on("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});

	_handle = null;
	_shuttingDown = false;
	log("Backend process stopped");
}

export function getBackendPort(): number | null {
	return _handle?.port ?? null;
}
