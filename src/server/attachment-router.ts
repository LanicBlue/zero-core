// Attachment upload + content REST router (effort: multimodal-input, sub-1 + sub-5).
//
// # 文件说明书
//
// ## 核心功能
// 两个 bytes 相关端点(design 顶层原则 A 的两个"边缘"):
//   1. POST /api/attachments/upload  —— 唯一让附件字节进 main 的口。接收
//      { sessionId, fileName, mimeType, data(base64) } → 落盘 → 返 AttachmentMeta
//      (含 diskPath)。之后 chat:send 只带 meta,不再带字节。
//   2. POST /api/attachments/content —— UI 渲染边缘(组件 8)。接收
//      { sessionId, diskPath, mimeType? } → 读盘 → 返 { data(base64), mimeType,
//      size }。供历史消息附件缩略图渲染用(本地 paste 预览不经此端点)。
//
// ## 路径安全
// 全部由 attachment-store.ts 兜底:
//   - upload:saveAttachment 内 sessionId/fileName sanitize + resolved
//     diskPath startsWith 会话目录校验。
//   - content:readAttachment 内 assertWithinSession 同一兜底(必须是
//     ATTACHMENTS_ROOT/<sessionId>/ 内)。router 层只做参数存在性检查,
//     绝不在本文件拼接路径。
//
// ## 输入
// - upload POST body: { sessionId, fileName, mimeType, data(base64) }
// - content POST body: { sessionId, diskPath, mimeType? }
//
// ## 输出
// - upload:201 + AttachmentMeta(JSON);400 on missing/invalid params;500 on store error
// - content:200 + { data, mimeType, size };400 on missing/invalid/traversal;404 ENOENT;500
//
// ## 与 file-router 的区别(content 端点)
// file-router 拒二进制 + 500KB 限 + 只返 UTF-8。content 端点专门支持二进制 image
// (无大小上限,附件已在 upload 时校验)。返 JSON-wrapped base64(非裸二进制)因
// ipc-proxy 桥 HTTP + JSON.stringify → JSON.parse 无法传二进制。
//
// ## 定位
// src/server/ — 挂载于 /api/attachments(server/index.ts)。
//
// ## 维护规则
// - 不在此处添加任何落盘/路径拼接逻辑(全走 attachment-store)。
//
import { Router } from "express";
import { saveAttachment, readAttachment } from "./attachment-store.js";

export function createAttachmentRouter(): Router {
	const router = Router();

	/**
	 * POST /upload — persist one attachment's bytes, return its meta.
	 *
	 * Body: { sessionId: string; fileName: string; mimeType: string; data: string }
	 *   `data` is base64-encoded (the IPC bridge JSON.stringifies everything, so
	 *   binary must be base64 — see design 现状表 / ipc-proxy buildReq).
	 */
	router.post("/upload", async (req, res) => {
		const body = req.body ?? {};
		const { sessionId, fileName, mimeType, data } = body as {
			sessionId?: string; fileName?: string; mimeType?: string; data?: string;
		};
		if (!sessionId || !fileName || !mimeType || typeof data !== "string") {
			res.status(400).json({ error: "sessionId, fileName, mimeType, data are required" });
			return;
		}
		try {
			const meta = await saveAttachment({ sessionId, fileName, mimeType, dataBase64: data });
			res.status(201).json(meta);
		} catch (err) {
			// Path-safety violations surface as generic 400s so they can't be
			// distinguished from missing params (no path-disclosure leak);
			// genuine server errors get 500.
			const msg = (err as Error).message ?? "upload failed";
			if (msg.startsWith("attachment-store: invalid sessionId")
				|| msg.startsWith("attachment-store: invalid fileName")
				|| msg.startsWith("attachment-store: path escapes")
				|| msg.startsWith("attachment-store: empty data")) {
				res.status(400).json({ error: msg });
				return;
			}
			res.status(500).json({ error: msg });
		}
	});

	/**
	 * POST /content (sub-5 / 组件 8) — UI-rendering edge: read a HISTORY
	 * attachment's bytes back from disk and return them base64-encoded.
	 *
	 * Unlike file-router (which rejects binary + caps at 500KB), this endpoint
	 * exists specifically to serve image bytes for `<img>` thumbnails, so it
	 * allows binary and has no size cap (attachments are user-uploaded, already
	 * vetted at upload).
	 *
	 * Body: { sessionId: string; diskPath: string; mimeType?: string }
	 *
	 * Path safety is fully delegated to `readAttachment` →
	 * `assertWithinSession`, which requires `diskPath` to resolve strictly
	 * inside `ATTACHMENTS_ROOT/<sessionId>/`. Even a crafted diskPath that
	 * survives param checks is rejected by that containment test (the ultimate
	 * guard against traversal).
	 *
	 * The result is JSON-wrapped base64 (NOT raw binary) because the IPC bridge
	 * routes this through HTTP + JSON.stringify → JSON.parse (ipc-proxy), which
	 * cannot transport arbitrary binary. The renderer decodes base64 → Blob →
	 * object URL → `<img src>`.
	 */
	router.post("/content", async (req, res) => {
		const body = req.body ?? {};
		const { sessionId, diskPath, mimeType } = body as {
			sessionId?: string; diskPath?: string; mimeType?: string;
		};
		if (!sessionId || typeof sessionId !== "string" || typeof diskPath !== "string" || !diskPath) {
			res.status(400).json({ error: "sessionId and diskPath are required" });
			return;
		}
		try {
			const buf = await readAttachment(sessionId, diskPath);
			res.status(200).json({
				data: buf.toString("base64"),
				// Prefer the caller's mime (it carries the original upload mime on
				// AttachmentMeta); fall back to application/octet-stream so the
				// renderer always has a content-type for the Blob.
				mimeType: typeof mimeType === "string" && mimeType ? mimeType : "application/octet-stream",
				size: buf.length,
			});
		} catch (err) {
			// readAttachment throws on: invalid sessionId, path-escape (traversal),
			// or ENOENT (file gone). The first two are 400 (client error /
			// security), ENOENT is 404, anything else is 500. All surface as a
			// generic message so the path itself is never echoed back.
			const msg = (err as Error).message ?? "content read failed";
			if (msg.startsWith("attachment-store: invalid sessionId")
				|| msg.startsWith("attachment-store: path escapes")) {
				res.status(400).json({ error: msg });
				return;
			}
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				res.status(404).json({ error: "attachment not found" });
				return;
			}
			res.status(500).json({ error: msg });
		}
	});

	return router;
}
