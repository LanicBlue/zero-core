# sub-1:统一 content shape + per-session 落盘 + `attachments:upload` 端点

- **effort**:multimodal-input
- **依赖**:无
- **关联**:原则 A(唯一 bytes 进 main 口)、组件 1/2

## 范围

定义四层共用的 `AttachmentMeta` / `UserContent` shape;实现 per-session 附件目录 + **`attachments:upload`** IPC/REST 端点(renderer 传 base64 bytes + meta → main 落盘 → 返 `AttachmentMeta` 含 diskPath)。**路径安全**:sessionId/fileName sanitize(basename only,限 `ZERO_CORE_DIR/attachments/<sessionId>/` 内,防 traversal)。

## 交付物

- `src/shared/types.ts`(或 multimodal types 文件):`AttachmentKind`、`AttachmentMeta`、`UserContent`。
- `src/server/attachment-store.ts`(或 router):落盘到 `ZERO_CORE_DIR/attachments/<sessionId>/<id>-<name>`;CRUD/read;session 删除时清理目录(挂 session 生命周期)。
- `attachments:upload` 端点(ipc-api + preload + router):入参 `{ sessionId, fileName, mimeType, data(base64) }` → 落盘 → 返 `AttachmentMeta`。kind 由 mimeType 推(image/* → image;application/pdf → pdf;else file)。
- 路径安全工具 + 单测。

## 不做

chat:send 携带 meta 接线(sub-4)、session/turns 存储(sub-2)、UI(sub-5)。

## 验收

见 `./acceptance-1.md`。
