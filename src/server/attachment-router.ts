// Attachment upload REST router (effort: multimodal-input, sub-1).
//
// # 文件说明书
//
// ## 核心功能
// 唯一让附件字节进 main 进程的入口(design 顶层原则 A)。POST /api/attachments/upload
// 接收 { sessionId, fileName, mimeType, data(base64) } → 落盘 → 返 AttachmentMeta
// (含 diskPath)。之后 chat:send 只带 meta,不再带字节。
//
// ## 路径安全
// 全部由 attachment-store.ts 兜底(sessionId/fileName sanitize + resolved
// diskPath startsWith 会话目录校验)。router 层只做参数存在性检查。
//
// ## 输入
// - POST body: { sessionId, fileName, mimeType, data }
//
// ## 输出
// - 201 + AttachmentMeta(JSON)
// - 400 on missing/invalid params; 500 on store error
//
// ## 定位
// src/server/ — 挂载于 /api/attachments(server/index.ts)。
//
// ## 维护规则
// - 不在此处添加任何落盘/路径拼接逻辑(全走 attachment-store)。
// - 后续 sub 若加 GET 附件内容端点(组件 8),新建独立 router 或在此扩展,
//   但仍走 store 的 readAttachment(sessionId, diskPath)。
//
import { Router } from "express";
import { saveAttachment } from "./attachment-store.js";

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

	return router;
}
