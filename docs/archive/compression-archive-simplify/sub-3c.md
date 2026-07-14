# sub-3c:双机制 Force/Remind + memory ephemeral turn 协调

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:**sub-3b**(compressSession 滚动摘要)+ **sub-2**(ephemeral turn)。原 sub-3 拆分的第三段(触发层)。

## 范围

压缩触发改双机制(Force 协调 / Remind 自判);Force 档用 sub-2 memory ephemeral turn 替代 ExtractorA 写记忆。详见 design「二、压缩流程」Force/Remind 段 + 「Q2 / GAP1」。

## 改动

- **Force 档**(cold / hot+hard):[compression-trigger-hooks.ts](../../../src/runtime/hooks/compression-trigger-hooks.ts) 检测阈值 → **不直接 compress,改 signal AgentLoop**;Loop 协调:跑 memory ephemeral turn(sub-2,`persist:false`)→ `compressSession`。hook 不能跑嵌套 turn,必须 Loop 协调。
- **Remind 档**(hot+soft):hook 注入 appendMessage 提示("上下文偏大,可写 memory;若认为该压缩就表示")→ agent 自写 memory + 自判压缩。(agent "请求压缩"机制——ack 解析 vs Compress 工具——本 sub 内定。)
- **memory turn step 不落盘**:Force 档的 memory ephemeral turn 不写 steps(回归 sub-2)。

## 不做(scope 边界)

- 不动滚动摘要/handoff/cap(sub-3b)/ 数据模型(sub-3a)/ 归档(sub-4)。
- 不删 `extractor-a-service.ts` 主体(sub-5)。

## 验证

见 [./acceptance-3c.md](./acceptance-3c.md)。
