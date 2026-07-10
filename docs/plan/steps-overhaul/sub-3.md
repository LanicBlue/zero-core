# sub-3:messages 引用模型 + LLM view 三区组装

## 范围
`messages` 表语义从"LLM 视图内容落盘"改为"**summary 块 + 压缩游标**(`last_compressed_step_seq`),不存 step 内容"。LLM view(内存 `session.messages`)= 组装三区:summary + 中间区(tool stub)+ fresh tail。

## 依赖
sub-1、sub-2。

## 改动点
- `src/server/session-db.ts`:`messages` 表 schema 改成(summary 块 JSON + `last_compressed_step_seq` + 任何元数据);不再存 step 内容。`saveTurn` 语义重定义(不再整表写 step 内容)。
- `src/runtime/session.ts`:`rebuildFromTurns` 拆成两路 —— ① LLM view 组装(`messages` 表 summary + `steps`[压缩游标..last_completed_step_seq]);② `cachedTurns` 从 `steps` 填(独立)。组装实现三区:summary / 中间区(压缩游标..fresh-tail 边界)tool 结果 stub / fresh tail 逐字。
- fresh tail 边界 = `min(32K token, 20% 窗口)`,step 粒度,tool-pair 安全。
- **fresh tail "逐字" = step 指针形态逐字,非解引用原始字节**:fresh tail 里某 step 的 tool result 若被 sub-2 外置(>16K),渲染的是**指针版**(摘要+文件路径,~4K token),**不解引用外置文件全字节回上下文**(否则违阶段1 目的)。"逐字"仅相对中间区 stub 而言——fresh tail 的 step 内容原样组装(不 stub),但仍是指针形态。agent 要细节按指针从 `steps`/外置文件按需读。
- `getMessagesMultimodal` 位置匹配依赖 cachedTurns → 构造时两路都 eager 跑。
- 删 `compression-hooks.ts` 的 `syncTurnsAfterCompression`/`replaceStepsFromMessages`(LLM 改从 messages 重建后,turns/steps sync 不再必要)。

## 关键不变量
- 两表不重复存内容(steps 全量 step 指针版;messages 只 summary+游标)。
- 无 mid-turn 漂移(messages 只是游标,steps 是 source)。
- 三区组装:阶段2(中间区 tool stub)在此生效(常驻,非触发写)。
- 两个游标区别:`sessions.last_completed_step_seq`(resume)vs `messages.last_compressed_step_seq`(压缩/组装分界)。

## 参考
design.md「两张表」「阶段 2」「中断重启恢复」「可行性已验证」(冲突点② + 风险#2)。
