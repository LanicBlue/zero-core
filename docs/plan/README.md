# docs/plan — 待实施或实施中的计划

本目录保存已经完成设计、拆成实施步骤和验收条件，但尚未成为当前代码事实的 effort。
本页是实施 Agent 的选择入口；进入具体 effort 后仍必须阅读其 issue、design、README、
当前 plan/acceptance 和已有 result。

> 核对日期：2026-07-18。下列依赖是当前人工/文档交接约束，不表示 zero-core 已经创建
> FlowDependency、FlowInstance 或自动执行门禁。

## 1. 当前选择结论

| Effort | 状态 | 现在能否新开实施 | 首个外部前置 |
|---|---|---:|---|
| [`wiki-system-redesign`](wiki-system-redesign/README.md) | 另一 worktree 实施中 | 只由既有实施工作继续 | 无 |
| [`backend-io-scheduling`](backend-io-scheduling/README.md) | Ready，未实施 | 否 | Wiki Final PASS + merge |
| [`session-turn-lifecycle`](session-turn-lifecycle/README.md) | Ready，未实施 | 否 | Wiki Final PASS + merge |
| [`local-backend-security-boundary`](local-backend-security-boundary/README.md) | Ready，未实施 | 否 | Wiki Final PASS + merge |
| [`project-flow-system`](project-flow-system/README.md) | Ready，未实施 | 否 | Wiki Final PASS + merge |
| [`agent-work-runtime`](agent-work-runtime/README.md) | Ready，未实施 | 否 | Project Flow Final + Session Lifecycle Final |
| [`project-management-ui`](project-management-ui/README.md) | Ready，未实施 | 否 | Wiki Final + Project Flow Final；Plan 04 起另需 Work Final |
| [`agent-eval-harness`](agent-eval-harness/README.md) | Ready，未实施 | 否 | Project Flow Final + Agent Work Runtime Final |

原 `agent-eval-harness` 大 effort 已拆为后四项。共同职责和端到端合同见
[Agent Project Automation](agent-project-automation.md)，最终执行
[Integration Acceptance](agent-project-automation-acceptance.md)；这两个文件不是第五个
实施 effort。

## 2. Effort 依赖图

```text
wiki-system-redesign FINAL + merge
├──→ backend-io-scheduling FINAL
├──→ session-turn-lifecycle FINAL ───────────┐
├──→ project-flow-system FINAL ──────────────┼──→ agent-work-runtime FINAL
│                    │                       │             ├──→ agent-eval-harness FINAL ─┐
│                    └──→ project-management-ui 00–03      └──→ UI Plan 04/06 ───────────┤
│                                      └──────────→ UI Plan 05 ────────────────────────┤
└──→ local-backend-security FINAL                                                    │
                                                                                     ↓
                                                                       Integration Acceptance
```

准确含义：

1. Wiki Final 与合并是 Backend I/O、Session、Security 和 Project Flow 的共同人工硬门禁。
2. Wiki 合并后，Backend I/O、Session、Security 和 Project Flow 都没有产品语义上的相互
   前置；但 Backend I/O 与 Security 共享 startup/readiness，不能在不同旧 baseline 上
   同时修改这些文件。
3. Agent Work Runtime 同时消费 Project Flow event/tool contract 和 Session Lifecycle
   supervisor，两个 Final 缺一不可。
4. Project Management UI Plan 00–03 等待 Wiki 与 Project Flow；其中 Wiki Final 是为了
   读取其已合并的 Project 页面和索引卡，而不是并行重做 Wiki UI。
5. Project Management UI Plan 04 和 Final 还等待 Work；Plan 05 importer 不等待 Work。
6. Agent Eval Harness 等待 Flow/Work，但不等待 UI；Work Final 后可与 UI 后半段并行。
7. Local Backend Security 不定义 Flow/Session 产品语义；后合并者仍需对齐共同
   HTTP/WS/IPC/server composition 文件。
8. Integration Acceptance 只做跨 effort 验证，不补写任何子 effort 未完成的功能。
9. Backend I/O 是独立平台 effort，不是 Agent Project Automation Integration 的前置；
   它提供 maintenance job，而不是 WorkRun。若与 Session/Security 并行，后合并者按真实
   result 对齐共享 composition 文件。

## 3. Wiki 合并后的推荐选择

实施 Agent 应选择“所有前置已满足且无人占用”的 effort：

