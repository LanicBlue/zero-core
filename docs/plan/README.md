# docs/plan — 待实施或实施中的计划

本目录保存已经完成设计、拆成实施步骤和验收条件，但尚未成为当前代码事实的 effort。
本页是实施 Agent 的选择入口；进入具体 effort 后仍必须阅读其 design、README、当前
plan/acceptance 和已有 result。

> 核对日期：2026-07-17。下列依赖是当前人工/文档交接约束，不表示 zero-core 已经创建
> FlowDependency、FlowInstance 或自动执行门禁。

## 1. 当前选择结论

| Effort | 状态 | 现在能否新开实施 | 首个外部前置 | 后续额外门禁 |
|---|---|---:|---|---|
| [`wiki-system-redesign`](wiki-system-redesign/README.md) | 另一 worktree 实施中 | 只由既有实施工作继续 | 无 | 00→08→Final，用户同意合并 |
| [`session-turn-lifecycle`](session-turn-lifecycle/README.md) | Ready，未实施 | 否 | Wiki Final PASS + 合并 | 00→06→Final |
| [`local-backend-security-boundary`](local-backend-security-boundary/README.md) | Ready，未实施 | 否 | Wiki Final PASS + 合并 | 00→05→Final |
| [`agent-eval-harness`](agent-eval-harness/README.md) | Ready，未实施 | 否 | Wiki Final PASS + 合并 | Plan 04 还依赖 Session Lifecycle Final |

因此在 Wiki 尚未最终验收并合并时，不要从当前主分支为后三项建立实现 worktree。可以阅读、
复核和回答实施问题，但不能按旧 Wiki/Core DB/Runtime 接口开始编码。

## 2. Effort 依赖图

```text
wiki-system-redesign 00–08 → FINAL → 用户同意合并
                              │
              ┌───────────────┼─────────────────────────┐
              ↓               ↓                         ↓
session-turn-lifecycle   local-backend-security   agent-eval-harness
00–06 → FINAL            00–05 → FINAL            00 → 01 → 02 → 03
              │                                        │
              └────────────────────────────────────────┘
                                ↓
                    agent-eval-harness 04 → … → 09 → FINAL
```

准确含义：

1. Wiki Final 和合并是后三项共同的人工硬门禁。
2. Wiki 合并后，Session Lifecycle 与 Local Backend Security 没有产品语义上的先后依赖，
   可以分别从各自 Plan 00 开始。
3. Agent Eval Plan 00–03 只依赖 Wiki 合并，可以与 Session Lifecycle 实施并行推进。
4. Agent Eval Plan 04 开始消费 TurnRun、统一 Session snapshot、queue pause、handoff 和
   跨 Turn task event，因此必须等待 Session Lifecycle Final。
5. Agent Eval Plan 05–09 继续依赖 Plan 04，不能绕过该门禁。
6. Local Backend Security 不依赖 Session Lifecycle 或 Agent Eval；它保护 HTTP/WS/IPC
   进程边界，不定义 Session 产品语义。

## 3. Wiki 合并后的推荐选择

实施 Agent 应按“最早未阻塞阶段”选择工作，而不是只看 effort 名称：

| 可选工作 | 适合条件 | 注意事项 |
|---|---|---|
| Session Lifecycle Plan 00 起 | 希望优先稳定 Runtime、Stop、Wait、后台任务和 UI 状态 | 推荐优先；它会解除 Agent Eval Plan 04 门禁 |
| Local Backend Security Plan 00 起 | 希望独立处理本机进程安全边界 | 可与 Session Lifecycle 分 worktree；两者都可能改 server event wiring，合并前必须重新对齐 |
| Agent Eval Plan 00–03 | 希望先完成 Project control Git、Flow、Work/WorkRun | 可以与 Session Lifecycle 并行；到 Plan 03 后若 Lifecycle 未 Final，必须停在门禁前 |
| Agent Eval Plan 04–09 | Session Lifecycle Final 已通过 | 必须复用 Lifecycle 契约，不得建立另一套 busy/waiting/queue 状态机 |

若只能串行安排一个实施 Agent，默认顺序建议为：

```text
Wiki 合并
→ Session Lifecycle
→ Agent Eval 00–09
```

Local Backend Security 可在 Wiki 合并后的任意独立窗口插入；它是高优先级安全 effort，
实际排期由用户决定，不因上面的默认顺序自动延后。

## 4. 并行与冲突边界

“依赖允许并行”不等于“可以在同一 checkout 同时修改”：

- 每个 effort 使用独立 worktree/分支。
- Wiki 未合并前，后三项都不得修改其正在改造的 Core DB、Runtime、CallerCtx、文件保护或
  Project UI。
- Session Lifecycle 与 Agent Eval 00–03 可以并行，但双方不得提前编辑 Agent Eval
  Plan 04 的共同 Runtime 接口；Plan 04 开始前必须读取 Lifecycle Final/result。
- Session Lifecycle 与 Local Backend Security 都可能触及 server composition、WS event
  wiring 和 UI reconnect；后合并者必须在自己的 Plan 00/result 中记录真实接口与冲突映射。
- 任何 effort 的 plan 文件名和源码定位都只是设计时基线；Plan 00 必须以合并后源码为准。

## 5. 实施 Agent 选择流程

1. 检查当前目标分支是否包含所有外部前置的 Final result 和用户同意的 merge commit。
2. 检查其他 worktree/分支正在实施哪个 effort、阶段和主要所有者文件。
3. 从上表选择一个“前置已满足且没有其他 Agent 占用”的最早未完成阶段。
4. 依次阅读该 effort 的 issue/research/design、README、当前 plan/acceptance 和全部既有
   result。
5. 建立独立 worktree，记录 baseline；不得在被阻塞阶段先写兼容代码。
6. 每阶段独立提交并生成 `result-XX.md`；acceptance 不通过时留在当前阶段。
7. Final 验收和合并都需要用户同意；完成后整个 effort 移入
   [`../archive/`](../archive/README.md)。

## 6. 共同执行约定

- 每个阶段同时提供 plan 与可判定 acceptance。
- 开始前记录 commit、dirty files、Node/npm/OS 和 typecheck/unit baseline。
- 不用 skipped/only、延长 timeout、旧接口 fallback 或双写真相源通过验收。
- 发现合并后事实与设计不变量冲突时停止扩大修改，记录证据并回到设计讨论。
- 文档移动或链接修改后运行 `npm run check:links`，并额外检查目录、源码和 anchor。

完整 effort 生命周期见 [`../issues/README.md`](../issues/README.md)；当前已实现架构见
[`../arch/README.md`](../arch/README.md)。
