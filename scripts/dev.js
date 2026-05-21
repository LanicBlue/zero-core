// Dev launcher that removes ELECTRON_RUN_AS_NODE before starting electron-vite
// VSCode's Claude Code extension sets ELECTRON_RUN_AS_NODE=1, which breaks Electron
delete process.env.ELECTRON_RUN_AS_NODE;
import { execSync, spawn } from "child_process";
import { resolve, dirname } from "path";
import { existsSync, statSync, readdirSync } from "fs";

const __dirname = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));

// Check if build is needed by comparing src/ vs dist/ mtimes
function needsBuild() {
	const distDir = resolve(__dirname, "../dist");
	if (!existsSync(distDir)) return true;

	let newestSrc = 0;
	let newestDist = 0;

	function walkDir(dir, callback) {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = resolve(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "node_modules" && entry.name !== ".git") walkDir(full, callback);
				} else {
					callback(full);
				}
			}
		} catch {}
	}

	// Check src/server and src/core source files
	for (const srcDir of ["src/server", "src/core", "src/runtime"]) {
		walkDir(resolve(__dirname, "..", srcDir), (f) => {
			if (f.endsWith(".ts")) {
				newestSrc = Math.max(newestSrc, statSync(f).mtimeMs);
			}
		});
	}

	// Check dist output files
	walkDir(distDir, (f) => {
		if (f.endsWith(".js")) {
			newestDist = Math.max(newestDist, statSync(f).mtimeMs);
		}
	});

	// Rebuild if any source is newer than dist
	return newestSrc > newestDist;
}

const t0 = Date.now();
if (needsBuild()) {
	console.log("[dev] Source changed, rebuilding...");
	execSync("npm run build:lib", { stdio: "inherit" });
	console.log(`[dev] Build complete (${Date.now() - t0}ms)`);
} else {
	console.log("[dev] dist/ up to date, skipping build");
}

// Spawn electron-vite dev in a clean environment (no ELECTRON_RUN_AS_NODE)
const child = spawn("npx", ["electron-vite", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
