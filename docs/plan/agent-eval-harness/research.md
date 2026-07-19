# Research: agent-eval-harness

- **状态**:研究输入快照，供本 effort 的 design / plan 使用
- **日期**:2026-07-16
- **来源**:τ-bench / τ²-bench / Terminal-Bench / DeepEval / Braintrust / Anthropic《Demystifying evals for AI agents》
- **关联**:[issue.md](./issue.md)

> 目的:回答"什么是 Agent eval / 怎么实现",并把业界标杆的设计模式映射到 zero-core 的栈(TS + Electron + 已有 `mock-language-model` 确定性重放 + `steps`/`tool_executions` 持久化),为 design 提供决策依据。

> **研究快照（2026-07-16）**：外部框架、论文和 API 会变化。本文用于提出 design 问题，不是当前实现或依赖选型；进入实施前应重新核对官方/原始来源。

> **后续决策（2026-07-17）**：本研究中的 benchmark 术语和 outcome-first 方法仍是
> 输入，但“zero-core 核心内建 Eval runner、默认 CI 阈值门禁、与生产 replay 强绑定”
> 已被 [design.md](./design.md) 的内置 Skill 与
> [跨 effort 架构合同](../agent-project-automation.md) 的配置化 Flow 方案取代。归档分析不再
> 需要专用导出 adapter：分析 Agent 可以直接以 `~/.zero-core/archives` 为 workspace，
> 由 Cron Work 增量读取普通 JSON。

---

## 一、什么是 Agent eval

一句话:**从"单轮 output 对错"变成"多轮 trajectory + 副作用 outcome 对错"。**

- **output ≠ outcome**:agent 说"餐厅已订好!"不等于真下了单。τ-bench / Terminal-Bench 都**只验 outcome**(环境终态),不验 agent 嘴上说的。
- **被测的是 scaffold + model 整体**:表现差可能是模型差,也可能是 harness(工具 / prompt / context 管理)差,两者难解耦——这恰恰是要测的(zero-core 的 scaffold 本身就是产品)。
- 五个标准术语(Anthropic 框架,几乎所有 benchmark 都套):

| 术语 | 含义 | zero-core 对应 |
|------|------|----------------|
| **task** | 一个测试用例(预定义输入 + 通过条件) | 一个 eval scenario |
| **trial** | 跑一次 task(agent 有随机性,同 task 跑多次) | 一次 AgentLoop run |
| **transcript**(trajectory/trace) | 这次 trial 的完整记录:输出 / tool call / reasoning / 中间结果 | `steps` + `tool_executions` 表 ✅ 已落盘 |
| **outcome** | trial 结束后**外部环境的终态** | wiki 子树 / DB / 文件 |
| **grader** | 对 transcript 或 outcome 打分的检查逻辑 | 要写的 assertion 层 |

---

## 二、实现骨架:三个标杆(都套同一结构)

### τ-bench(最贴近本仓场景)= 4 组件

1. **DBs**:JSON 格式的领域数据
2. **APIs**:`tool_name(**kwargs)` 读写 DB 的工具集
3. **Policy docs**:agent 必须遵守的规则(wiki / policy)
4. **User simulator**:LLM 扮演用户

→ zero-core 已有 tools + policy(wiki),缺的是 **受控环境(每 trial 全新)+ user 输入源**(mock fixture 就是"用户")。

**τ-bench 的 task = 3 个标注**:① user 指令 ② ground-truth DB 写操作 ③ 对用户提问的期望输出。**只验 outcome,故意不评主观**(对话质量)换清晰 pass/fail。

### τ²-bench 的原子子任务(建场景库的范式)

每个 subtask = **(init 函数 + solution tools + assertions)**,组合成更难的 composite task。这是"场景来源"决策的答案:**手写原子子任务,组合出场景**,而不是一个个手搓大场景。

### Terminal-Bench 的 task = 4 部分(代码类任务的黄金标准)

1. **instruction** + 时间上限
2. **environment**(Docker 镜像,预装文件 / 包)
3. **test set**:确定性检查,**只验最终容器状态,不验命令 / 输出**("outcome-driven,agent 可用任意路径解")
4. **oracle / reference solution**:手写参考解

**3 条质量门**(场景质检清单):

- **Specificity**:测试 iff 终态是合法解(覆盖所有合法 end state)
- **Solvability**:oracle 解能过(证明 task 可解 + grader 没检错)
- **Integrity**:不能靠作弊 / 捷径解(τ² 还跑了对抗 exploit agent 专找可作弊 task)

> Terminal-Bench 2.0 每个 task 约 **3 人时**人工审核;τ²-bench-verified 人工纠错后发现大量 task 质量问题(策略冲突 / 数据矛盾 / 歧义不可解),修正后 top 模型 Avg@5 从很低涨到 >80%。**结论:task 质量比 harness 本身还重要,审核投入不能省。**

