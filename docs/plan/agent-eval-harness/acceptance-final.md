# Final Acceptance：配置化 Flow 与 Agent Eval 端到端验收

> 只在 Acceptance 00–09 全部通过后执行。
> 验收 Agent 应与主要实现 Agent 不同。
> 任一核心场景失败，整个 effort 不得标记完成或归档。

## 1. 前置条件

- [ ] 00–09 各有 `result-XX.md`、commit 和验收证据。
- [ ] 起点包含已最终验收并合并的 `wiki-system-redesign`。
- [ ] 从干净 checkout 和隔离 `ZERO_CORE_DIR` 开始。
- [ ] 准备两个 Git Project、一个 non-Git Project、两个 Agent 和一个 archive fixture。
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

1. Project A 使用默认 7-state definition。
2. Project B 使用 3-state 自定义 definition。
3. 为 A/B 创建 FlowInstance，更新 A 的 active definition。

- [ ] UI/tool/API 均按各自 definition 呈现状态和 transition。
- [ ] A 的既有 instance 固定旧 version/digest，新 instance 使用新 active version。
- [ ] Project B 不出现 A 的状态、文档或 event。
- [ ] 非法 actor/from/revision 均稳定拒绝。

## 4. 场景 C：原子 Transition 与 Work Trigger

1. 对 A instance 执行一次 transition。
2. 配置两个 Work，其中一个匹配、一个不匹配。
3. 重放同一 event。
4. 故障注入 inner Git commit。

- [ ] 成功 transition 产生一个权威 commit、一个 event、一个匹配 WorkRun。
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

- [ ] B 未满足时 A 可继续未 gated 的讨论/计划，但 `begin-build` 被阻止并列出 blocker。
- [ ] `transition-reached` milestone 持续满足，`state-in` milestone 随当前 state 变化；
  regression 发事件但不自动回滚 A。
- [ ] B 满足后只发 dependency event，不自动迁移 A；匹配 Work 可被事件触发。
- [ ] self/cycle 拒绝，并发反向边只有一个提交。
- [ ] missing/unavailable target 为 unknown，gated transition fail closed，其他 Project 正常。
- [ ] dependency 正反索引删除后可从 Project 文件重建。

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
2. 触发 WorkRun B 并发送用户消息。
3. A 进入 Wait，由用户消息唤醒。
4. 在 B queued/running 时重启。

- [ ] B 持久 queued，不 skip、不重复。
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

- [ ] bundled/seed 资源完整且只使用 `skill://`。
- [ ] deterministic 输出一致，JSON/Markdown/exit code 符合合同。
- [ ] timeout 无残留进程/临时目录。
- [ ] 第二轮 archive 扫描不重复 finding。
- [ ] 已注册目标收到带 session 证据的 Found；未知目标只保留报告。
- [ ] 应用启动没有自动 Eval Project/Agent/Cron/运行。

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
- [ ] 旧 `[skills]/`、固定 Flow action、新 Work busy skip、new→Requirement 双写的生产 grep
  均为零或只有明确历史文档命中。

## 15. 最终证据包

验收 Agent 创建 `result-final.md`，包含：

- commit、环境和 00–09 result 链；
- A–L 的实际 trace、Git log、DB/index、UI E2E 和文件工具矩阵；
- baseline/final 命令和测试数量；
- 性能、故障注入与恢复报告；
- 所有偏差、剩余限制和是否阻塞发布的判定。

## 16. 最终通过标准

只有同时满足以下条件才可 PASS：

- [ ] A–L 全部通过。
- [ ] Project 控制面、内层 Git、Flow/Work 事实源无双写。
- [ ] Flow 与 Work 单向事件解耦。
- [ ] Flow dependency 无环、milestone 可配置、gated transition 与事件恢复一致。
- [ ] Flow composition 无环、同 Project 原子、source 历史保留，文档输入固定且不自动
  拼接。
- [ ] 同一 Project Session 多任务连续、逐 turn context 无泄漏。
- [ ] `skill://` / `flow://` 唯一且五个文件工具一致。
- [ ] worktree 无 main fallback。
- [ ] 新 Flow 独立于旧 Requirement。
- [ ] Eval 是可自主演进的 Skill，无启动副作用和自动代码修复。
- [ ] 活动文档、工具 schema、Prompt、UI 和实现一致。
- [ ] 验收者给出明确 `PASS`，不是“基本可用”。
