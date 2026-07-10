# sub-5:压缩触发 + fresh tail 保护

## 范围
压缩何时跑:cache 冷热判定(cacheTTL)+ 分级触发(StepEnd cold / new-turn hot 提醒+强制 / reactive)+ fresh tail 保护。

## 依赖
sub-4(压缩核心)。

## 改动点
- **cache 冷热判定**:`now - lastLLMCall > cacheTTL` → 冷。`lastLLMCall` **内存 only**(SessionDB/agent-loop 维护,不持久化——重启必冷);`cacheTTL` 读 `Provider.cacheTtlMs?`(`shared/types.ts:102` 新增,默认 360000)。必然冷:首 call / 刚跑过压缩。
- **冷路径(StepEnd,可 mid-turn)**:StepEnd 评估;冷 + (token>100K 或 >50%)→ 阶段3;冷 + 低于 → 阶段2(组装规则,实质不触发写)。
- **热路径(新 turn)**:mid-turn+热 不打断;新 turn+热+(>200K 或 >70%)→ 注入压缩提醒(PreLLMCall memoryContext 或 compact 工具,LLM 自判);新 turn+热+(>400K 或 >90%)→ 强制压缩(PreLLMCall preflight 先压再发)。
- **reactive**:`OnLLMError` prompt_too_long → 强制压缩 + retry。
- **fresh tail 保护**:压缩只作用于 fresh tail 边界之前;边界 = min(32K, 20%窗口),step 粒度,tool-pair 安全,含在途 tool。
- token 判定读 `sessions.token_usage`(API 返回,不重算)。
- **resume-time 冷 preflight(取代单独 WAIT 触发,接点已定位)**:WAIT = pending "Wait" tool call(无 `waitDuration`,deadline 在 `until`/`startedAt`)。长 WAIT(>cacheTTL)→ cache 冷 → 下一个 StepEnd 冷路径本会压,唯一缝是 WAIT 醒后**首个 LLM call 在下一个 StepEnd 前**。故在 `AgentLoop.resume()`(`agent-loop.ts:631`,与 `detectAndResumePendingWait()` `:672` 同址)加"resume → 冷 + 超阈值 → 压缩"preflight,在首个 LLM call 前压。WAIT/崩溃恢复都是"resume 进冷 cache",同一条 preflight 覆盖,不单独做 WAIT 触发。
- 防抖:连续两次省 <10% 停;稳定性。

## 关键不变量
- 冷才跑完整压缩(免费);热只提醒/到 hard 才强压。
- fresh tail 永不被压。
- task 连续性靠 ≤3 summary(目的/计划 段),不靠保护原始 user 消息。

## 参考
design.md「cache 冷热判定」「触发路径」「fresh tail 保护」「阈值」。
