# Plan 01：Policy、Snapshot 与 CompactionAtom

## 目标

建立无 Provider/Wiki 副作用的纯 policy 与 Snapshot 基础，固定水位、TTL eligibility、
semantic activity、coverage、generation/digest 和 Turn 内多次压缩边界。

## 工作

1. 实现纯函数 policy：

   ```text
   preferred(W) = min(50%W, 100K)
   hard(W)      = min(75%W, 400K)
   target(W)    = min(30%W, 60K)
   summaryCap   = min(10%W, 12K)
   ```

   `effectiveHard` 扣除 output/protocol reserve。
2. 使用组装后 token estimate；定义 estimator 不确定性和 request-fit guard，禁止字符数直接
   作为 cursor 决策。
3. 实现 `CompactionAtom` builder：sealed Step、tool call/result、AskUser/answer 不可拆；
   在途 Step、pending user message 和未闭合组只进 fresh tail。
4. 删除“保留完整 Turn”的假设；允许一个 Turn 在多个完整 StepEnd 产生多个 Snapshot。
5. 实现不可变 `CompactionSnapshot`，包含 boundary、maintenance cursor、generation、
   history digest、provider/model/policy/prompt/wiki base revision 和 bounded continuity。
6. Snapshot coverage 是 `cursor + 1 .. B`；continuity reference 不进入 coverage。
7. 实现 preferred eligibility：TurnEnd/Wait + context threshold + 无新 semantic Step +
   foreground Provider cache TTL 已过。
8. semantic Step 只包含会进入 Session 历史的用户/Agent/tool/invocation/task event；stream、
   heartbeat、usage、Provider retry telemetry 不重置。
9. hard eligibility 在完整 StepEnd 生效；PreLLM request-fit 是最终防线。
10. 本阶段不调用模型、不写 Wiki/DB、不接生产 trigger。

## 完成

[Acceptance 01](acceptance-01-policy-snapshot-atoms.md)通过并创建 `result-01.md`。
