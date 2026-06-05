// 设备信息采集模块
//
// # 文件说明书
//
// ## 核心功能
// 采集当前设备的硬件和系统信息（CPU、内存、网络、操作系统等）
//
// ## 输入
// IKVStore 实例（用于缓存）
//
// ## 输出
// DeviceInfo 对象，包含完整的设备信息
//
// ## 定位
// src/core/ — 核心层，为 system-prompt 和上下文管理提供设备信息
//
// ## 依赖
// Node.js os/child_process 模块、kv-store-interface.ts
//
// ## 维护规则
// 新增设备信息字段时需同步更新 DeviceInfo 接口
//
import { execSync } from "node:child_process";
import { arch, cpus, hostname, networkInterfaces, platform, release, totalmem, type } from "node:os";
import type { IKVStore } from "./kv-store-interface.js";

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
// Persistence — backed by SQLite kv_store
// ---------------------------------------------------------------------------

const KV_KEY = "device_context";

interface DeviceContextData {
	content: string;
	updatedAt: string;
}

export function loadDeviceContext(kv?: IKVStore): string {
	if (!kv) {
		try { return generateAndSaveDeviceContext(kv); } catch { return ""; }
	}
	const stored = kv.getJson<DeviceContextData>(KV_KEY);
	if (!stored) {
		try { return generateAndSaveDeviceContext(); } catch { return ""; }
	}
	return stored.content ?? "";
}

export function saveDeviceContext(content: string, kv: IKVStore): void {
	kv.setJson(KV_KEY, { content, updatedAt: new Date().toISOString() });
}

export function generateAndSaveDeviceContext(kv?: IKVStore): string {
	const info = collectDeviceInfo();
	const formatted = formatDeviceContext(info);
	if (kv) saveDeviceContext(formatted, kv);
	return formatted;
}
