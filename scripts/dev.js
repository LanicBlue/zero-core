// Dev launcher that removes ELECTRON_RUN_AS_NODE before starting electron-vite
// VSCode's Claude Code extension sets ELECTRON_RUN_AS_NODE=1, which breaks Electron
delete process.env.ELECTRON_RUN_AS_NODE;
import { execSync, spawn } from "child_process";
import { resolve } from "path";

// Build server modules first (needed for dynamic imports in main process)
execSync("npm run build:lib", { stdio: "inherit" });

// Spawn electron-vite dev in a clean environment (no ELECTRON_RUN_AS_NODE)
const child = spawn("npx", ["electron-vite", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
