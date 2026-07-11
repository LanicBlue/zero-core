# 验证策略:每 sub 多 agent 多角度 verify

> 每个 sub 实施完后,**不只一个 verify agent**,而是 **3 个 agent 并行、各自一个角度**审。3 个全过(无真实 finding)才能 commit 该 sub。

## 硬规则

1. **实施 agent ≠ verify agent**(memory `feedback-no-silent-scope-narrowing`):写代码的 agent 不能自验;verify 用独立 agent,冷眼读 diff + 跑检查。
2. **验下游真消费**(memory `feedback-verify-runtime-wiring`):不接受"生产者在某个 dead path 里存在就过"——必须追到下游真的消费(组装/恢复/UI/fire)。
3. **构建必跑三层 tsc**(memory `feedback-build-verification`):`build:lib`(tsc)+ cli/web/node 三层 + vitest;electron-vite build 不算 TS 检查。
4. **查 sessions.db readonly**(memory `feedback-sessions-db-readonly`):backend 占用时绝不 checkpoint WAL。

## 3 个角度(并行,3 个 Agent 调用同发)

### Lens A — 不变量守恒(对抗式 correctness)
- 输入:`sub-N.md`「关键不变量」+ `design.md` 相关不变量 + `acceptance-N.md` 不变量条目。
- 动作:**对抗式找茬**——读实际 diff/代码,逐条不变量问"哪里会破?"。例如 sub-1 的"一个 session 至多 1 in-flight turn"、sub-3 的"两表不重复存内容/无 mid-turn 漂移"、sub-4 的"compress once"。
- 产出:每条不变量 → `holds` / `broken(file:line, why)`。

### Lens B — 运行时接线 / 下游真消费
- 输入:`sub-N.md` 改动点 + memory `feedback-verify-runtime-wiring`。
- 动作:**端到端追消费链**,不接受 producer 隔离。例:
  - sub-1:recovery **真的**扫 `sessions.phase` 而非 turn_state?`getStepCount()` **真的**读 `sessions.step_count`?
  - sub-3:LLM view **真的**组装三区?fresh tail **真的**渲染指针形态不解引用全字节?
  - sub-5:`AgentLoop.resume()` **真的**跑了冷 preflight?
  - sub-8:delegated 完成 **真的**触发归档?活跃 session **真的**先 teardown?
- 产出:每条声称的接线 → `traced(file:line→file:line)` / `dead-end(断在哪)`。

### Lens C — 构建 / 回归 / 数据完整性
- 动作:跑实际命令,带输出回报:
  - 三层 tsc:`build:lib` + cli/web/node 的 tsc(memory `feedback-build-verification`)。
  - `vitest` 全量(或该 sub 相关子集 + 全量)。
  - readonly 查 `sessions.db`(`PRAGMA table_info`、抽样行),**不 checkpoint**。
- 产出:每项 → `pass` / `fail(命令 + 错误输出)`。

## 通过门槛

- **A + B + C 三全 pass** → sub 完成,可 commit。
- 任一 lens 报 `broken`/`dead-end`/`fail` → **回到实施 agent 修,不允许跳过、不允许"延到下个 sub"**(memory `feedback-no-silent-scope-narrowing`)。
- 修复后**重跑全部 3 lens**(不只重跑失败的那个——修 A 可能破 B)。

## 执行方式(2026-07-10 改:自动连续)

每个 sub:
1. 在 branch `steps-overhaul` 上(sub-1 已建)。
2. **实施 agent** 按 `sub-N.md` 写代码。
3. 同发 **3 个 verify Agent**(Lens A / B / C),各带本文件 + sub-N.md + acceptance-N.md 上下文。
4. 全 pass → commit(Bash `-F` 消息 + `Co-Authored-By`);否则修 → 重跑 3 lens。
5. **commit 后自动进下一个 sub**(sub-2 → ... → sub-10),不中途停。用户早上对整条 branch 一次性验收(每个 sub 独立 commit,可逐个 review/回滚)。依赖允许时(sub-6 与 sub-4/5)可并行。
