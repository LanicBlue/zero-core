# Plan 06：Trigger Cutover、UI、Archive 与 Hardening

## 目标

把新 coordinator 接入全部生产触发，删除旧 Agent 自判/嵌套路径，完成 UI、manual、
archive P4、telemetry、race 和 release 验收。

## 工作

1. 接入 preferred：
   TurnEnd/Wait + threshold + 无新 semantic Step + foreground Provider TTL 已过。
2. 接入 hard：
   完整 StepEnd 立即启动；PreLLM request-fit 建 hard gate；prompt-too-long recovery 路由到新
   coordinator，不直接调用旧 compression。
3. preferred 空闲时可连续 P2 cycle 向 target 前进；P1 用户到来后尚未 dispatch 的 pass
   让位。hard 时按 P0 继续，直到 request 可安全构造。
4. 删除：
   - Agent 自然语言 compression reminder/ack；
   - 普通 Agent compression tool/隐藏请求；
   - nested/temporary AgentLoop memory turn；
   - single-turn compression guard；
   - 旧直接 compression 和重复 boundary/transcript 路径。
5. 保留管理面“Compact now”，但必须走同一 Snapshot、Memory once、Compression
   multi-pass、联合提交和 hard failure 语义。
6. UI/HTTP/WS 展示 preparing/running/commit/blocked、Memory outcome、Compression pass
   progress、trigger、queue priority/wait reason；重连从 Session snapshot 恢复，不恢复
   bypass run。
7. Archive memory 接入 Plan 03 adapter：
   - P4、一个原模型逻辑 call、Wiki overlay；
   - 成功只提交 WikiPatch；
   - 失败/中断丢弃 overlay；
   - Memory 失败后继续 export，保持现有 best-effort 语义。
8. prompt refresh 只在 safe boundary；Memory commit 不热改已构造 foreground request。
9. 记录低敏 telemetry：snapshot/coverage、threshold/TTL、Memory outcome、pass count/usage、
   reduction、stale/conflict、hard wait、priority wait；不记录 Memory 正文。
10. 增加 main/delegated/user/Work/Cron/archive/manual、Stop/Wait/handoff、provider quota、
    concurrency=1/2、多 Provider、restart 和超长 Turn E2E。
11. 删除 legacy tests/config/comment，更新活动 arch/glossary/quality docs。

## 完成

[Acceptance 06](acceptance-06-trigger-cutover-ui-archive.md)通过并创建 `result-06.md`，随后执行
[Final Acceptance](acceptance-final.md)。
