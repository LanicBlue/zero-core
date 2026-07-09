# sub-3:`providerSupportsMultimodal` + getMessages(image-only inline + 当前 step 规则)

- **effort**:multimodal-input
- **依赖**:sub-2(step 带 attachments)
- **关联**:组件 3、组件 4;原则 B;#3 wiring

## 范围

实现 `providerSupportsMultimodal`(搭 `getContextWindow` 同车,`provider-factory.ts:121` 已 find ProviderModel,加 `getMultimodal` 返 `model?.multimodal ?? false`,或泛化 `resolveModelCapability`)。getMessages 构造 user ModelMessage:**image-only inline + 当前 step 规则 + 历史一律元信息**。

## 规则(getMessages)
- **当前 step**(最近一条 user step,该 turn 内多步都算当前)+ `providerSupportsMultimodal` true + kind==="image" → inline `{type:"image", image: readBytes(diskPath), mimeType}`(从盘读 bytes)。
- **历史 step**(此前带附件的 user step)/ PDF / 任意文件 / provider 不支持 → 元信息文本 part `[attachment: <fileName> | type=<mimeType> | size=<size> | at <diskPath> — <提示>]`。
- getMessages 需知"当前 vs 历史"边界(session/loop 知道最近 user step)。

## 交付物

- `src/runtime/provider-factory.ts`:`getMultimodal(providers, providerName, modelId): boolean`(或 `resolveModelCapability`)。
- `src/runtime/agent-loop.ts`:在 `getContextWindow` 旁(:168)解析 multimodal,传入 session/getMessages。
- `src/runtime/session.ts`:getMessages 按 image-only + 当前 step 规则构造。
- 单测。

## 不做

run 签名(sub-4)、UI(sub-5)。

## 验收

见 `./acceptance-3.md`。
