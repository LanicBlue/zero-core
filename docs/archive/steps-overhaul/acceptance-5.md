# acceptance-5:压缩触发 + fresh tail 保护

## 验收清单
- [ ] cache 冷热:`now - lastLLMCall > cacheTTL(per-provider,默认6min)` → 冷;首 call/刚压缩后必然冷。
- [ ] 冷路径 StepEnd:冷 + (token>100K 或 >50%)→ 触发阶段3;可 mid-turn(长 turn 内部)。
- [ ] 热路径 mid-turn+热:不打断。
- [ ] 热路径 新 turn+热+(>200K 或 >70%):注入压缩提醒(PreLLMCall/compact 工具),LLM 自判。
- [ ] 热路径 新 turn+热+(>400K 或 >90%):强制压缩(preflight 先压再发)。
- [ ] reactive:`OnLLMError` prompt_too_long → 强制压缩 + retry。
- [ ] fresh tail 永不被压(边界 min(32K,20%窗口),tool-pair 安全)。
- [ ] WAIT 窗口:waitDuration>cacheTTL → resume 时压缩。
- [ ] token 判定读 `sessions.token_usage`(API 返回)。
- [ ] 防抖:连续两次省 <10% 停。
- [ ] 三层 tsc + vitest。

## 怎么验
mock token_usage + lastLLMCall + cacheTTL,验证各档触发;构造 fresh tail 验证不被压。
