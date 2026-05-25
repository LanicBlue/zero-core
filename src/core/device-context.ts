import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, cpus, hostname, networkInterfaces, platform, release, totalmem, type } from "node:os";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceInfo {
	hostname: string;
	os: string;
	arch: string;
	cpu: string;
	cpuCores: number;
	totalMemoryGB: string;
	gpu: string | null;
	disks: Array<{ mount: string; totalGB: string; freeGB: string }>;
	network: Array<{ name: string; address: string }>;
}

interface DeviceContextFile {
	content: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Info collection
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
	const gb = bytes / (1024 * 1024 * 1024);
	return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function detectGpu(): string | null {
	try {
		const p = platform();
		if (p === "win32") {
			const out = execSync("wmic path win32_VideoController get name", {
				encoding: "utf-8",
				timeout: 5000,
			});
			const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
			// First line is "Name", subsequent lines are GPU names
			const gpus = lines.slice(1).filter((l) => l && l !== "Name");
			return gpus.length > 0 ? gpus[0] : null;
		}
		if (p === "linux") {
			const out = execSync("lspci 2>/dev/null | grep -i vga", {
				encoding: "utf-8",
				timeout: 5000,
			});
			const match = out.match(/:\s*(.+)/);
			return match ? match[1].trim() : null;
		}
		if (p === "darwin") {
			const out = execSync("system_profiler SPDisplaysDataType 2>/dev/null", {
				encoding: "utf-8",
				timeout: 10000,
			});
			const match = out.match(/Chipset Model:\s*(.+)/);
			return match ? match[1].trim() : null;
		}
	} catch {
		// GPU detection failed, not critical
	}
	return null;
}

function detectDisks(): Array<{ mount: string; totalGB: string; freeGB: string }> {
	const disks: Array<{ mount: string; totalGB: string; freeGB: string }> = [];
	try {
		if (platform() === "win32") {
			const out = execSync("wmic logicaldisk get caption,size,freespace", {
				encoding: "utf-8",
				timeout: 5000,
			});
			const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
			for (const line of lines.slice(1)) {
				const parts = line.split(/\s+/);
				if (parts.length >= 3) {
					const mount = parts[0];
					const freeBytes = parseInt(parts[1], 10);
					const totalBytes = parseInt(parts[2], 10);
					if (!isNaN(totalBytes) && totalBytes > 0) {
						disks.push({
							mount,
							totalGB: formatBytes(totalBytes),
							freeGB: isNaN(freeBytes) ? "unknown" : formatBytes(freeBytes),
						});
					}
				}
			}
		} else {
			const out = execSync("df -h 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
			const lines = out.split("\n").slice(1);
			for (const line of lines) {
				const parts = line.split(/\s+/);
				if (parts.length >= 6 && parts[5].startsWith("/")) {
					disks.push({
						mount: parts[5],
						totalGB: parts[1],
						freeGB: parts[3],
					});
				}
			}
		}
	} catch {
		// Disk detection failed
	}
	return disks;
}

export function collectDeviceInfo(): DeviceInfo {
	const cpuInfo = cpus();
	const osName = platform() === "win32"
		? `Windows ${type()} ${release()}`
		: `${type()} ${release()}`;

	// Filter network interfaces: exclude internal (127.x, ::1) and empty
	const netIfs = networkInterfaces();
	const networkList: Array<{ name: string; address: string }> = [];
	for (const [name, addrs] of Object.entries(netIfs)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.internal) continue;
			if (addr.family === "IPv4" && !addr.address.startsWith("127.")) {
				networkList.push({ name, address: addr.address });
			}
		}
	}

	return {
		hostname: hostname(),
		os: osName,
		arch: arch(),
		cpu: cpuInfo[0]?.model ?? "Unknown",
		cpuCores: cpuInfo.length,
		totalMemoryGB: formatBytes(totalmem()),
		gpu: detectGpu(),
		disks: detectDisks(),
		network: networkList,
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDeviceContext(info: DeviceInfo): string {
	const lines: string[] = [
		`## Device Environment`,
		`- **Host**: ${info.hostname} / ${info.os} (${info.arch})`,
		`- **CPU**: ${info.cpu} (${info.cpuCores} cores)`,
		`- **RAM**: ${info.totalMemoryGB}`,
	];

	if (info.gpu) {
		lines.push(`- **GPU**: ${info.gpu}`);
	}

	if (info.disks.length > 0) {
		const diskStr = info.disks.map((d) => `${d.mount} ${d.totalGB} (${d.freeGB} free)`).join(", ");
		lines.push(`- **Disk**: ${diskStr}`);
	}

	if (info.network.length > 0) {
		const netStr = info.network.map((n) => `${n.name} (${n.address})`).join(", ");
		lines.push(`- **Network**: ${netStr}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getDeviceContextPath(): string {
	return join(homedir(), ".zero-core", "device-context.json");
}

export function loadDeviceContext(): string {
	const filePath = getDeviceContextPath();
	if (!existsSync(filePath)) {
		// First run: auto-generate and save
		try {
			return generateAndSaveDeviceContext();
		} catch {
			return "";
		}
	}
	try {
		const data = JSON.parse(readFileSync(filePath, "utf-8"));
		return data.content ?? "";
	} catch {
		return "";
	}
}

export function saveDeviceContext(content: string): void {
	const filePath = getDeviceContextPath();
	const dir = join(filePath, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const data: DeviceContextFile = {
		content,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function generateAndSaveDeviceContext(): string {
	const info = collectDeviceInfo();
	const formatted = formatDeviceContext(info);
	saveDeviceContext(formatted);
	return formatted;
}
