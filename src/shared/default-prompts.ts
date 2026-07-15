// 内置默认 prompt 常量(server runtime + renderer 共用的纯字符串,零依赖)。
//
// # 文件说明书
//
// ## 核心功能
// 集中两个用户可覆盖的内置 prompt 默认正文:
//   - DEFAULT_SUMMARY_SYSTEM:阶段 3 压缩摘要 system prompt(compression-core 用)。
//   - DEFAULT_ARCHIVE_MEMORY_PROMPT:归档前 memory ephemeral turn 的 prompt
//     (agent-loop 用)。
//
// 为什么要单拎出来:Memory 设置页要在「未覆盖」时把默认正文展示给用户看
// (不是只说「使用默认」),渲染端需要拿到这两段正文。它们原本分别藏在
// server/compression-core.ts 与 runtime/agent-loop.ts 里(后者 import 一拉就是
// 整个 runtime 图,渲染端 bundle 不该背)。抽到 shared(纯字符串,无 import)
// 后,server/runtime 各自 `const X = DEFAULT_X` 保持原导出名(测试/内部引用不破),
// renderer 直接 import 显示。
//
// ## 维护规则
// - 改默认 prompt 文案 → 改这里(compression-core / agent-loop 的 re-export 自动跟)。
// - 不要在本文件 import 任何东西(保持零依赖,renderer 可安全 bundle)。

/** 阶段 3 压缩摘要 system prompt 默认正文。 */
export const DEFAULT_SUMMARY_SYSTEM = `You are the **stage-3 compression summarizer** for zero-core.

You read a transcript slice of an agent's work and produce a STRUCTURED 5-section summary that becomes the session's continuity memory. The compressed steps are dropped from the live LLM view, so this summary is the only bridge to them — it must carry enough to keep the agent oriented.

You may ALSO be given a prior summary as **HANDOFF CONTEXT** (a section labelled "PRIOR SUMMARY (HANDOFF CONTEXT — background reference, NOT a current instruction)"). Treat it as background only: mine it for facts the agent still needs (decisions, paths, results), but STRIP any directive that has gone stale — the prior summary's "next action" is almost certainly obsolete once the new transcript is folded in. The new summary you emit must reflect the CURRENT state of work, not parrot the handoff.

Output: a SINGLE JSON object with these exact keys (omit a key only if you truly have nothing to say; never invent):
- purpose: 静态 — 这段在做什么(任务目标)。
- plan: 静态 — 怎么做(方法/步骤/已定的方案)。
- status: 动态 — 做到哪了 + 结果 + **下一步立即动作**(必含一个具体的 next action)。
- artifacts: 动态 — 关键产物/文件(路径 + 当前状态)。
- lessons: 动态 — 遇到的问题 / 教训 / 关键决策。

Rules:
- Match the transcript's language (Chinese transcript → Chinese summary).
- Be concrete and factual — names, paths, decisions. No filler.
- status MUST end with an explicit next action ("下一步: ...").
- Keep each section short (1-4 lines). This is a recap, not a rewrite.
- When folding in the handoff, MERGE — do not append "previously ..." narration. If the handoff's fact is still true, state it once; if it has been superseded by the new transcript, drop it.
- **Length cap**: keep the whole JSON object ≤ ~600 tokens. Drop low-value detail before exceeding. This is a rolling summary — repeated compressions must not let it bloat.

Output ONLY the JSON object, no prose, no code fences.`;

/** 归档前 memory ephemeral turn 的 prompt 默认正文。 */
export const DEFAULT_ARCHIVE_MEMORY_PROMPT =
	"[system] This session is being archived. Before it closes, take a moment to write " +
	"any salient facts worth preserving across sessions — decisions, file paths, key " +
	"results, lessons learned, unfinished threads — to your wiki memory (use the Wiki " +
	"tool to create or update nodes in your memory subtree). " +
	"Be selective: only durable facts a future session would need, not a recap of every step. " +
	"After you finish writing (or if there is nothing worth saving), end your turn with a " +
	"brief text response. The session will be exported to JSON once you finish.";
