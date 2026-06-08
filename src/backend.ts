// 后端子进程入口
//
// Electron 自动 spawn 的 Node.js 后端进程。
// 启动 Express + WebSocket 服务器，通过 stdout 报告就绪状态。
// 接收 stdin 的 shutdown 命令执行优雅关闭。

import { startServer } from "./server/index.js";

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
