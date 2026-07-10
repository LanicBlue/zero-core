# sub-5:前端 UX(+号/拖拽/粘贴)+ `attachments:content` 端点

- **effort**:multimodal-input
- **依赖**:sub-1(upload)、sub-4(chat:send 接线 + ChatMessage.attachments)
- **关联**:组件 6(UX)、组件 8(UI 渲染端点)

## 范围

ChatPanel 输入区:**+号导入**(`<input type=file multiple>`)+ **拖拽**(dropzone)+ **粘贴**(paste 事件);待发送附件区预览(image 缩略图用本地 `URL.createObjectURL`)/删除;发送 `chatSend(text, attachments)`(允许仅附件无文本)。**`attachments:content` 端点**(组件 8):支持二进制,按 id/sessionId 解 diskPath 读盘返 image bytes,**路径安全**;历史消息附件缩略图经此端点显示。

## 交付物

- `src/renderer/components/layout/ChatPanel.tsx`:输入区 +号/拖拽/粘贴 + 待发送附件区(preview/删除);renderer 拿到 File → `attachments:upload`(sub-1)落盘 → 加 input.attachments → 发送只带 meta。
- `src/renderer/components/...`:历史消息附件渲染(image → 经 `attachments:content` 端点缩略图;pdf/file → 文件名+图标+大小)。
- `attachments:content` 端点(ipc-api + preload + router):`{ sessionId, attachmentId }` → diskPath → image bytes(路径安全,限 attachments 目录)。
- 单测。

## 不做

模态显示(sub-6)、E2E(sub-7)。

## 验收

见 `./acceptance-5.md`。
