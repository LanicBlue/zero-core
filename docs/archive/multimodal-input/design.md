# Design:multimodal-input

- **状态**:④ archive(已合并)
- **提出**:2026-07-08(issue);design 2026-07-09
- **类型**:功能 / 架构

## 目标(本 effort 范围,用户已定)

把用户输入从 `string` 升级为**多模态 content**,打通四层(前端控件+state、IPC 契约、AgentLoop/provider 消息构造、持久化),让用户能粘贴/拖拽/选择 **图片 + PDF + 任意文件附件** 交给 agent。

## 决策(已敲定 2026-07-09)

- **D1 范围**:图片 + PDF + 任意文件附件(最广)。
- **D2 存储**:附件**落盘到 per-session 目录**(`ZERO_CORE_DIR/attachments/<sessionId>/`),消息只存引用路径 + 元数据。不 base64 内嵌进持久化。
- **D3 降级 = capability-aware 优雅注入,不拒绝不静默剥**:无论 provider 支不支持都发送 ——
  - API 支持 **image** **且当前 step** → 从盘读出、按 AI SDK content array **inline** 给 LLM(仅当轮)。**image-only**(PDF/任意文件不 inline)。
  - API 不支持,或**历史 step**,或 PDF/任意文件 → 把附件**元信息**(类型/路径/大小 + 提示)作为**文本**注入,让 **LLM 自行判断**怎么处理(file-read 工具 / MCP / 委派 subagent… 例如委派给能读图的 claude)。
  - **inline 只对当前 step + image;历史与 PDF/文件一律元信息**(用户 2026-07-09 定,见组件 3)。

## 非目标

- 不做音视频流式输入(仅静态图片/PDF/文件)。
- 不做 provider 能力的自动 OCR/转写(LLM 自己决定调用什么工具)。

## 顶层原则 A:bytes 只在边缘消费,内部全元信息(用户 2026-07-09 定)

附件的**字节**只在两个"边缘"被读用 —— **① 发 LLM 时(getMessages inline)、② UI 渲染时(缩略图)**。其余一切(持久化、IPC、session/loop 内部 step、turns 列)**只流转元信息** `AttachmentMeta`(kind/fileName/mimeType/size/diskPath),**不带 bytes**。

- **唯一 bytes 进 main 的口** = `attachments:upload`(renderer→main 写盘,返 meta)。之后 diskPath 在内部流转。
- **发 LLM 边缘**:getMessages 从 diskPath 读 bytes、inline(仅当前 step + image + provider 支持)。
- **UI 渲染边缘**:ChatPanel 显示要 bytes(缩略图)→ 经**专用 attachment-serving 端点**(支持二进制,组件 8)从 diskPath 读。
- 好处:内部管道零 base64/零膨胀;IPC/持久化/runtime 全是轻 meta;bytes 永远不进 turns 表、不进 IPC body(除 upload 那一次)。

## 顶层原则 B:capability-aware,LLM 自决策

附件在消息里**始终存在**(多模态 content 或元信息文本之一),系统不替 LLM 做丢/留决定。provider 能力只决定**呈现形态**(inline vs 元信息),不决定可用性。这让 multimodal-input 与 [[../../design/external-subagent-mcp]]、file-read、MCP 天然协同 —— LLM 可委派给能读图的 subagent 处理当前 provider 看不到的图。

## 现状(真相源)

