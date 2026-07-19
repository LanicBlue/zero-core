# Issue:prompt-cache-control(显式 prompt cache)

- **状态**:① issues(问题记录)
- **提出**:2026-07-11
- **类型**:改进 / 机制加固

## 问题

zero-core 调 LLM 时没有构造 provider-specific 的显式 prompt cache 标记。即使某些 Provider 在服务端提供隐式缓存，应用也无法统一控制 breakpoint、TTL、命中观测或成本语义。具体厂商协议和价格变化快，进入 design 前必须以届时的官方文档重新确认。

## 现状 / 真相源 / 影响面

- steps-overhaul 落地的 `Provider.cacheTtlMs`(`src/shared/types.ts` Provider 接口 + `src/runtime/hooks/compression-trigger-hooks.ts` `resolveCacheTtl` + ProviderEditor UI)只是**被动判定冷热**(距上次 LLM call > TTL → 压缩免费),**不主动构造缓存**。
- 显式缓存通常需要在 messages/system 前缀或 provider options 中加入厂商特定字段。当前 `src/` 没有 `cache_control`/`cacheControl` 接线，但 AI SDK 与各 Provider 的透传能力仍需在 design 阶段用当前版本验证。
- 本 issue 不记录厂商价格比例；成本收益必须用实际 Provider 账单/usage 字段测量，不能从历史宣传数字推导。
- 天然可缓存前缀(steps-overhaul 已有):三区组装后的 `[summary] + [system prompt]` 前缀(`src/runtime/session.ts` `assembleLLMView`)——稳定、重复率高,是理想的 cache breakpoint 位置。
- 影响面：长 system prompt、长历史和压缩 summary 前缀。当前确定的问题是缓存行为不可控/不可观测，不应直接断言每次请求都按全价计费。

## 下一步

进② design 细化方案(`/effort design`)。待决策点:
1. AI SDK 的 provider adapter 层是否支持透传 `cache_control`(`src/core/provider-adapter.ts` / `src/runtime/provider-factory.ts`)?各家协议差异如何归一。
2. breakpoint 打在哪:summary 尾 + system 尾 + messages 前缀尾(Anthropic 上限 4 个),各家上限/语义不同。
3. `cacheTtlMs` 的角色演变:从纯"冷热判定"→ 也作为显式缓存的 TTL 参数(阿里/火山/Kimi 可配;Anthropic 是固定 5min/1h)。
4. 与三阶段压缩的交互:显式缓存命中后,改前缀 = 破 cache —— 与阶段2/3"只在冷时压缩"的现有策略如何协同(steps-overhaul design.md「cache 经济学」已立此原则)。
