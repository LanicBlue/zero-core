// 后端子进程入口，由 Electron 主进程 spawn 后运行。
//
// # 文件说明书
//
// ## 核心功能
// 作为 detached 后端进程的 Node.js 入口：解析 --port 参数启动 Express + WebSocket
// 服务器，通过 stdout 行协议向父进程上报 `{type:"ready",port,pid}`，并监听 stdin
// 的 `{type:"shutdown"}` 指令完成优雅关闭。
//
// ## 输入
// - 命令行参数 `--port=0`（由 backend-spawn.ts 传入，0 表示随机端口）
// - stdin 上行 JSON 行：`{type:"shutdown"}`
// - 进程信号 SIGTERM / SIGINT
//
// ## 输出
// - stdout JSON 行：`{type:"ready",port,pid}` 给父进程握手
// - 已就绪的 HTTP / WebSocket 服务器（端口由内核分配）
// - stderr 日志与退出码（正常 0、致命 1）
//
// ## 定位
// 后端子进程独立入口；编译产物 dist/backend.js，由 src/main/backend-spawn.ts 在
// 开发模式下用系统 node spawn、打包模式下用 electron fork 加载。
//
// ## 依赖
// - ./server/index.js 的 startServer()
// - Node.js 内置：node:readline、process 进程信号
// - 间接：Express、ws、better-sqlite3（通过 server 启动时引入）
//
// ## 维护规则
// - stdout 协议格式与 backend-spawn.ts 的解析逻辑必须保持同步
// - 优雅关闭超时阈值改动需同时调整父进程等待逻辑
// - 任何顶层未捕获错误必须以非零码退出，触发父进程重启

import { startServer } from "./server/index.js";
import { log } from "./core/logger.js";

// ─── Global async-error capture ──────────────────────────────────────────
//
// A long-running server MUST NOT die silently from a stray async error. Node
// 15+ terminates the process on any unhandled promise rejection by default —
// which (before these handlers) killed the whole backend on a single rejecting
// promise, surfacing in the parent as an unexplained ECONNRESET with NO trace
// in the daily log (the rejection text went only to stderr → the launching
// terminal, invisible once the app runs detached).
//
// Strategy:
//   - unhandledRejection: LOG the full reason + stack to the file sink, then
//     CONTINUE. A server should survive one bad promise; the log now carries
//     the root cause for diagnosis. (If a rejection indicates fatal state, the
//     code path can still call process.exit explicitly.)
//   - uncaughtException:  LOG the full error + stack, then exit non-zero so the
//     parent (backend-spawn.ts) restarts the backend cleanly. Sync exceptions
//     may leave state inconsistent, so we don't keep running — but the stack is
//     now in the log instead of vanishing.
process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
	log.error("backend", `unhandledRejection: ${msg}`);
	console.error("[backend] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
	log.error("backend", `uncaughtException: ${err.message}\n${err.stack ?? ""}`);
	console.error("[backend] uncaughtException:", err);
	// Exit non-zero so backend-spawn.ts auto-restarts; the stack is now logged.
	process.exit(1);
});

function parsePort(): number {
	const arg = process.argv.find(a => a.startsWith("--port="));
	if (arg) return parseInt(arg.split("=")[1], 10);
	return 0;
}

async function main() {
	const port = parsePort();
	const { server } = await startServer({ port, serveStatic: false });

	const addr = server.address() as { port: number };
	// Report readiness to parent process via stdout
	process.stdout.write(JSON.stringify({ type: "ready", port: addr.port, pid: process.pid }) + "\n");

	// Listen for shutdown command on stdin
	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin });

	rl.on("line", (line) => {
		try {
			const msg = JSON.parse(line);
			if (msg.type === "shutdown") {
				console.log("[backend] Received shutdown command, closing...");
				server.close(() => {
					process.exit(0);
				});
				// Force exit after 5s if graceful shutdown hangs
				setTimeout(() => process.exit(0), 5000);
			}
		} catch { /* ignore non-JSON input */ }
	});

	// Handle SIGTERM (sent by parent as fallback)
	process.on("SIGTERM", () => {
		console.log("[backend] SIGTERM received, exiting");
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000);
	});

	process.on("SIGINT", () => {
		console.log("[backend] SIGINT received, exiting");
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000);
	});
}

main().catch((err) => {
	console.error("[backend] Fatal:", err.message);
	if (err.stack) console.error(err.stack);
	process.exit(1);
});