| 层 | 现状 | 文件 |
|----|------|------|
| 前端控件 | `<textarea>` value 绑 string `input` | `src/renderer/components/layout/ChatPanel.tsx:832-846` |
| 前端 state | `ChatMessage.text: string` | `src/renderer/store/chat-store.ts:54-61` |
| IPC | `chatSend(text: string, …)`;无 attachment 通道 | `src/shared/preload-types.ts:107`、`src/shared/ipc-api.ts:147` |
| **IPC 传输实情** | `ipcRenderer.invoke` 经 **`ipc-proxy.ts` 桥到 HTTP POST + `JSON.stringify`**(非直连主进程);file-router **拒二进制 + 500KB 限 + 只返 UTF-8**;全库无二进制/分段传输 | `src/main/ipc-proxy.ts:152,363`、`src/server/file-router.ts:57-79` |
| 持久化(turns 表) | `content TEXT`(nullable)**始终纯 string/null,从不 JSON**;读取处多(display+getMessages);列:`seq/role/content/compressed/turn_group/*_tokens` | `src/server/session-db.ts:144-158,679-731` |
| **db-migration** | turns/messages 是 **SessionDB 直管**(非 SqliteStore),**无 `TURNS_COLUMNS`/`MESSAGES_COLUMNS` 数组**;加列走 `initSchema` 的 `safeAddColumn`(像 turn_group 那样)—— 不涉 `*_COLUMNS` 同步陷阱 | `src/server/db-migration.ts:314-321,737-741` |
| AgentLoop 入口 | `run(userMessage: string)` | `src/runtime/agent-loop.ts:478` |
| 消息类型 | 已是 AI SDK `ModelMessage`(`getMessages(): ModelMessage[]`) | `src/runtime/session.ts:109` |
| session 存储 | step `content: string \| null` | `src/runtime/session.ts:52`、`session-store-interface.ts:31` |
| getMessages | 把 string 包成 ModelMessage(行 121/432) | `src/runtime/session.ts` |
| **UI 显示真相源** | **Runtime → `turns` 表 → `session.getCachedTurns()` → `buildStepLevelMessages()`(注释明"runtime 是 UI 唯一真相源")→ IPC `sessionsGetInit` → chat-store → ChatPanel**。**NOT** messages 表 | `src/server/agent-service.ts:1744,1761`、`src/runtime/session.ts:115,133` |
| 持久化(messages 表) | `msg_json` 存完整 AI SDK message(write-through 缓存/恢复用,**非显示真相源**) | `src/server/session-db.ts:531-537` |
| message-store.ts | **legacy**(仅迁移,文件改名 `.migrated.bak`)—— 非真相源 | `src/server/message-store.ts` |
| **模型模态数据(已存在!)** | `ProviderModel.multimodal?: boolean`,从 OpenRouter API `architecture.input_modalities.includes("image")` 填(`enrichModels`)—— **目前零消费** | `src/shared/types.ts:99`、`src/core/model-registry.ts:191` |
| 上下文窗口 UI | `context-usage` 条(model 名 + token + 窗口),数据 `ProviderModel.contextWindow` → `ContextInfo` | `src/renderer/components/layout/ChatPanel.tsx:742-767` |
| 已有读图 | `file-read` 工具支持 image/PDF(agent 主动调,非输入路径) | `src/tools/file-read.ts` |

**关键利好**:
1. **模型模态字段已存在**(`ProviderModel.multimodal`,OpenRouter 已填)→ `providerSupportsMultimodal` 直接读,不用造数据;仅需在 UI 消费 + 手动配的模型默认 `undefined`(按 D3 当不支持)。
2. **显示路径清晰**:turns 表 → `buildStepLevelMessages` → `ChatMessage`;附件标识加在 `ChatMessage` + turns content 即可显示。
3. 消息类型已是 AI SDK `ModelMessage`,provider 层 inline 多模态原生支持。

## 架构(原则 A:内部全 meta,bytes 只在两边缘)

```
[粘贴/拖拽/+号] → renderer 拿到 File(本地 bytes)
        │ IPC attachments:upload(bytes→base64 + meta)   ← 唯一 bytes 进 main 的口
        ▼
  main: 写盘 → ZERO_CORE_DIR/attachments/<sessionId>/<id>-<name>
        返 AttachmentMeta{ id, kind, fileName, mimeType, size, diskPath }
        │  (此后内部只流转 meta,不带 bytes)
        ▼
  ChatPanel input state(text + AttachmentMeta[])  ← 待发送附件预览(缩略图经组件8端点读盘)
        │ IPC chat:send(text, AttachmentMeta[])    ← 只带 meta(diskPath),不带 bytes
        ▼
  AgentLoop.run(UserContent{text, attachments: AttachmentMeta[]})
        │ session.appendStep(content=text, attachments=meta[])   ← content 仍纯字符串
        │ 持久化 turns.attachments 列 = meta[] 的 JSON            ← 只存 meta,不存 bytes
        ▼
  getMessages():【发 LLM 边缘,读 bytes】
        ├─ 当前 step + image + provider 支持 → 从 diskPath 读 bytes → content array inline
        └─ 否则(历史 / PDF / 任意文件 / 不支持)→ 元信息文本 part
        ▼
  streamText({ messages })  ← AI SDK 原生多模态

  【UI 渲染边缘,读 bytes】ChatPanel 显示历史消息附件缩略图
        → GET attachments:content?id=… (组件8,支持二进制) → 从 diskPath 读 → 渲染
```

## 组件设计

### 1. 统一 content shape(四层对齐)

