# sub-1:turnSource 标记

> ②.1 基础。给每个 turn 打"来源"标记,喂 sub-3 优先级 + sub-2 用量来源维度。对应 design ②.1。

## 任务

1. **`turn_state` 加列 `source`** TEXT,值 `user | work | cron | background`,默认 `background`。
   - turn_state 是 SessionDB 自管(非 SqliteStore 表),用 `safeAddColumn`([session-db.ts:242](../../../src/server/session-db.ts#L242))。
   - 同步改 INSERT([:763](../../../src/server/session-db.ts#L763))+ 各 SELECT(:854/:881 等)带 source。
2. **入口设置 source**(按 turn 起始 user message 来源):
   - `chat-router.sendPrompt`([:67](../../../src/server/chat-router.ts#L67))→ `user`
   - `sendProjectPrompt`(带 workId,project-work-runner/lead-service/enrichment-runner)→ `work`
   - cron `fireAgent`([cron-analysis.ts:718](../../../src/server/cron-analysis.ts#L718),调 sendPrompt/sendProjectPrompt)→ `cron`
   - delegated session(subagent-delegator 起子 loop)→ `background`
   - 其余 sendPrompt 调用点(analyst-service 等)默认 `background`(自动化,非用户/cron/work 显式触发)—— 实现者 audit 所有 sendPrompt/sendProjectPrompt 调用点确认归类。
3. **传递**:`sendPrompt`/`sendProjectPrompt` 加 `source` 参数(或 run option)→ agent-loop.run → turn 创建时落 turn_state.source。

## 范围

- 只加标记 + 透传,不改任何调度行为(优先级在 sub-3)。
- audit 调用点,默认 background 兜底,不漏。

## 风险

- sendPrompt 调用点多(chat-router/cron/analyst/...),漏标会落到默认 background —— audit 清单要全。
- 旧 turn(pre-migration)source = 默认 background,不崩。

## 验收

见 `acceptance-1.md`。
