// Per-session attachment storage (effort: multimodal-input, sub-1).
//
// # 文件说明书
//
// ## 核心功能
// 把上传的附件字节落盘到 `ZERO_CORE_DIR/attachments/<sessionId>/<id>-<name>`,
// 并提供读取/按 session 清理的接口。kind 按 mimeType 推一次(image/*→image;
// application/pdf→pdf;else file),下游只流转 `AttachmentMeta`。
//
// ## 路径安全(关键)
// fileName / sessionId 全部走 sanitize:
//   - 剥成 basename(拒 `../`/绝对路径/盘符前缀)。
//   - 拒含空字节/控制字符的输入。
//   - sessionId 必须无路径分隔符(纯 token)。
// 落盘前后双校验:resolved diskPath 必须 startsWith(`ZERO_CORE_DIR/attachments/<sessionId>/`),
// 否则抛错 —— 这是 traversal 攻击的最后兜底,即使 sanitize 有遗漏也挡得住。
//
// ## 输入
// - sessionId、fileName、mimeType、base64 data(renderer 上传)
//
// ## 输出
// - `AttachmentMeta`(含 diskPath)
// - read 返回 Buffer / cleanSessionAttachments 返回删除条目数
//
// ## 定位
// src/server/ — 被 attachment-router(REST `/api/attachments`)调用;session
// 删除路径(session-router.ts)调用 cleanSessionAttachments 清理目录。
//
// ## 依赖
// - node:fs/promises、node:path、node:crypto
// - ZERO_CORE_DIR(../core/config.js)
// - ../shared/types.js(AttachmentMeta / AttachmentKind)
//

import { promises as fs } from "node:fs";
import { join, resolve, sep, basename, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { ZERO_CORE_DIR } from "../core/config.js";
import type { AttachmentKind, AttachmentMeta } from "../shared/types.js";

/** Root directory holding every session's attachment tree. */
export const ATTACHMENTS_ROOT = resolve(join(ZERO_CORE_DIR, "attachments"));

/**
 * Reject any control character (C0 + DEL + most C1). Catching `\0` explicitly
 * guards against null-byte truncation tricks (`foo\0../../etc/passwd`); the
 * broader range rejects otherinvisible injection vectors.
 */
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

/**
 * A safe sessionId token: non-empty, no path separators (slash or backslash),
 * not `.`/`..`, no control chars. Session ids are uuids / prefixed uuids in
 * this codebase, but we validate defensively in case a future caller passes a
 * crafted value.
 */
export function isValidSessionId(sessionId: string): boolean {
	if (!sessionId || typeof sessionId !== "string") return false;
	if (sessionId === "." || sessionId === "..") return false;
	if (sessionId.includes("/") || sessionId.includes(sep) || sessionId.includes("\\")) return false;
	if (CONTROL_CHAR.test(sessionId)) return false;
	return true;
}

/**
 * Sanitize a user-supplied fileName to a pure basename, rejecting traversal /
 * absolute / control-char inputs. Returns the cleaned basename (which may
 * differ from the input only in that path components were stripped — never
 * throws on a stray `/`, it just takes the final segment, matching POSIX
 * basename semantics). Returns `undefined` when nothing usable remains.
 *
 * Defense layers:
 *  1. Strip any `..` segment after posix normalize — handled by caller via
 *     path.resolve + startsWith containment check (the ultimate guard).
 *  2. Replace backslashes (Windows path sep) with posix slash, then basename —
 *     so `..\..\x` collapses to `x`.
 *  3. Reject residual control chars (null byte etc.) in the basename.
 *  4. Reject reserved Windows device names (`CON`, `PRN`, `NUL`, …) and the
 *     empty result.
 */
export function sanitizeFileName(fileName: string): string | undefined {
	if (!fileName || typeof fileName !== "string") return undefined;
	// Reject control chars (incl. NUL) in the RAW input FIRST — before any path
	// segmenting. Otherwise a `foo\0../../x` slips through because basename takes
	// the trailing `x` segment and the NUL (which lived in an earlier segment)
	// is gone. Checking the raw string closes that hole.
	if (CONTROL_CHAR.test(fileName)) return undefined;
	// Treat backslash as a separator so a Windows-style traversal collapses.
	const posixified = fileName.replace(/\\/g, "/");
	// basename defends against `a/b`, `/abs`, `..`, `../x`.
	const base = basename(posixified);
	if (!base || base === "." || base === "..") return undefined;
	// Reject Windows reserved device names (CON, PRN, AUX, NUL, COM1.., LPT1..).
	const upper = base.toUpperCase();
	const devBase = upper.split(".")[0];
	if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(devBase)) return undefined;
	return base;
}

/**
 * Infer the attachment kind from a MIME type (set ONCE at upload; downstream
 * never re-derives). `image/*` → image (inline-able by multimodal providers);
 * `application/pdf` → pdf (always meta-text, never inlined); anything else →
 * file. Case-insensitive on the type prefix.
 */
export function inferKind(mimeType: string): AttachmentKind {
	const mt = (mimeType ?? "").trim().toLowerCase();
	if (mt.startsWith("image/")) return "image";
	if (mt === "application/pdf") return "pdf";
	return "file";
}

