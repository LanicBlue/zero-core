// Cookie jar for webfetch — persisted to ~/.zero-core/webfetch/cookies.json
//
// Extracted from fetch-tools.ts to avoid pulling browser-render/electron
// into the main process bundle.

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
