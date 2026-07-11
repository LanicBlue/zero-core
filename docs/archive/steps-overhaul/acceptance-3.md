# acceptance-3:messages 引用模型 + 三区组装

## 验收清单
- [ ] `messages` 表只存 summary 块 + `last_compressed_step_seq`(不存 step 内容)。
- [ ] LLM view(`session.messages`)组装三区:[summary] + [中间区 tool stub] + [fresh tail 逐字+指针],正确。
- [ ] fresh tail 边界 = min(32K token, 20% 窗口),step 粒度,tool-pair 安全(不切断 tool_use/result 对)。
- [ ] fresh tail 中被外置(>16K)的 tool result 渲染**指针形态**(不解引用全字节回上下文);agent 可按指针按需读回。
- [ ] 中间区(压缩游标..fresh-tail 边界)tool 结果 stub(阶段2 常驻组装规则)。
- [ ] 重启恢复:组装 LLM view = messages.summary + steps[压缩游标..last_completed_step_seq];与崩溃前一致(无 mid-turn 漂移)。
- [ ] cachedTurns(UI 源)从 steps 独立填,与 LLM view 重建分离。
- [ ] `syncTurnsAfterCompression`/`replaceStepsFromMessages` 已删。
- [ ] getMessagesMultimodal 位置匹配正常(构造时两路 eager 跑)。
- [ ] 三层 tsc + vitest。

## 怎么验
构造 summary + 多 step,验证组装输出;模拟崩溃重启验证 LLM view 一致。
