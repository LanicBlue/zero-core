import type { ErrorClass } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;
export const BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(err: any): ErrorClass {
	const msg = (err?.message ?? String(err)).toLowerCase();
	const status = err?.status ?? err?.statusCode;

	if (err?.name === "AbortError") return "timeout";
	if (/timeout|timed out|abort/i.test(msg)) return "timeout";
	if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return "rate_limit";
	if (status === 401 || status === 403 || /unauthorized|invalid.?api.?key|forbidden/i.test(msg)) return "auth";
	if (/context.*(length|window|too.?long|exceed)|prompt.?too.?long/i.test(msg)) return "prompt_too_long";
	if (status >= 500) return "server_error";
	if (/econnrefused|enotfound|econnreset|fetch.*failed|network/i.test(msg) || /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(err?.code ?? "")) return "network";
	return "unknown";
}

export function isTransientError(cls: ErrorClass): boolean {
	return cls === "timeout" || cls === "rate_limit" || cls === "server_error" || cls === "network";
}

export function userFriendlyMessage(cls: ErrorClass, raw: string): string {
	switch (cls) {
		case "timeout": return "请求超时，服务器响应时间过长。";
		case "rate_limit": return "请求频率过高，已被限流。请稍后重试。";
		case "server_error": return "服务器出错，请稍后重试。";
		case "auth": return "认证失败，请在设置中检查 API Key。";
		case "network": return "网络错误，请检查网络连接。";
		case "prompt_too_long": return "消息过长，超出模型上下文窗口限制。";
		default: return raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
	}
}

// ---------------------------------------------------------------------------
// Thinking tag parser
// ---------------------------------------------------------------------------

export function parseThinkingTags(text: string): any[] {
	if (!text) return [];
	const result: any[] = [];
	let remaining = text;
	// Strip leading newlines
	while (remaining.charCodeAt(0) === 10) remaining = remaining.substring(1);
	while (remaining) {
		const openIdx = remaining.indexOf("<think");
		if (openIdx === -1) {
			if (remaining) { let r = remaining; while (r.charCodeAt(r.length - 1) === 10) r = r.substring(0, r.length - 1); if (r) result.push({ type: "text", text: r }); }
			break;
		}
		if (openIdx > 0) { let before = remaining.substring(0, openIdx); while (before.charCodeAt(0) === 10) before = before.substring(1); while (before.charCodeAt(before.length - 1) === 10) before = before.substring(0, before.length - 1); if (before) result.push({ type: "text", text: before }); }
		const tagEnd = remaining.indexOf(">", openIdx);
		if (tagEnd === -1) { result.push({ type: "text", text: remaining }); break; }
		const closeIdx = remaining.indexOf("</think", tagEnd);
		if (closeIdx === -1) {
			let t = remaining.substring(tagEnd + 1);
			if (t.charCodeAt(0) === 10) t = t.substring(1);
			result.push({ type: "thinking", text: t });
			break;
		}
		let t = remaining.substring(tagEnd + 1, closeIdx);
		if (t.charCodeAt(0) === 10) t = t.substring(1);
		if (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
		result.push({ type: "thinking", text: t });
		const closeEnd = remaining.indexOf(">", closeIdx);
		let after = closeEnd !== -1 ? remaining.substring(closeEnd + 1) : "";
		if (after.charCodeAt(0) === 10) after = after.substring(1);
		remaining = after;
	}
	return result;
}
