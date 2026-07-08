// webfetch 的 cookie 持久化：按 domain 存取 ~/.zero-core/webfetch/cookies.json。
//
// # 文件说明书
//
// ## 核心功能
// 维护按 domain 分桶的 cookie jar：模块加载时读取磁盘并清理过期项；importCookies 写入、
// getCookieCount 统计、clearCookies 清空（可选单 domain）。从 fetch-tools 抽出独立模块，
// 避免把 browser-render / electron 拖进主进程 bundle。
//
// ## 输入
// - importCookies(domain, cookies[])：写入一批 cookie
// - clearCookies(domain?)：清空全部或指定 domain
//
// ## 输出
// - importCookies 返回写入条数；getCookieCount 返回 { domain: count } 映射
// - 副作用：读写 ~/.zero-core/webfetch/cookies.json
//
// ## 定位
// runtime/mcp-tools 层基础设施，给 fetch-tools 与 browser-render 共享登录态；不依赖 Electron。
//
// ## 依赖
// - node:fs、node:path、node:os
// - ~/.zero-core/webfetch 目录（自动创建）
//
// ## 维护规则
// - cookie 字段（value/expires/path）若扩展需同步 browser-render 的分区注入与导入 UI。
// - 文件格式变更要考虑老用户数据迁移，避免静默丢弃已有登录态。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE_DIR = join(homedir(), ".zero-core", "webfetch");
const COOKIES_FILE = join(BASE_DIR, "cookies.json");

interface CookieEntry { value: string; expires: number; path: string }
type CookieJar = Record<string, Record<string, CookieEntry>>;

let cookieJar: CookieJar = {};

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function loadCookies(): void {
	try {
		ensureDir(BASE_DIR);
		const raw = readFileSync(COOKIES_FILE, "utf-8");
		cookieJar = JSON.parse(raw);
		const now = Date.now();
		for (const domain of Object.keys(cookieJar)) {
			const entries = cookieJar[domain];
			for (const name of Object.keys(entries)) {
				if (entries[name].expires > 0 && entries[name].expires < now) {
					delete entries[name];
				}
			}
			if (Object.keys(entries).length === 0) delete cookieJar[domain];
		}
	} catch { /* file may not exist yet */ }
}

function saveCookies(): void {
	try {
		ensureDir(BASE_DIR);
		writeFileSync(COOKIES_FILE, JSON.stringify(cookieJar, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

// Initialize on load
loadCookies();

export function importCookies(domain: string, cookies: Array<{ name: string; value: string; expires?: number; path?: string }>): number {
	if (!cookieJar[domain]) cookieJar[domain] = {};
	let count = 0;
	for (const c of cookies) {
		cookieJar[domain][c.name] = { value: c.value, expires: c.expires ?? 0, path: c.path ?? "/" };
		count++;
	}
	saveCookies();
	return count;
}

export function getCookieCount(): Record<string, number> {
	const result: Record<string, number> = {};
	for (const [domain, entries] of Object.entries(cookieJar)) {
		result[domain] = Object.keys(entries).length;
	}
	return result;
}

export function clearCookies(domain?: string): void {
	if (domain) {
		delete cookieJar[domain];
	} else {
		cookieJar = {};
	}
	saveCookies();
}