### DeepEval 的分层 + CI(TS 不能直接用,借理念)

- **Reasoning 层**:PlanQuality / PlanAdherence
- **Action 层**:ToolCorrectness / ArgumentCorrectness(component-level,挂在 LLM 调用上)
- **Overall**:TaskCompletion / StepEfficiency
- LLM tracing(`@observe` 装饰器)自动建 trace 树 → pytest + `deepeval test run` 进 CI,fail metric = fail build
- **但它是 Python**,本仓是 TS——借分层 + tracing + CI 这套理念,实现自造薄层

---

## 三、随机性:Pass@K vs Pass^K(CI 门禁必懂)

| | 含义 | K 增大时 | 测的是 |
|---|---|---|---|
| **Pass@K**(at) | K 次里**至少成功 1 次** | ↑ 乐观 | 上限能力 |
| **Pass^K**(hat) | K 次**全部成功** | ↓ 严格 | **一致性 / 可靠性** |

τ-bench 原话:客服这种要可靠性的场景看 Pass^K。τ² 显示 **o4-mini 的 pass^4 在 Telecom 只有 26%**——agent 普遍很脆。**CI 门禁看 Pass^K 或 Avg@K,不能只看 Pass@1**,否则单次过就放行,回归漏检。

---

## 四、Grader 选型:code-based 打底,LLM-judge 补主观

| | code-based(确定性) | model-based(LLM-judge) |
|---|---|---|
| 实现 | 字符串匹配 / DB 状态断言 / 跑测试 / token 上限 | prompt LLM 打分(pairwise / pointwise / reference-guided) |
| 优 | 高效、**可复现**、易 debug、能进 CI | 能评主观质量 |
| 劣 | 需 ground truth、死板、缺 nuance | **非确定**、有 bias、贵 |
| 用 | outcome 断言、精确 tool 匹配、上限检查 | "够不够好"、过度工程、优雅度 |

业界共识:**两者混用,code-based 主力,LLM-judge 校准对人评一致率**。多 grader 加权合成一个 composite 指标 + 阈值 → 顶层 pass rate 进 CI。

---

## 五、Braintrust scorer 菜单 → 映射到本仓架构

zero-core 是 **autonomous + orchestrator-workers(子代理委派)**,对应这套 grader 词表(直接抄来组织 grader):

- **orchestrator-workers(委派)**:`SubtaskCoverage`(子任务全覆盖)/ `PartialAccuracy`(各 worker 对错)/ `FinalMergeCoherence`(合并结果无矛盾)
- **autonomous**:`StepLimitCheck`(防跑飞)/ `TaskSuccessRate` / `ComplianceCheck`(策略合规)

---

## 六、zero-core 落地建议(本研究核心结论)

### 🔑 最关键的洞察:确定性重放让"回归门禁"几乎免疫随机性

`mock-language-model` 重放 fixture → **模型输出确定,没有采样随机性**。于是:

| 评估模式 | 模型 | 随机性 | trial 数 | 用途 |
|---|---|---|---|---|
| **A. Harness 回归**(推荐 MVP) | mock 重放 | 无 | **1 次,精确复现** | 验**自己的改动**(memory / 压缩 / 工具 / prompt 接线)没搞坏 |
| **B. 模型质量**(推迟) | 真模型 | 有 | 多次,看 Pass^K | 验模型能力本身 |

本仓的痛点(memory / compression / tool 改完怎么回归)全部落在**模式 A**——确定性重放 + outcome 断言,1 次跑、可复现、能进 CI、不需要 Pass^K 的复杂度。这是大多数团队没有的奢侈品(他们没 mock 重放器),本仓白捡。

### 推荐 MVP(弱绑定,先 eval 不碰 replay)

1. **模式 A 为主**:mock 重放 fixture → 跑 AgentLoop → 断言 wiki 子树 / DB 状态 / 文件。确定性、CI-gateable
2. **场景 = Terminal-Bench 4 件套**:instruction + 初始环境 + outcome 断言 + oracle 解;用 **τ² 原子子任务**组合建库
3. **grader 先全 code-based**;主观(memory "变好了没")留模式 B 的 LLM-judge
4. **录制器**:`steps` / `tool_executions` → mock fixture + ground-truth outcome,真实 session 变场景(顺带为生产 replay 铺路,replay 独立后续 effort)
5. **CI**:阈值阻断回归;模式 A 单 trial 即可

### 建议推迟

- 生产 session replay(强绑定,重建完整运行态上下文)——单独 effort
- 模式 B 真模型 + Pass^K 多 trial——等骨架稳
- LLM-judge 主观评分——code-based 骨架稳后再上

### 框架选型结论