| 可选工作 | 适合条件 | 注意事项 |
|---|---|---|
| Backend I/O Scheduling Plan 00 起 | 优先保证新 Wiki 的索引、迁移、归档不冻结 backend | 与 Security startup、Session archive 协调 owner；不全面替换 better-sqlite3 |
| Session Lifecycle Plan 00 起 | 优先稳定 Runtime、Stop、Wait、Provider 恢复、后台任务和 UI 状态 | 会解除 Work Runtime 前置 |
| Project Flow System Plan 00 起 | 优先建立 `.zero-core`、多 Definition、Flow/关系图与工具 | 可与 Session 并行 |
| Local Backend Security Plan 00 起 | 独立处理本机进程安全边界 | 可并行，但关注 server wiring 冲突 |
| Agent Work Runtime Plan 00 起 | Flow 与 Session 均 Final | 不得重建 Flow 或 Session 状态机 |
| Project Management UI Plan 00–03 | Wiki Final + Project Flow Final | 先统一 Project 页面，再完成 Flow Studio/视图；可与 Work Runtime 并行 |
| Project Management UI Plan 04/06 | Agent Work Runtime Final | 接入真实 Work API，不使用 mock 长期兼容层 |
| Project Management UI Plan 05 | UI Acceptance 03 | importer 可在等待 Work 时实施 |
| Agent Eval Harness Plan 00 起 | Flow 与 Work 均 Final | 可与 UI 并行，不等待 importer |

若只能串行安排一个实施 Agent，默认建议：

```text
Wiki merge
→ Backend I/O Scheduling
→ Session Lifecycle
→ Project Flow System
→ Agent Work Runtime
→ Agent Eval Harness
→ Project Management UI
→ Integration Acceptance
```

Backend I/O、Project Flow 与 Session 的先后可按 owner 冲突调整；Eval/UI 的先后也可以
交换。Local Backend Security 可在 Wiki 后的独立窗口插入，但若与 Backend I/O 同期安排，
必须错开 startup/readiness 阶段，实际优先级由用户决定。

## 4. 并行与冲突边界

- 每个 effort 使用独立 worktree/分支。
- Wiki 未合并前，所有后续 effort 都不得按旧 Core DB、Runtime、CallerCtx、文件保护或
  Project UI 接口编码。
- Session Lifecycle 与 Project Flow 可并行，但不得相互提前建立兼容层；Work Runtime
  Plan 00 以两者 Final 的真实接口统一接线。
- Backend I/O 与 Project Flow/Eval 无文件级核心重叠；与 Security 共享 server startup，
  与 Session 共享 archive integration。先合并者成为真实 baseline，后执行者不得恢复旧
  composition 或把 MaintenanceJob 合并进 SessionTaskEvent/WorkRun。
- Project Management UI 与 Eval 可以并行；前者拥有 Project 页面壳层、renderer 模块
  编排和 presentation，后者主要拥有 bundled Skill 资产。
- 后合并者必须读取所有前置 result，记录真实冲突，不用旧文件名机械实现。

## 5. 实施 Agent 选择流程

1. 检查目标分支是否包含所有外部前置的 Final result 和用户同意的 merge commit。
2. 检查其他 worktree/分支正在实施的 effort、阶段和所有者文件。
3. 从上表选择前置满足且无人占用的最早阶段。
4. 阅读共同合同、effort issue/design/README、当前 plan/acceptance 和既有 result。
5. 建立独立 worktree并记录 baseline；不得在被阻塞阶段先写 adapter。
6. 每阶段独立提交并生成 `result-XX.md`；acceptance 不通过时留在当前阶段。
7. 每个 effort 的 Final 与合并都需要用户同意；全部基础 effort 完成后再执行集成验收。

## 6. 共同执行约定

- 每个阶段同时提供 plan 与可判定 acceptance。
- 开始前记录 commit、dirty files、Node/npm/Git/OS 和 typecheck/unit baseline。
- 不用 skipped/only、延长 timeout、旧接口 fallback 或双写真相源通过验收。
- 发现事实与共同合同冲突时停止扩大修改，记录证据并回到设计讨论。
- 文档移动或链接修改后运行 `npm run check:links`，并检查目录、源码和 anchor。

完整 effort 生命周期见 [`../issues/README.md`](../issues/README.md)；当前已实现架构见
[`../arch/README.md`](../arch/README.md)。
