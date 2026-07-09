# sub-4:`AgentLoop.run` 签名 + chat:send 接线 + 显示通路

- **effort**:multimodal-input
- **依赖**:sub-1(upload/meta)、sub-2(step 存储)、sub-3(getMessages)
- **关联**:组件 3(run 签名)、组件 5(显示);原则 A(chat:send 只带 meta)

## 范围

`AgentLoop.run(userMessage: string)` → `UserContent`(列调用点:chat send / recovery / delegation 等,定死一种,兼容旧 string 入参);`chat:send` IPC 契约加 attachments(只带 meta,含 diskPath,不带 bytes);agent-service 把 UserContent 传给 run;显示通路 `buildStepLevelMessages` 把 step attachments 填进 `ChatMessage.attachments`。

## 交付物

- `src/runtime/agent-loop.ts`:`run(userMessage: string | UserContent)`(内部归一);所有调用点核对。
- `src/shared/ipc-api.ts`/`preload-types.ts`/`preload`:`chat:send` 加 attachments 参数。
- `src/server/agent-service.ts`(chat router):接收 attachments → 构造 UserContent → 传 run。
- `src/server/agent-service.ts`:`buildStepLevelMessages`(:1761)填 `ChatMessage.attachments`。
- `src/renderer/store/chat-store.ts`:`ChatMessage` 加 `attachments?: AttachmentMeta[]`。
- 单测/接线测。

## 不做

前端输入 UX(sub-5)、模态显示(sub-6)。

## 验收

见 `./acceptance-4.md`。