- **不直接用 DeepEval**(Python,栈不符),借分层 / tracing / CI 理念
- **不强行用 promptfoo**(TS 同语言,但它的 agent 模型不如本仓已有的 mock 重放器贴合)
- **抄 τ-bench task 格式 + Terminal-Bench task 设计 + Braintrust scorer 菜单**,在 `mock-language-model` 上自造薄 TS 层

---

## 七、zero-core 的 eval 架构(设计输入)

> 本节是把前六节的通用框架,落到 zero-core 已有基础设施(archive pipeline + effort 工作流 + `mock-language-model`)上的架构结论,供 `/effort design` 直接引用。

### 7.1 eval 解决的两类问题(对应两个模式)

| 问题 | 模式 | 机制 | 成本 / 门槛 |
|---|---|---|---|
| **① 评估 harness 问题**(工具配置 / system prompt / 接线) | A | mock 重放锁模型 → 改 harness 看 outcome delta + transcript 诊断 | 便宜、确定、1 trial、CI 可用 |
| **② 模型与任务适配 / 横向对比** | B | 真模型多 trial,看 Pass^K | 贵、有方差、需预算 |

问题 ① 是高 ROI 入口;问题 ② 推迟(本仓 MiniMax 仅测试用,生产异构——见 memory `project-minimax-role`)。

### 7.2 数据源:归档 session(已验证开箱即用)

按 [session-db.ts](../../../src/server/core-database.ts) schema 与持久化代码确认（不要求读取用户真实 profile）：

- **`steps.content` = Vercel AI SDK message parts 的 JSON 数组**,一个 assistant step 完整包含:`text` part(reasoning)+ `tool` part(`name` / 完整 `args` / `toolCallId` / 完整 `result` / `status`)。重建 LLM 上下文只靠 `steps` 即可,这就是它能恢复的原因。
- 归档 JSON(`steps, summaries, ...`)**已含完整工具调用**,judge 诊断工具用法**无需改 export**。
- `tool_executions` 是**指标投影表**(`duration_ms` / `success` / `error_message` / `agent_id` + 按 tool 聚合索引),不是工具调用真相源;只有当 judge 要报"错误率 / 耗时"类指标问题时才补充价值。
- **教训**:别凭 schema 列名(`role/content`)下结论,要 readonly 查 `content` 的实际结构(对齐 memory `feedback-verify-rendering-against-stored-data`)。

### 7.3 诊断机制:外部 judge(非任务 agent 自我反思)

- **"外部"是相对任务 agent 的角色,不是另一个软件系统**——judge 属 zero-core,评 zero-core 的 harness。
- 但"独立"必须钉成可执行约束,否则退化成自我反思:
  - **不同模型 / 不同 prompt**(判官 ≠ 当事 agent,理想用更强模型——评判往往比执行难)
  - **不共享 memory / context**(判官开全新上下文,只喂 transcript + 相关源码片段)
  - 任务 agent 看不到 harness 源码、也无法站第三方视角,故**必须外部 judge**(用户明确决策)
- 把"任务后追问工具问题"做成 **LLM-judge retrospective grader**:对 transcript 按结构化 rubric 评估,输出**带证据**(引 transcript 步号 + 源码行号)的诊断报告。等价 DeepEval `GEval` / Braintrust `LLMClassifier`。
- **自动化的是诊断,不是修复**——judge 给优先级建议,改不改 / 怎么改仍由人决定(LLM 建议不可信到能 auto-apply)。
- **校准回路**:跟踪 judge 报的 issue 里人工确认为真的比例(precision),低了就调 prompt / 提阈值,否则人被假阳性淹没。

### 7.4 两层架构(关键)

| 层 | 机制 | 频率 | 性质 |
|---|---|---|---|
| **Tier 1 确定性 grader** | 场景 + code-based 断言(outcome / tool 序列) | 每次改动 | 便宜、可复现、CI 门禁(模式 A) |
| **Tier 2 LLM-judge 发现** | 扫归档 + 读源码,提 issue | 周期性 | 贵、非确定、产 issue 喂 Tier 1 |

**归档喂 Tier 2;确认的 issue 沉淀成 Tier 1。** 时间推移 Tier 1 长大、Tier 2 缩小(未知问题变少)。读归档只能做 Tier 2 诊断(无监督找异常);回归(Tier 1)要靠**重放**(归档→mock fixture,用 `mock-language-model` 重跑新 harness 对比),不是读。

### 7.5 闭环(对接现成 effort 工作流)

```
[归档(steps 已含完整 tool)] + [harness 源码 @pin commit]
        │  judge 读 transcript + 相关源码片段
        ▼
   外部 judge (独立模型/prompt, 无共享 memory)            ← Tier 2, 周期性
        │  → 结构化 issue (引步号 + 源码行号)
        ▼
   人工 triage ── 否 → 标记, 反喂校准 judge precision
        └── 是
              ▼
   effort: design(含 oracle / 期望 outcome) → plan
              ▼
   任务 agent(implementer)改代码 → sandbox + verifier 验 fix
              ▼
   ★ 沉淀: issue → scenario + 确定性 grader (回归守卫)     ← 关键
              ▼
   eval suite (每次改动自动跑, 确定性, CI 门禁)             ← Tier 1
```

