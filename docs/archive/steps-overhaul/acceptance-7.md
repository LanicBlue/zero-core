# acceptance-7:Extractor A 多步 agent(topic 合并)

## 验收清单
- [ ] Extractor A 是多步 agent(独立 loop,不在工作 session 里),用 settings/memory 模型。
- [ ] 读被压缩 agent 的 memory 子树 + 新 step → 判定新建 topic 节点 vs 补充已有。
- [ ] 合并:**去重**(同主题不重复)+ **去伪**(纠正过时/错误)+ **冲突无法判定则 flags 标注**(非 dumb append、非覆盖)。
- [ ] detail 留"## 历史"段(绕过无 version/history 列)。
- [ ] 一次压缩可产多个 summary(跨主题)。
- [ ] summary 同时写 `messages`(sub-4)+ 喂 wiki 节点(本 sub)。
- [ ] 结果核对输出格式(不符重试/兜底)。
- [ ] `extraction-hooks` 阈值独立抽取 + closeFlushSession 已退役(决策 53 修订)。
- [ ] wiki recall 进 messages 本轮不做。
- [ ] 三层 tsc + vitest。

## 怎么验
构造重复/冲突/过时事实的多轮压缩,验证 wiki 节点合并结果(去重/纠正/标注);验证跨主题产多 summary。
