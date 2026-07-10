# sub-7:Extractor A 升级多步 agent(topic wiki 合并)

## 范围
Extractor A 从单次 generateText 升级为多步 agent:读 memory 子树 + 新 step → 判定新建/补充 topic 节点 → 去重/去伪/冲突标注合并写入。一次压缩可产多个 summary。summary = wiki 节点更新输入。

## 依赖
sub-4(压缩核心产 summary)、sub-6(topic store + 工具)。

## 改动点
- `src/server/extractor-a-service.ts`:从单次 generateText 改成多步 agent loop(独立 loop,不在工作 session 里);用 settings/memory 配置的模型;带 wiki 读写工具(sub-6 注入的 callerCtx)。
- 逻辑:读被压缩 agent 的 memory 子树 + 新 step → 判定每个内容映射到已有 topic 节点(补充)还是新 topic(新建)→ 合并写入(**去重 + 去伪(纠正过时/错误)+ 冲突无法判定则留 flags 标注**,非 dumb append、非覆盖)。
- 多步:wiki 读(看已有)→ 判定 → 写(合并)。
- 结果核对输出格式(不符重试/兜底)。
- summary 同时:① 写 `messages`(sub-4 已做)② 喂 wiki 节点(本 sub)。
- 退役 `extraction-hooks.ts` 阈值独立抽取(`[0.2/0.45/0.7]` + closeFlushSession)—— 决策 53 修订,合并进压缩。
- 归档的末次压缩也走 Extractor A(见 sub-8)。

## 关键不变量
- Extractor A 独立 loop,不阻塞工作 session,call 不存储。
- wiki 节点按 topic 划分,累积式承接过去(读后合并非覆盖)。
- wiki recall 进 messages 本轮不做。

## 参考
design.md「阶段 3」「wiki memory」「可行性已验证」(wiki 区)。
