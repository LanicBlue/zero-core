# Integration Acceptance：Agent Project Automation

> 只在四个子 effort 的 Final Acceptance 全部 PASS 并合并后执行。
> 验收 Agent 应与主要实现 Agent 不同。
> 本验收不补写子 effort 功能；任一核心场景失败都不得声明整套设施完成。

## 1. 前置条件

- [ ] `project-flow-system`、`agent-work-runtime`、`project-management-ui` 和
  `agent-eval-harness` 各有 Final result、commit 和验收证据。
- [ ] 起点包含已最终验收并合并的 `wiki-system-redesign`。
- [ ] 从干净 checkout 和隔离 `ZERO_CORE_DIR` 开始。
- [ ] 准备两个 Git Project、一个 non-Git Project、两个 Agent 和一个 archive fixture。
- [ ] 管理 Agent持有 Project；普通 Project Agent持有 Flow/Work；另有一个无 Work 工具
  的执行 Agent作为权限对照。
- [ ] 准备一个旧 Requirement fixture，但新 Flow 尚未 import。

## 2. 场景 A：Project 控制目录

1. 注册 Git Project、non-Git Project 和一个 root 为 linked worktree 的 Project。
2. 检查 manifest、外层 exclude、内层 Git 和 control status。
3. 制造一个未知非空 `.zero-core` 冲突。

- [ ] 三个合法 Project 初始化成功，路径均从注册根计算。
- [ ] 外层 Git 不跟踪控制面，内层 Git 只跟踪允许内容。
- [ ] `git clean -fdx` 保留嵌套仓库，文档明确 `-ffdx` 风险。
- [ ] 冲突 Project 被隔离，其他 Project 和应用正常。

## 3. 场景 B：Project FlowDefinition

1. Project A 同时激活 delivery、implementation-task、incident 三个 definition。
2. Project B 使用 3-state 自定义 definition。
3. 管理 Agent 通过 Project.config 发布/激活 Flow 与 Work definition，并选择 A 的
   defaultDefinitionId。
4. 为每个 definition 创建 FlowInstance，只更新 A 的 delivery active binding。
5. 修改 delivery FlowView 的颜色、布局和 progress projection。
6. 在 Project 页面切换 A/B、从 Overview blocker/WorkRun/Wiki 状态进入对应详情，再刷新
   和返回。

- [ ] UI/tool/API 均按各自 definition 呈现状态和 transition。
- [ ] 切换 delivery binding 不改变 implementation-task/incident binding。
- [ ] 只有持有 Project 的管理 Agent能 publish/activate definition。
- [ ] 普通 Agent 的 Flow/Work 工具不能修改 definition。
- [ ] A 的既有 instance 固定旧 version/digest，新 instance 使用新 active version。
- [ ] FlowView 修改立即改善展示，但不改变 semantic digest、allowed transition 或 event。
- [ ] Project 页面由统一 selector/header/Overview/Flows/Work/Wiki/Settings 壳层编排，
      Wiki 管理继续使用 Wiki Final 的 API/job 语义。
- [ ] Project/section/filter navigation 可恢复，Overview deep link 与详情筛选一致。
- [ ] Overview 某一领域失败不遮蔽其他模块，且不使用 mock/旧 schema 伪装健康状态。
- [ ] Project B 不出现 A 的状态、文档或 event。
- [ ] 非法 actor/from/revision 均稳定拒绝。

## 4. 场景 C：原子 Transition 与 Work Trigger

1. 对 A instance 执行 Discuss→Ready，触发 Plan Work。
2. Plan Agent 先审核需求，再执行 Ready→Discuss 打回并填写 reason。
3. 依次验证 Plan→Build→Plan、Build→Verify→Build，并最终前进。
4. 配置匹配正向、匹配反向和不匹配的 Work。
5. 重放同一 event。
6. 从不同活动状态执行 abandon，并配置 terminal event 通知 Work。
7. 故障注入 inner Git commit。

- [ ] 成功 transition 产生一个权威 commit、一个 event、一个匹配 WorkRun。
- [ ] 三组反向 transition 均追加 event，并触发配置的返工 WorkRun。
- [ ] 返工 WorkRun 是新 run，不改写或 retry 已完成交接 run。
- [ ] 缺失 reason、非法 actor 和 stale expectedRevision 的打回稳定拒绝。
- [ ] 多轮往返保留完整 history；latched milestone 不回滚，live milestone 正确 regression。
- [ ] abandon 保留实例/文档/history，取消此前活动 run，不误杀发起 run或通知 run。
- [ ] terminal-blocked dependent 可见且未被级联废案。
- [ ] 重放不产生第二个 WorkRun。
- [ ] 不匹配 Work 不运行。
- [ ] commit 故障不更新 index、不发 event、不创建 WorkRun。
- [ ] FlowDefinition/FlowService 不引用 Work id。

## 5. 场景 D：Flow dependency