```ts
type AttachmentKind = "image" | "pdf" | "file";  // file = 其它任意文件
interface AttachmentMeta {
  id: string;            // uuid
  kind: AttachmentKind;  // 按 mimeType 判定(image/* → image;application/pdf → pdf;else file)
  fileName: string;
  mimeType: string;
  size: number;
  diskPath: string;      // 绝对路径(per-session 目录下)
}
// 新的 user content 形态(替换 string):
interface UserContent { text: string; attachments: AttachmentMeta[]; }
```
四层共用此 shape:前端 state、IPC、session step、getMessages 输入。`kind` 由 mimeType 推(入口处定一次,下游不再判mime)。

### 2. per-session 落盘 + IPC 上传

- 目录:`ZERO_CORE_DIR/attachments/<sessionId>/`。session 删除时一并清(挂 session 生命周期)。
- **IPC 实情**:`invoke` 经 `ipc-proxy.ts` 桥到 HTTP POST + `JSON.stringify`(非直连主进程);structured clone 的 Uint8Array 优势用不上,二进制必须 **base64**。全库无分段/流式传输。
- **方案:独立 `attachments:upload` 端点** —— renderer 把 File → base64 + meta 发 main;main 落盘到 per-session 目录,返 `AttachmentMeta`(含 diskPath)。`chat:send` **只带 meta(含 diskPath),不带 bytes** —— 上传与发送解耦(多文件/大文件不阻塞发送、可逐个上传+进度/失败重试)。
- 粘贴/拖拽/+号在 renderer 拿到 File → 经 `attachments:upload` 落盘 → 拿 diskPath 加入 input.attachments → 发送时只带 meta。
- **大文件限制**:base64-over-JSON 对几十 MB 图/PDF 可行但吃内存;v1 接受,记为已知限制。后续可加 multipart/流式上传端点(本 effort 非目标)。

### 3. session 存储 + getMessages 构造(capability-aware)

- session step:**`content` 保持纯字符串,新增 `attachments: AttachmentMeta[]` 字段**(与 turns 新列一致,见组件 5)。**注意**:`session-store-interface.ts` 的 `appendStep/upsertStep/replaceStepsFromMessages` 签名 `content: string|null` 要加 `attachments?` 参数同步。
- `getMessages()` 构造 user ModelMessage —— **关键规则(用户定):inline 只对"当前发送的 step";所有历史 step 一律元信息文本**:
  - **当前 step**(本次刚发的 user 消息):`providerSupportsMultimodal(model)` 为 true 且 attachment.kind === **image** → inline `{type: "image", image: readBytes(diskPath), mimeType}`;否则(PDF / 任意文件 / provider 不支持)→ 元信息文本。
  - **注:image-only inline**(用户 2026-07-09 定):`ProviderModel.multimodal` 只代表 image(PDF inline 支持极稀且 flag 不含 PDF);PDF 与任意文件一律元信息(LLM 需要时 file-read diskPath,agent 的 file-read 本就支持 PDF)。
  - **历史 step**(此前所有带附件的 user 消息):**无论 provider 支不支持**,一律元信息文本 part `[attachment: <fileName> | type=<mimeType> | size=<size> | at <diskPath> — 历史附件,需看图可 file-read]`。
  - **理由**:历史每轮重发图片 → 上下文 token 爆炸;图片只在"当轮 relevant"时 inline 一次,后续退引用,LLM 需要再看就 file-read diskPath。
  - getMessages 需区分"当前 step" vs "历史"(session/loop 知道新 user 消息边界)。
- `run(userMessage)` 签名:`string` → `UserContent`(或 `string | UserContent` 兼容)。

### 4. provider 多模态能力检测(读现成字段)

- `providerSupportsMultimodal(model): boolean` = 读 **`ProviderModel.multimodal`**(已存在,OpenRouter `enrichModels` 已填)。**不造新数据源**。
- 默认:`multimodal === undefined`(手动配的模型/OpenRouter 未覆盖)→ 当**不支持**(走元信息注入,安全;LLM 仍可经工具/委派读图)。支持需 `multimodal===true`。
- 可选增强:`ProviderModel` 加 `modalities?: ("text"|"image"|"pdf"|"audio")[]` 替代布尔,粒度更细(组件 7 显示用)。v1 用布尔即可。
- 这是 D3 的判定点;检测错(把不支持的当支持)→ provider 报错,可在错误处理里降级回元信息重试(可选,impl 评估)。

### 5. 显示(走 turns → ChatMessage;非 messages 表)

