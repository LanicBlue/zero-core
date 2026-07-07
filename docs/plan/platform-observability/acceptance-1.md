# acceptance-1:turnSource 标记

对应 `sub-1.md`。

## 用例

1. **列存在**:migration 后 `turn_state` 有 `source` 列;新库(fresh DB)也有。
2. **chat→user**:经 chat-router.sendPrompt 起的 turn,turn_state.source=`user`。
3. **work**:经 sendProjectPrompt(带 workId)起的 turn,source=`work`。
4. **cron**:cron fireAgent 起的 turn,source=`cron`。
5. **background**:delegated 子 session 的 turn,source=`background`。
6. **默认兜底**:未显式标的 sendPrompt 调用 → source=`background`(不空、不崩)。
7. **旧数据**:pre-migration turn source = 默认 background,查询/恢复不崩。
8. **audit 完整**:所有 sendPrompt/sendProjectPrompt 调用点都有显式 source(无遗漏,grep 确认)。

## 验证手段

- 单测:mock 各入口起 turn,断言 turn_state.source 正确。
- 单测:migration 前后 turn_state 列存在 + 旧行默认值。
- grep:sendPrompt/sendProjectPrompt 调用点清单 vs 显式 source 标注,无漏。
- typecheck 三层 + vitest(sibling cwd)。
