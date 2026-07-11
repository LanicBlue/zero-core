# acceptance-10:e2e + 回归

## 验收清单
- [ ] e2e 长 turn mid-turn 压缩(stub Extractor A 注入预置 summary):100K+ turn,cache 冷 StepEnd 触发,summary 进 messages、游标推进、fresh tail 不被压、三区组装正确。
- [ ] e2e 恢复:mid-turn 崩溃 → 重启组装 LLM view → resume 续跑,无漂移。
- [ ] e2e 归档:delegated 完成自动归档(JSON 落盘/DB 删含孤儿/wiki 留存);chat 按钮归档活跃 session 先 teardown。
- [ ] e2e wiki(stub):压缩后 topic 节点写入路径通(内容质量验在 vitest)。
- [ ] e2e 内容量 UI:max(100 step,5 turn)显示。
- [ ] 三层 tsc(cli/web/node)+ build:lib + vitest 全量通过。
- [ ] readonly 查 sessions.db 验证(不 checkpoint WAL)。
- [ ] 验证下游真消费(组装/恢复/UI),非仅生产者隔离。

## 怎么验
Playwright Electron(`ZERO_CORE_TEST_FIXTURE`)+ 全量 tsc/build/vitest。