- **显示真相源 = turns 表 → `buildStepLevelMessages()` → `ChatMessage`**(agent-service.ts:1744/1761)。`messages.msg_json` 只是缓存,`message-store.ts` 是 legacy —— 都不是显示源。
- `ChatMessage`(`chat-store.ts:54-61`)加 `attachments?: AttachmentMeta[]` 字段。
- `buildStepLevelMessages()` 把 step content 里的 attachments 解出,填进 ChatMessage.attachments。
- **turns 存储方案(查证后定)**:**新增 `turns.attachments TEXT` 列**(存 `AttachmentMeta[]` 的 JSON);`content` **保持纯字符串不变**(读取处极多,塞 JSON 要到处条件 parse,代价大)。迁移 = `initSchema` 里一句 `safeAddColumn(db,"turns","attachments","TEXT")`(turns 是 SessionDB 直管,**无 `*_COLUMNS` 数组要同步**)。
- `getSteps` 返回值 + `buildStepLevelMessages` 读 `attachments` 列填进 `ChatMessage.attachments`;`appendStep/upsertStep` 签名加 `attachments?: AttachmentMeta[]` 参数。
- ChatPanel 渲染:user 消息末尾附件标识(image → 缩略图;pdf/file → 文件名+图标+大小),可点开。

### 6. 前端 UX

- ChatPanel 输入区:
  - **"+" 按钮导入文件**(`<input type=file multiple>`)—— 图片/PDF/任意文件均可。
  - **拖拽**(dropzone)图片或文件到输入区。
  - **粘贴**(paste 事件)图片或文件。
- 待发送附件区:image → 缩略图;pdf/file → 文件名+图标+大小。可删除。
- 发送:`chatSend(text, attachments)`;允许"仅附件无文本"。

### 7. 模型模态显示(补在现有上下文窗口旁)

- 现有 `context-usage` 条(`ChatPanel.tsx:742-767`)已显示 model 名 + token + 窗口。在其旁/下方补**模态标识**:当前模型支持哪些输入模态(image/pdf/text…),数据源 `ProviderModel.multimodal`(或增强的 `modalities[]`)。
- 显示形态:小图标/标签(如 🖼 image、📄 pdf);`multimodal===undefined` 显示"模态未知"或干脆不标。
- 数据通路:`ContextInfo.model`(已有 providerName+modelId)→ 经 IPC 补带当前模型的 `multimodal`/`modalities`(agent-service.ts:1708 `sessionsGetInit` payload 加一项)→ chat-store `ContextInfo` 加字段 → ChatPanel 渲染。
- 意义:用户一眼看出当前模型能不能直读图,配合 D3(不支持则元信息注入、LLM 自决策)做心理预期。

### 8. UI 渲染边缘:attachment-serving 端点(原则 A 暴露的新组件)

- 原则 A 下,bytes 只在边缘读;UI 渲染历史消息附件缩略图需要 bytes → 需要一个**支持二进制**的读取端点(现有 `file-router` 拒二进制 + 500KB 限,**用不了**)。
- 新端点 `attachments:content`(或 `GET /api/attachments/:id`):按 attachment id/sessionId 解 diskPath → 读盘 → 返 image bytes(image 直接以 image content-type 返,renderer `<img src>` 用;或 base64)。**路径安全**:id/sessionId 校验 + 只许 `ZERO_CORE_DIR/attachments/<sessionId>/` 内(防 traversal)。
- 待发送附件(renderer 本地刚 paste 的 File):预览用本地 `URL.createObjectURL(File)`,**无需经此端点**;只有从 turns 加载的历史附件缩略图才经此端点读盘。

## 组件依赖与接线补注

- **原则 A 落点**:组件 2(upload,唯一 bytes 口)+ 组件 8(UI 读 bytes)+ 组件 3(getMessages 读 bytes 发 LLM)= 三个接触 bytes 的地方;其余组件(1/5/6/7)只处理 meta。
- **#3 wiring(已解)**:`providerSupportsMultimodal` 搭 **`getContextWindow` 同一条解析路径** —— 该函数(`provider-factory.ts:121-131`)已做 `provider.models.find(m=>m.id===modelId)`,拿到的就是 `ProviderModel`,`multimodal` 就在同一对象上。加个 `getMultimodal(providers,providerName,modelId): boolean`(返 `model?.multimodal ?? false`)或泛化 `resolveModelCapability → {contextWindow, multimodal}`;agent-loop 在 `getContextWindow` 旁(`agent-loop.ts:168`)一并解析,像 contextWindow 一样传给 session/getMessages。**无新 wiring,纯搭便车**。呼应 [[feedback-verify-runtime-wiring]](下游 getMessages 真消费该值)。