/**
 * Resolve and VALIDATE that `diskPath` lives strictly inside
 * `ATTACHMENTS_ROOT/<sessionId>/`. Returns the normalized absolute path on
 * success, or throws if containment fails. This is the single security choke
 * point: even if an upstream sanitizer misses an escape vector, this check
 * rejects any final path outside the session directory.
 *
 * We require the canonical `dir/` (with trailing separator) prefix match so
 * `/attachments/foo` does NOT count as containing `/attachments/foobar/x`.
 */
export function assertWithinSession(sessionId: string, diskPath: string): string {
	if (!isValidSessionId(sessionId)) {
		throw new Error(`attachment-store: invalid sessionId`);
	}
	const sessionDir = resolve(join(ATTACHMENTS_ROOT, sessionId)) + sep;
	const resolved = resolve(diskPath);
	// Force both to use the same separator for the prefix compare on Windows
	// (resolve already normalizes, but be explicit + platform-independent).
	const dirNorm = sessionDir.split(sep).join(posix.sep);
	const resNorm = (resolved + sep).split(sep).join(posix.sep);
	if (!resNorm.startsWith(dirNorm)) {
		throw new Error(`attachment-store: path escapes session directory`);
	}
	return resolved;
}

export interface SavedAttachment {
	meta: AttachmentMeta;
	/** Absolute path the bytes were written to (== meta.diskPath). */
	diskPath: string;
}

/**
 * Persist uploaded attachment bytes to the session's attachment directory.
 *
 * Layout: `ATTACHMENTS_ROOT/<sessionId>/<id>-<sanitized-name>` (id prefix
 * dedupes identical filenames within a session without rewriting them).
 *
 * @returns the stored bytes' Buffer.
 */
export async function saveAttachment(input: {
	sessionId: string;
	fileName: string;
	mimeType: string;
	/** base64-encoded bytes (renderer → main crosses JSON, so base64 is forced). */
	dataBase64: string;
}): Promise<AttachmentMeta> {
	if (!isValidSessionId(input.sessionId)) {
		throw new Error(`attachment-store: invalid sessionId`);
	}
	const safeName = sanitizeFileName(input.fileName);
	if (!safeName) {
		throw new Error(`attachment-store: invalid fileName`);
	}

	const id = randomUUID();
	const sessionDir = resolve(join(ATTACHMENTS_ROOT, input.sessionId));
	const diskPath = assertWithinSession(input.sessionId, join(sessionDir, `${id}-${safeName}`));

	// base64 decode. Allow url-safe variant + whitespace tolerance.
	const cleaned = input.dataBase64.replace(/\s+/g, "");
	const buf = Buffer.from(cleaned, "base64");
	if (buf.length === 0) {
		throw new Error(`attachment-store: empty data`);
	}

	await fs.mkdir(sessionDir, { recursive: true });
	// 'wx' = write-exclusive: fail if the file already exists. The id prefix is
	// a uuid so collisions should never happen; this guards against a symlink
	// planted at the target (TOCTOU hardening).
	await fs.writeFile(diskPath, buf, { flag: "wx" });

	return {
		id,
		kind: inferKind(input.mimeType),
		fileName: safeName,
		mimeType: input.mimeType,
		size: buf.length,
		diskPath,
	};
}

/**
 * Read attachment bytes back from disk. Used by the two "edges" that touch
 * bytes (design principle A): getMessages (LLM inline) and the
 * attachment-serving endpoint (UI thumbnail).
 *
 * @param diskPath absolute path previously returned by saveAttachment.
 * @throws if `diskPath` is not contained in the given session's dir.
 */
export async function readAttachment(sessionId: string, diskPath: string): Promise<Buffer> {
	const resolved = assertWithinSession(sessionId, diskPath);
	return fs.readFile(resolved);
}

/**
 * Remove a single attachment file. No-op (returns false) if the file is gone.
 * Path must be contained in the session dir.
 */
export async function deleteAttachment(sessionId: string, diskPath: string): Promise<boolean> {
	const resolved = assertWithinSession(sessionId, diskPath);
	try {
		await fs.unlink(resolved);
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Recursively delete a session's entire attachment directory. Called from the
 * session delete path (session-router.ts `DELETE /:agentId/:sessionId`).
 *
 * Safe to call when the directory doesn't exist (returns 0). Best-effort: a
 * failure to remove one entry does not abort the sweep.
 *
 * @returns number of top-level files removed (best-effort count); -ish meaning
 *   only that the directory is gone afterwards.
 */
export async function cleanSessionAttachments(sessionId: string): Promise<number> {
	if (!isValidSessionId(sessionId)) return 0;
	const sessionDir = resolve(join(ATTACHMENTS_ROOT, sessionId));
	// Containment re-check (same logic as assertWithinSession but against the
	// root) — defends against a sessionId that survives isValidSessionId yet
	// resolves somewhere odd.
	const root = ATTACHMENTS_ROOT + sep;
	const dirNorm = root.split(sep).join(posix.sep);
	const sessNorm = (sessionDir + sep).split(sep).join(posix.sep);
	if (!sessNorm.startsWith(dirNorm)) return 0;
	// No-op (return 0) when the dir is already gone. We check explicitly because
	// fs.rm({force:true}) succeeds on a missing path, which would otherwise
	// report "1 removed" for a no-op.
	try {
		await fs.access(sessionDir);
	} catch {
		return 0;
	}
	try {
		await fs.rm(sessionDir, { recursive: true, force: true });
	} catch {
		// best-effort — swallow; caller (session delete) should not fail because
		// attachment cleanup errored.
		return 0;
	}
	return 1;
}