1. 让 Project B 的 FlowInstance 暴露 `final-accepted` 与 `merged` milestone。
2. 让 Project A instance 依赖 B 的两个 milestone。
3. A 的 `begin-build` transition 声明 dependency gate。
4. 依次推进 B，并尝试 A transition。
5. 尝试 self、A→B/B→A 和缺失 target。
6. 在 A/B 之间创建 related relation，并分别查看 dependency/related 图层。

- [ ] B 未满足时 A 可继续未 gated 的讨论/计划，但 `begin-build` 被阻止并列出 blocker。
- [ ] `transition-reached` milestone 持续满足，`state-in` milestone 随当前 state 变化；
  regression 发事件但不自动回滚 A。
- [ ] B 满足后只发 dependency event，不自动迁移 A；匹配 Work 可被事件触发。
- [ ] self/cycle 拒绝，并发反向边只有一个提交。
- [ ] missing/unavailable target 为 unknown，gated transition fail closed，其他 Project 正常。
- [ ] dependency 正反索引删除后可从 Project 文件重建。
- [ ] related 可导航但不参与 blocker、cycle、milestone 或 gate。
- [ ] dependency、lineage、related 在 UI 中可独立开关且不会混成同一边。

## 6. 场景 E：FlowInstance split、merge 与 lineage

1. 在 Project A 按 policy 把一个 parent split 成两个 child，并配置 parent 对 child
   `completed` milestone 的 dependency。
2. 重放同一 idempotency key，并制造第二个 child 写入前的 commit 故障。
3. 把两个 child merge 成新 target。
4. 用另一组实例 merge 到 policy 允许的既有 target。
5. 尝试跨 Project composition 和 lineage cycle。

- [ ] split/merge 分别只产生一个权威内层 Git commit；失败不留部分 child、target、
  dependency、manifest 或 event。
- [ ] 同一 idempotency key 重试返回同一 operation；source/parent 保留，currentState
  与既有 transition history 不被隐式改变，参与实例 revision 正确推进。
- [ ] parent dependency、composition lineage 是两类独立边，查询和 UI 不混淆。
- [ ] merge 新/既有 target 都固定全部 source document revisions，核心不自动拼接正文。
- [ ] split/merge event 可触发匹配 Work，但 Flow 不自动 dispatch 或 transition。
- [ ] lineage cycle 和跨 Project composition 拒绝；跨 Project dependency 仍正常。
- [ ] 删除 lineage/idempotency index 后可从 composition manifest 重建；同 key 重试仍
  返回原 operation，并幂等补发漏失事件。

## 7. 场景 F：同一 Project Session 多任务

在同一 Agent + Project Session 中依次：

1. 用户讨论 Flow item A；
2. WorkRun A 在 worktree A 执行；
3. 用户讨论 Flow item B；
4. WorkRun B 在 Project root 执行；
5. Agent 查看两个 item、Plan 和 WorkRun 历史。

- [ ] Session id 稳定，项目历史连续可见。
- [ ] 四个 turn 有不同 invocationId。
- [ ] Worktree A cwd/mount 不泄漏到用户 B 或 Work B。
- [ ] tool audit、prompt environment 和 Flow current mount 与各 turn 一致。

## 8. 场景 G：Busy、Wait、重启

1. WorkRun A 长时间运行。
2. 触发 WorkRun B/C，Agent defer A、prioritize C，再 switch A→C。
3. 发送用户消息，C 进入 Wait并被用户消息唤醒。
4. 在 A deferred、B queued、C running 时重启。

- [ ] B 持久 queued，不 skip、不重复。
- [ ] A 的 defer reason/notBefore/revision 持久，C 按 Agent选择安全成为下一 Turn。
- [ ] switch 没有并发 run，A worktree/mount 不泄漏到 C。
- [ ] 没有 Work 工具的 fixture 不能调整 queue，但仍能正常执行 dispatch run。
- [ ] 同一 Loop 无并发 run。
- [ ] Wait handoff 后用户 turn 使用 Project context，不继承 A worktree。
- [ ] 重启后 B 按 snapshot/retry 恢复一次。
- [ ] terminal A 不被重放。

## 9. 场景 H：VFS 与物理目录

对 Read/Write/Edit/Glob/Grep：

- 使用 `skill://`；
- 使用 `flow://project` / `flow://current`；
- 尝试 `[skills]/`；
- 尝试物理 `.zero-core`；
- 从内部 worktree 操作源码并尝试向父目录逃逸。

- [ ] 两种规范 URI 在所有工具行为一致并回映射结果。
- [ ] 旧 skill prefix 和物理控制面不可用。
- [ ] Project 文件树/search/context 不出现 `.zero-core`。
- [ ] worktree 源码正常，父控制面逃逸失败。
- [ ] Agent error/result 不暴露 Flow 物理路径。

## 10. 场景 I：Worktree 失败语义

依次制造 Git missing/non-Git/branch collision/create failure/merge conflict/cleanup failure。

- [ ] 创建失败均不 dispatch Agent、不回退主目录。
- [ ] merge/cleanup 失败可恢复且 Flow 文档保留。
- [ ] worktree retain/cleanup/merge 来自 Work snapshot。
- [ ] 其他 Project/worktree/inner Git 不受影响。

