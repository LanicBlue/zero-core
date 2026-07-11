# sub-4:阶段3 压缩核心(summary 生成 + 游标推进 + cap 3)

## 范围
压缩核心:Extractor A(本 sub 先做单步摘要,多步升级留 sub-7)读 fresh tail 之外的旧 step → 产 5 段结构化 summary → 写 `messages`(summary 块 + 推进 `last_compressed_step_seq`)。`messages` summary cap 3 FIFO。

## 依赖
sub-3(messages 引用模型 + 组装)。

## 改动点
- **组装连续-role 修正(sub-3 Lens A 移交)**:sub-3 把 summary 渲染成 user 消息(zone 1),sub-4 写 summary 后,zone 1 summary 可能紧跟 postCursor 的 turn-opening user step → 连续两条 user 消息(部分 provider 拒绝)。sub-4 落 writer 后必须保证组装输出无连续同 role:① summary 改渲染成 system/assistant 消息,或 ② assembleLLMView/normalizeMessages 合并连续同 role。验收要加一条断言。
- 重写 `src/runtime/hooks/compression-hooks.ts`(或新建 compression 引擎):输入 = fresh tail 之外、游标之后的新 step(先经阶段2 trim);输出 = summary(5 段)+ 推进游标。
- summary 5 段模板:目的/计划/状态/关键产物·文件/经验(状态段含"下一步立即动作")。prompt 见 design。
- `messages` 写 summary 块 + 推进 `last_compressed_step_seq`;cap 3 summary FIFO(新进旧出,旧的 age-out 但已在 wiki —— wiki 写在 sub-7)。
- compress once:每段 step 只 summarize 一次;一次压缩可产多个 summary(steps 跨主题)。
- 寻回指针:summary 带指向 `steps` 表原始 step 范围的锚点。
- **拆除旧压缩引擎(本 sub 认领)**:删 `compression-engine.ts`(L1/L2、`identifyTurns`、`TurnBoundary`)+ 旧配置键(`l1Threshold 0.7` 等)+ sub-3 禁用后残留的 StepEnd 旧触发 hook。新引擎取代后无死代码残留。(`syncTurnsAfterCompression`/`replaceStepsFromMessages` 已由 **sub-3** 删,本 sub 不重复认领。)
- 不动 `steps` 表。

## 关键不变量
- summary = `messages` 里的连续性载体 + wiki 节点更新输入(sub-7)。本轮 wiki 写入可先 stub(只产 summary,wiki 留 sub-7)。
- 绝不 re-summarize summary(compress once)。
- 不碰 steps、fresh tail、head。

## 参考
design.md「阶段 3」「阶段3 summary/wiki 节点格式」。
