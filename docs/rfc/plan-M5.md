# Plan M5 — 归档提取者 + 记忆恢复(D-C)

> **依赖**: M0(session 存储)+ M2(全局 wiki memory 节点)。RFC 里最深的部分。
> **对应 RFC**: §2.12 / §2.18 / §4.6(memory 节点)。
> **验收**: `acceptance-M5.md`(前置见 `plan-overview.md` A0)。

**关键认知**:提取者 A 是**唯一的内容记忆写入者** —— 低 checkpoint 增量提取(机制 2)+ 关闭 flush(机制 3)都走 A。D-C 的「降触发点+增量+修 bug」本质是「把现有 L1/L2 在低 checkpoint 调用 A」。M5 不拆。

## 设计细节要求

### 提取者 A(内容记忆 / 关闭 flush / 增量)

1. 独立 agent(独立 prompt + 独立 AgentLoop),事后异步,不阻塞工作 session。参考 MiMo Code Writer「独立于主 agent 的提取者身份」(决策 44)。
2. 读 session transcript → 抽「做了什么 / 决策 / 成果 / 经验」→ 写**全局 wiki 树 `type=memory` 节点**(不绑 project,跨项目角色技能)。**只在全局类型节点下,不在任何 project 子树**(决策 46, N2)。
3. **统一职责**:① session 关闭时对未提取的尾批做 terminal flush;② 低 checkpoint 增量提取后的产出(见下)。A 是所有 session 的统一关闭归档器(决策 54)。
4. **产出合并进已有 memory 节点**(按 subject+type 演进,更新而非每次新建)—— 对接现有 memory 节点设计(决策 53)。

### 提取者 B(工具遥测)

5. 独立 agent,事后异步,可与 A 并行(决策 44)。
6. 读 transcript → 抽**工具调用情况,尤其失败/无效调用**(错参数、幻觉工具名、重复重试)→ 写**独立遥测存储**(v1;非 wiki 树,因为是平台改进数据不是项目知识也不是角色记忆)。
7. 未来作为「zero-core 自管理项目」数据源(决策 49,v1 不做自管理)。
8. 两个提取者各自可配置开关。

### D-C 三机制(领域无关,无 checkpoint/无 transition 检测)

9. **机制 1 —— 原始 turn 持久化在 session 存储**:resume 直接拿全量历史,零 LLM 成本。「当前焦点」= 最近原始 turn,不需额外维护 checkpoint(决策 53)。
10. **机制 2 —— 早期 + 增量式提取(低利用率多 checkpoint 触发)→ 调提取者 A**:触发点从现有 L1/L2 的 70%/50% **降为 ~20% / 45% / 70% 预算**(反 lost-in-the-middle + 提取需 headroom)。每次触发是对前一次的**增量更新** —— 只处理提取 cursor 之后的 delta,不重新过整段 transcript;产出由 A 合并进已有 memory 节点。触发按 token 预算低点、不按 turn(每 turn 压缩太贵)(决策 53)。
11. **机制 3 —— 关闭 flush(= 提取者 A)对尾批增量提取**:session 结束时,对最后一次 checkpoint 之后未提取的尾批跑一次增量提取(机制 2 的最后一次 delta)→ wiki。session 死/关,尾批不丢(决策 53)。
12. **修 prune/compress 顺序 bug**:大单 turn 被直接丢弃而无摘要 —— 这正是「单 turn 溢出」场景。修成「大单 turn 也走摘要/提取,不裸丢」(RFC §2.18 实现期对齐)。
13. **memory 节点迁到全局 wiki 树**:现有 memory 节点在散落 SQLite+FTS5,迁到 M2 的全局 wiki 树 memory 节点(决策 53)。

### 恢复流程(诚实版)

14. **resume**:全量原始 turn(session 存储)+ 召回相关 wiki memory 节点。
15. **new session**:只拿 wiki memory(含关闭 flush 的尾批)。丢逐字原始 turn,但内容已在 wiki(内容等价,非逐字)(决策 52)。

### 明确不要(踩过的坑,别重新提)

16. ~~活 checkpoint~~、~~transition/任务变迁检测器~~、~~外部事件锚点(写即锚点/API 即锚点)~~、~~每 turn 压缩~~ —— 均耦合场景或冗余,见 RFC §2.18(决策 54)。

## 风险

- 「降触发点」要核实现有 L1/L2 触发逻辑的真实位置(`CompressionEngine.shouldCompress` 等),改前先读现有源码确认阈值常量在哪。
- 提取 cursor 的持久化(记录上次提取到哪个 turn)需要新字段;评估挂在 session 还是独立表。
