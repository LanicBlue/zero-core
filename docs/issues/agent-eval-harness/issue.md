# Issue: agent-eval-harness

- **状态**:① issues(问题记录)
- **提出**:2026-07-16
- **类型**:新功能(质量基础设施)
- **来源**:2026-07-16 每日扫描建议(方向 1)

## 问题

zero-core **完全没有 agent 质量评估基础设施**(`find -iname "*eval*"` 零命中;`tests/` 只有 unit/e2e/spike,验证的是**代码正确性**,不是 **agent 行为质量**)。后果:每一次记忆 / 压缩 / 工具 / prompt 改动都**裸奔上线**——memory-maintenance([issues/memory-maintenance](../memory-maintenance/issue.md))做完后怎么知道记忆变好了?compression-archive-simplify 砍掉 ExtractorA 怎么验证没丢信息?tool-quality-pass 修了 5 个工具,怎么回归?目前只能靠人肉跑 session 主观判断,既不可重复也无法进 CI。

业界共识([tau-bench](https://www.morphllm.com/ai-agent-evaluation) / [DeepEval](https://deepeval.com/docs/getting-started-agents) / Inspect / promptfoo):agent eval 要校验 **tool-call 轨迹 + 最终副作用状态**(wiki / DB / 文件),不只看回答文本,且要能在 CI 里做回归门禁。

## 现状 / 真相源 / 影响面

### 现成可复用的底座
- **`mock-language-model.ts`**([src/runtime/mock-language-model.ts](../../../src/runtime/mock-language-model.ts))已实现"JSON fixture 重放事件序列"的 `LanguageModelV2` mock,被 `provider-factory` 在 `type=mock` 时调用,**目前只用于 E2E 测试**。这正是 eval harness 需要的"确定性重放"底座——eval 可直接复用,无需从零造。
- **持久化齐全(生产 session replay 的原料)**:`steps` + `tool_executions` + `messages` + `sessions` 表已落全量 step(`session-db.ts`,`turns`→`steps` rename 后)。一个生产 session 的完整轨迹(每步消息 + 每次工具调用 + 结果)都在表里 → 可作为 eval 场景的**录制源**。

### 缺口
- **无场景库**:没有"标准 agent 任务 + 期望轨迹 / 期望终态"的 fixture 集合。
- **无断言框架**:没有"重放后校验 tool-call 序列 / wiki 子树内容 / DB 状态"的 assertion 层(tau-bench 式校验副作用)。
- **无生产→fixture 转换**:真实 session → mock fixture 的录制/转换工具缺失(生产 replay 的前置,见下方"相关方向")。
- **无 CI 门禁**:没有 eval 跑分 + 阈值阻断回归的流程。

### 影响面(若推进)
新增 eval 目录(scenarios + fixtures + runner)+ 复用 `mock-language-model` + 一个 session→fixture 录制器(读 `steps`/`tool_executions` 表)+ assertion 层(对比 wiki/DB 状态)。不改 AgentLoop 本体(只读它的输出)。可选:接入 `npm run eval` + CI workflow。

## 相关方向(强耦合,建议一起规划)

- **生产 session replay / 确定性复现**:当前只有**测试态** mock 重放,没有**生产态** session 复现(排查失败 run 只能看日志)。replay = 从 `steps`/`tool_executions` 重建上下文 + 重放,既是调试利器,又是 eval 的**录制源**。两者共享"从持久化表重建 AgentLoop 上下文"的 reader,建议在同一 design 里统筹。

## 下一步

进 ② design 细化方案(`/effort design`)。核心待决策:① eval 范围——先做"fixture 重放 + 轨迹/终态断言"骨架,还是连生产 replay 一起做;② 断言粒度——精确 tool-call 序列匹配 vs 子集/无序 vs LLM-as-judge 软评分;③ 场景来源——手写 vs 真实 session 录制转换;④ 是否/何时接 CI 门禁与阈值。**暂不实施。**