## 决策点(design→plan gate)

- **已定**:
  - **原则 A**(bytes 只在发 LLM + UI 渲染两边缘;内部全 meta)+ **原则 B**(capability-aware,LLM 自决策)。
  - D1 范围、D2 per-session 落盘+引用、D3 **image-only inline**(当前 step;历史/PDF/文件/不支持 → 元信息)。
  - UX(+号/拖拽/粘贴)、模态显示(组件 7)、UI 渲染端点(组件 8)。
- **已查清(原待定/impl)**:
  - 显示真相源 = **turns → buildStepLevelMessages → ChatMessage**(非 messages 表/message-store)。
  - `providerSupportsMultimodal` = 读现成 `ProviderModel.multimodal`(组件 4)。
  - IPC:独立 `attachments:upload` 端点落盘返 diskPath,`chat:send` 只带 meta;base64-over-JSON 为已知限制。
  - turns 存附件:新增 `turns.attachments TEXT` 列(JSON),`content` 保持纯字符串;迁移走 `safeAddColumn`(无 `*_COLUMNS` 数组)。
- **仍待 trace/确认(进 plan 前定)**:
  - ~~#3 wiring~~ **已解**:搭 `getContextWindow` 同车(provider-factory.ts:121 已 find ProviderModel,multimodal 同对象)。见「组件依赖与接线补注」。
  - upload/content 端点路径安全(sessionId/fileName sanitize,防 traversal)。
  - compression 与多模态 content array 的交互(大概率安全,记)。

## 风险

- **getMessages token 体积**:已由设计规则控制 —— **inline 只对当前 step,历史一律元信息文本**(组件 3),避免历史每轮重发图片爆 token。当前 step 多图/大图仍放大当轮请求(可接受)。
- **provider 能力误判**:`multimodal===undefined`(手动配的模型)默认当不支持 → 走元信息注入(安全);若误标 true → API 报错,可降级重试(impl 评估)。
- **per-session 目录生命周期**:session 删 → 附件删;消息被归档/导出时附件引用会断 —— 导出场景需配套(本 effort 非目标,记)。
- **db-migration**:**turns 是 SessionDB 直管,无 `*_COLUMNS` 数组** —— 加 `attachments` 列只需 `initSchema` 里一句 `safeAddColumn`(不涉 [[feedback-fresh-db-migrations]] 的 COLUMNS 同步陷阱,那条只针对 SqliteStore 表)。
- **OpenRouter 未覆盖的模型** `multimodal` 为 undefined → 用户可在 provider 配置页手填(true/false);UI 模态显示对 undefined 标"未知"。

## sub 拆分预案(进 plan 细化)

- sub-1:统一 content shape(`AttachmentMeta`/`UserContent`)+ per-session 落盘 + **`attachments:upload` 端点**(唯一 bytes 口,路径安全)+ 单测。
- sub-2:session 存储升级(step 加 `attachments` 字段;`session-store-interface` 签名同步;新增 `turns.attachments` 列 + `safeAddColumn`;**含 `rebuildFromTurns` 加载 attachments**)+ 单测。
- sub-3:`providerSupportsMultimodal`(读 `ProviderModel.multimodal`,**agent-loop 解析传入 getMessages**)+ getMessages **image-only inline + 当前 step 规则 + 历史元信息**+ 单测。
- sub-4:`AgentLoop.run` 签名 string→UserContent + 接线 + `buildStepLevelMessages`/`ChatMessage.attachments` 显示通路。
- sub-5:前端 UX(**+号/拖拽/粘贴**/预览/删除)+ 发送 + **`attachments:content` 端点(历史附件缩略图读盘)**。
- sub-6:**模型模态显示**(context-usage 旁补模态标识;`sessionsGetInit` payload + `ContextInfo` 字段 + ChatPanel 渲染;provider 配置页可手填 multimodal)。
- sub-7:E2E(粘贴图 → mock provider inline 路径;不支持 provider → 元信息注入;历史附件缩略图经 content 端点显示;模态标识)。

## 下一步

进③ plan:把 sub 草图细化成 `sub-N.md` + `acceptance-N.md` 一一对应(待 design 定稿 + 用户同意进 plan)。

## 参考

- 地基真相源:见上「现状」表 file:line。
- 关联:[[../../design/external-subagent-mcp]](LLM 可委派读图)、[[feedback-fresh-db-migrations]]、[[feedback-verify-runtime-wiring]](getMessages 下游真消费)。
