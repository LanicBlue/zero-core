# acceptance-3:并发队列观测 + 优先级

对应 `sub-3.md`。

## 用例

### 队列观测
1. **waiter 身份**:acquire 时传 {sessionId,agentId,tier} → waiter 携带;`getWaiting()` 返列表含这些字段 + waitedSince。
2. **getWaiting 准**:排队中 → getWaiting 返当前所有等待者;release 一个 → 列表减一。
3. **abort 仍正确**:排队中 abort → waiter 摘除,getWaiting 不再含它。

### 优先级调度
4. **ALS 传 tier**:agent-loop.run 设 source=user → provider-factory acquire 拿到 tier=P1。
5. **按 tier 出队**:队列有 P3(background)在前、后到 P1(user) → release 时 P1 先出(插队)。
6. **同档 FIFO**:两个 P2,先 waitedSince 的先出。
7. **严格顺序**:P1 > P2 > P3,只要高档在等,低档不出去(接受 P3 饥饿)。
8. **回归**:非满载(无需排队)时 acquire 立即返,行为同旧;并发压力下不死锁、不漏 release。

## 验证手段

- 单测:ConcurrencyQueue 构造多档 waiter,release 顺序按 tier + waitedSince;getWaiting 内容正确。
- 单测:ALS set/get(agent-loop → provider-factory 传递)。
- 单测:abort 摘除 + 非满载立即返。
- typecheck 三层 + vitest(sibling cwd)。