**关键补强**:确认的 issue 必须**沉淀成 scenario + 确定性 grader**(Terminal-Bench 式:初始环境 + 期望 outcome 断言 + oracle),否则下次扫归档 judge 又报同一问题——没沉淀 = 永远在发现同一个问题。沙盒测验当下 fix,scenario 守未来回归,两件事。

issue 流转正好用 effort 工作流的 issue.md 模板,自然进 issues/ → design/ → plan/ → 执行 → archive/。

### 7.6 OpenTelemetry GenAI 兼容性

2026-07-18 核对官方资料时，GenAI semantic conventions 已迁移到独立仓库，覆盖 model
inference、agent/workflow/plan、tool、MCP、metrics/events 和
`gen_ai.evaluation.result`；但 GenAI/agent/MCP 文档仍标为 Development，agentic system
总提案仍在推进，仓库 schema URL 也未冻结。因此它适合作为 adapter，不适合作为 Eval
内部唯一 schema。

与本设计的对应关系：

- `invoke_agent` / `invoke_workflow` / `plan` / `execute_tool` 能表达大部分 trajectory；
- 对具体 GenAI operation/response 的评价，`gen_ai.evaluation.result` 可投影 grader
  name、score/label、explanation 和被评估 operation；整个 scenario/trial/outcome 仍需
  Skill 自有结果合同；
- MCP convention 支持通过 `_meta` 传播 W3C trace context；
- 官方 reference implementation 本身也使用 deterministic local mock server、
  scenarios、telemetry capture 和规范校验，与本 Skill 的 fixtures/scenarios/tests
  方法一致。

设计结论：Skill 内增加 archive-v1、OTLP JSON/Protobuf input adapter 和可选 evaluation
output adapter；内部仍保存版本化 normalized trajectory/Eval result。默认离线、内容
关闭并 redaction。zero-core 原生 instrumentation、collector 和观测 UI 单列未来 effort，
不修改当前 AgentLoop/Provider/Session/Flow/Work 功能代码。

### 7.7 待 design 决策的开放问题

1. **版本错位**:归档 T1 是源码 @commit C1 跑出来的;judge 拿今天的源码判 T1 会把"已修好的老问题"当新问题报,或误判归因。归档要 **pin 产生它的源码 commit / agent 版本**。
2. **选择偏差**:归档只含 agent 实际走过的路径,高频复现常见路径、低频覆盖边缘情况。归档擅长挖真实痛点,但**覆盖度不全**,需配构造场景做定向覆盖。
3. **oracle / ground-truth 谁写**:确认 issue 沉淀成 scenario 时,期望 outcome 由谁定?——人工在 effort 的 design 阶段写(明确为 design 产出之一)。
4. **judge 选型 + 校准**:用哪个模型?rubric 颗粒度?precision 阈值多少?
5. **扫描策略**:全量 vs 增量(只扫新归档)?同 issue 跨 session 怎么 dedup?频率?
6. **归档→fixture 转换器**:Tier 1 回归的半边(重放)靠它;`mock-language-model` 已有,差转换器。
7. **judge 读源码的范围**:源码大,不能全读;要按 session 用到的 tool 定位相关 schema / 描述 / impl + 相关 prompt 段——本身是个检索/context 工程问题。

---

## Sources

- [Demystifying evals for AI agents — Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)(权威术语框架)
- [Agent Evaluation: A Detailed Guide — Cameron Wolfe](https://cameronrwolfe.substack.com/p/agent-evals)(最完整综述:τ-bench / τ² / τ³ / Terminal-Bench + Pass^K + 7 步建 harness)
- [Evaluating agents — Braintrust](https://www.braintrust.dev/blog/evaluating-agents)(按 agent 模式的 scorer 菜单)
- [AI Agent Evaluation — DeepEval](https://deepeval.com/guides/guides-ai-agent-evaluation)(分层 metric + tracing + CI)
- [τ-bench — sierra-research](https://github.com/sierra-research/tau-bench)(4 组件架构 + outcome 断言 + Pass^K)
- [Building effective agents — Anthropic](https://www.anthropic.com/engineering/building-effective-agents)(scaffold 概念)
- [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [OTel GenAI agent and framework spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [OTel GenAI events and evaluation result](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md)
- [OTel MCP semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)
- [OTel GenAI reference implementations](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/reference/README.md)
- [OTel agentic systems proposal](https://github.com/open-telemetry/semantic-conventions-genai/issues/35)
