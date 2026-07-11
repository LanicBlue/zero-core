# Issue:prompt-cache-control(显式 prompt cache)

- **状态**:① issues(问题记录)
- **提出**:2026-07-11
- **类型**:改进 / 机制加固

## 问题

zero-core 调 LLM 时不发 `cache_control` 标记,只吃到各家**不透明的隐式 prompt cache**;对支持**显式缓存**的 provider(Anthropic / 阿里 DashScope / 火山方舟·豆包 / Moonshot Kimi)拿不到**确定性命中 + 优惠计费**(命中可省 50–90% 输入价)。

## 现状 / 真相源 / 影响面

- steps-overhaul 落地的 `Provider.cacheTtlMs`(`src/shared/types.ts` Provider 接口 + `src/runtime/hooks/compression-trigger-hooks.ts` `resolveCacheTtl` + ProviderEditor UI)只是**被动判定冷热**(距上次 LLM call > TTL → 压缩免费),**不主动构造缓存**。
- 显式缓存要客户端在 messages/system **前缀打标记**:Anthropic `cache_control:{type:"ephemeral"}`(最多 4 个 breakpoint);阿里 `cache_control`;火山方舟 Context API;Kimi Context Caching(显式创建 + TTL)。zero-core 经 AI SDK 发请求,**未构造任何 cache_control 标记**。
- 各家显式缓存计费(命中价 / 创建价):Anthropic 命中 ~10% 输入价;阿里显式命中 25%、创建 125%;火山/Kimi 类似。**当前长 prefix 全付全价,命中靠运气**。
- 天然可缓存前缀(steps-overhaul 已有):三区组装后的 `[summary] + [system prompt]` 前缀(`src/runtime/session.ts` `assembleLLMView`)——稳定、重复率高,是理想的 cache breakpoint 位置。
- 影响面:所有长 system prompt / 长对话历史 / 压缩 summary 前缀场景,当前都付全价 + 隐式缓存不可控。

## 下一步

进② design 细化方案(`/effort design`)。待决策点:
1. AI SDK 的 provider adapter 层是否支持透传 `cache_control`(`src/core/provider-adapter.ts` / `src/runtime/provider-factory.ts`)?各家协议差异如何归一。
2. breakpoint 打在哪:summary 尾 + system 尾 + messages 前缀尾(Anthropic 上限 4 个),各家上限/语义不同。
3. `cacheTtlMs` 的角色演变:从纯"冷热判定"→ 也作为显式缓存的 TTL 参数(阿里/火山/Kimi 可配;Anthropic 是固定 5min/1h)。
4. 与三阶段压缩的交互:显式缓存命中后,改前缀 = 破 cache —— 与阶段2/3"只在冷时压缩"的现有策略如何协同(steps-overhaul design.md「cache 经济学」已立此原则)。
