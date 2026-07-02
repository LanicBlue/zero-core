# Acceptance M5 — 归档提取者 + 记忆恢复(D-C)

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。

### 提取者 A
- [ ] 独立 agent、事后异步、不阻塞工作 session
- [ ] 读 transcript → 写全局 wiki `type=memory` 节点(不在任何 project 子树)
- [ ] 关闭 flush 对尾批提取 → wiki
- [ ] 低 checkpoint 增量提取的产出也由 A 写
- [ ] 产出合并进已有 memory 节点(按 subject+type 演进,更新非新建)

### 提取者 B
- [ ] 独立 agent、事后异步、可与 A 并行
- [ ] 抽工具调用(失败/无效:错参数/幻觉工具名/重复重试)→ 独立遥测存储
- [ ] 两个提取者各自可配置开关

### D-C 三机制
- [ ] 原始 turn 持久化在 session 存储(resume 免费拿全量)
- [ ] 增量提取触发点从 70%/50% 降为 ~20%/45%/70% 预算(核实现有阈值常量已改)
- [ ] 每次触发只处理提取 cursor 后 delta,不重新过整段
- [ ] 触发按 token 预算低点、不按 turn
- [ ] 关闭 flush = 对尾批的最后一次 delta
- [ ] prune/compress 顺序 bug 已修(大单 turn 也走摘要/提取,不裸丢)
- [ ] memory 节点已迁到全局 wiki 树

### 恢复流程
- [ ] resume:全量原始 turn + 召回相关 wiki memory 节点
- [ ] **new session:仅靠 wiki memory 恢复,内容 ≈ 续接**(逐字细节丢失可接受)

### 端到端验证
- [ ] 长 session 撞到低 checkpoint → 增量提取进 wiki(验证 memory 节点已写、且是更新非重复)
- [ ] session 关闭 → 尾批 flush 进 wiki(尾批内容不丢)
- [ ] 大单 turn 不再被裸丢
- [ ] **新 session 从 wiki memory 恢复后,关键事实(决策/成果/经验)与原 session 内容等价**(人工抽检若干条)

### 明确未引入(回归检查 —— 确认没偷偷加回来)
- [ ] 无活 checkpoint(当前工作态节点)
- [ ] 无 transition / 任务变迁检测器
- [ ] 无外部事件锚点(写/API/委托类型判断)
- [ ] 无每 turn 压缩