## 11. 场景 J：Requirement Importer

1. preview 一个旧 Requirement。
2. execute。
3. 重复 execute。
4. 制造未知状态和中断。

- [ ] preview 与实际 mapping/hash/count 一致。
- [ ] 重复/恢复不产生重复 instance。
- [ ] provenance 完整。
- [ ] 旧 Requirement 状态、表和文档完全不变。
- [ ] 新 Flow UI/Service 不 import 旧状态机。

## 12. 场景 K：Eval Skill

1. fresh seed Eval Skill。
2. 运行 deterministic scenario 两次。
3. 运行失败、timeout 和 cleanup fixture。
4. 对 archive fixture 执行两轮增量分析。
5. 对语义等价的 archive-v1、OTLP JSON 和 OTLP Protobuf fixtures 执行相同 grader。
6. 显式生成一次 `gen_ai.evaluation.result`，再验证默认 profile 不发送 telemetry。

- [ ] bundled/seed 资源完整且只使用 `skill://`。
- [ ] deterministic 输出一致，JSON/Markdown/exit code 符合合同。
- [ ] 三类 input adapter 进入同一版本化 normalized trajectory，等价输入得到相同结果。
- [ ] operation/response evaluation event 映射、trial/outcome 非误用、规范 revision、
  adapter version、未知属性和 redaction 可审计。
- [ ] 默认离线且内容关闭；长期 Session 不是单一 trace，普通 reasoning 不冒充 `plan`。
- [ ] timeout 无残留进程/临时目录。
- [ ] 第二轮 archive 扫描不重复 finding。
- [ ] 已注册目标收到带 session 证据的 Found；未知目标只保留报告。
- [ ] 应用启动没有自动 Eval Project/Agent/Cron/运行或 OTel exporter。
- [ ] Eval effort 没有修改或 instrument AgentLoop/Provider/Session/Tool/Flow/Work runtime。

## 13. 场景 L：安全、恢复与索引

- [ ] junction/traversal/malformed YAML/archive/forged actor 稳定拒绝。
- [ ] 删除 Flow 查询索引后能从 Project 控制面重建。
- [ ] dependency reverse index 与漏发 satisfaction event 可重建/补发且不重复 WorkRun。
- [ ] composition lineage index 与漏发 split/merge event 可重建/补发且不重复 WorkRun。
- [ ] pending transition、repo lock、disk/Git failure 的恢复一致。
- [ ] 一个损坏 Project 不阻止其他 Project。
- [ ] DB 不含 Flow Markdown 正文。

## 14. 全局命令

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

- [ ] 全部成功。
- [ ] 没有 skipped/only 绕过核心验收。
- [ ] 旧 `[skills]/`、固定 Flow action、旧 Work definition-management action、新 Work busy
  skip、new→Requirement 双写的生产 grep 均为零或只有明确历史文档命中。

## 15. 最终证据包

验收 Agent 在 `docs/plan/` 创建 `agent-project-automation-result.md`，包含：

- commit、环境和四个子 effort Final result 链；
- A–L 的实际 trace、Git log、DB/index、UI E2E 和文件工具矩阵；
- baseline/final 命令和测试数量；
- 性能、故障注入与恢复报告；
- 所有偏差、剩余限制和是否阻塞发布的判定。

## 16. 最终通过标准

只有同时满足以下条件才可 PASS：

- [ ] A–L 全部通过。
- [ ] Project 控制面、内层 Git、Flow/Work 事实源无双写。
- [ ] Project/Flow/Work 工具级权限边界成立，无 action-level grant 或定义/运行双语义。
- [ ] Flow→event→Work 保持单向依赖解耦，同时 Flow state transition graph 支持配置回边。
- [ ] FlowInstance 可审计废案，WorkRun 可审计 defer/prioritize/switch。
- [ ] Flow dependency 无环、milestone 可配置、gated transition 与事件恢复一致。
- [ ] Flow composition 无环、同 Project 原子、source 历史保留，文档输入固定且不自动
  拼接。
- [ ] related relation 不参与 gate；FlowView 与 semantic definition 分离。
- [ ] 返工/循环时 UI 不显示伪线性进度，百分比仅来自显式 presentation projection。
- [ ] Project Management UI 不复制 Wiki/Flow/Work/Session 状态源，模块局部失败可恢复。
- [ ] 同一 Project Session 多任务连续、逐 turn context 无泄漏。
- [ ] `skill://` / `flow://` 唯一且五个文件工具一致。
- [ ] worktree 无 main fallback。
- [ ] 新 Flow 独立于旧 Requirement。
- [ ] Eval 是可自主演进的 Skill，OTel 仅为版本化 adapter，无启动副作用、Core
  instrumentation 和自动代码修复。
- [ ] 活动文档、工具 schema、Prompt、UI 和实现一致。
- [ ] 验收者给出明确 `PASS`，不是“基本可用”。
