# acceptance-4:阶段3 压缩核心

## 验收清单
- [ ] 压缩产 5 段结构化 summary(目的/计划/状态/关键产物·文件/经验;状态段含"下一步立即动作")。
- [ ] summary 写进 `messages` + 推进 `last_compressed_step_seq`。
- [ ] `messages` summary cap 3 FIFO(第 4 个进、最旧出)。
- [ ] compress once:同一段 step 不被 re-summarize;一次压缩可产多个 summary(跨主题)。
- [ ] summary 带寻回指针(指向 steps 原始范围)。
- [ ] `steps` 表不动;fresh tail/head 不被压。
- [ ] 旧 `compression-engine.ts`(L1/L2/identifyTurns/TurnBoundary)+ `l1Threshold` 配置 + `syncTurnsAfterCompression`/`replaceStepsFromMessages` 已删,无死代码。
- [ ] wiki 写入本轮可 stub(只产 summary,wiki 留 sub-7)。
- [ ] 组装输出无连续同 role 消息(sub-3 Lens A 移交:summary + turn-opening user step 不撞)。
- [ ] 三层 tsc + vitest。

## 怎么验
构造超阈值 step,触发压缩,检查 messages 的 summary 块 + 游标推进 + steps 未动。
