# Issue:multimodal-input

- **状态**:④ archive(已合并)
- **提出**:2026-07-08
- **类型**:改进(功能 / 架构)

## 问题

用户输入当前**只能传 string**,全链路(textarea → IPC → AgentLoop → provider → 持久化)都没有图片 / 文件 / 多模态内容的位置。agent 自身有读图能力(`file-read` 工具支持 image/PDF),但用户无法直接粘贴图片到对话框交给 LLM。需要把输入从 `string` 升级为多模态 content,打通前端控件、IPC 契约、provider 消息构造、持久化四层。

## 现状 / 真相源 / 影响面

### 前端(纯文本)
- `src/renderer/components/layout/ChatPanel.tsx:832-846` — 唯一输入控件是 `<textarea>`,value 绑定 `input` 字符串 state。
- `src/renderer/store/chat-store.ts:54-61` — `ChatMessage` 接口:`role` + `text: string`(无 image/media 字段)。
- `src/renderer/store/input-queue-store.ts:26-32` — `InputQueueItemView.content: string`。
- 无 `<input type="file">` / 拖拽区 / 粘贴图片处理(`src/renderer/components/` 下无相关代码)。

### IPC 契约(纯文本)
- `src/shared/preload-types.ts:107` — `chatSend(text: string, ...)`。
- `src/shared/ipc-api.ts:147` — `"chat:send"` params `[text: string, ...]`。
- 无 `attachment` / `upload` / `paste` 通道。

### AgentLoop / provider(纯文本)
- `src/runtime/agent-loop.ts:478` — `async run(userMessage: string)`。
- `src/runtime/agent-loop.ts:1484-1500` — `streamText({ messages })`,消息来自 `session.getMessages()`(shape `{role, content: string}`)。
- `src/runtime/context-message.ts` — `buildContextMessage()` 返回 `string`。
- `src/core/provider-adapter.ts:29-46` — `ProviderAdapterResult` 只含文本适配字段,无 image/multipart。
- `src/runtime/provider-factory.ts` — `resolveModel()` 未注入 multimodal 配置。
- `src/` 下无 `image_url` / `content:[{type:"image_url"}]` / `multipart` 匹配。

### 持久化(纯文本)
- `src/server/message-store.ts:27-33` — `StoredMessage`:`id, role, text, timestamp, toolCalls`(仅 `text: string`)。

### 已有的读图能力(非输入路径,参考)
- `src/tools/file-read.ts` — 工具可读 image/PDF(`docs/arch/02-module-structure.md:33` 提及),但这是 **agent 主动调工具**,不是用户输入多模态。

### gap(待 design 定)
- 四层全要改:前端控件 + state、IPC 契约、provider 消息构造(AI SDK `content` array)、`StoredMessage`/turns 持久化。
- 图片存放策略(本地文件 vs base64 内嵌 vs blob 引用)与 token 预算。
- 各 provider 对 multimodal 的支持差异(适配层如何归一)。

## 下一步

进② design 细化方案(`/effort design`)。design 要定:
- 多模态 content 的统一 shape(前端 state、IPC、持久化、provider 四层对齐)。
- 图片存储策略(文件落盘 + 引用,还是内嵌)与生命周期。
- provider 适配:哪家支持、不支持时如何降级(转文字 / 拒绝)。
- 输入 UX(粘贴 / 拖拽 / 选择按钮)与预览。
