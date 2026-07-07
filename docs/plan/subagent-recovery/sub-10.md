# sub-10:补完 sub-6 —— 端到端集成测

> sub-6 测试缺口补完。依赖 sub-1..6 全部功能就位。对应 acceptance-6 case 4 的端到端。

## 背景

sub-6 功能(force-Wait hook)已实现 + 单测覆盖各环节契约,但缺**端到端集成测**:delegate(TaskStart 后台)→ force-Wait nudge → agent Wait → task 完成 → workbench 更新 → TaskGet 消费 → turn 结束。sub-6 实现者建议作收尾集成测。

## 任务

写一个集成测(仿 `tests/unit/step-resume.test.ts` 的 model+DB harness 模式),覆盖完整链路:
1. 父 agent TaskStart 一个后台 agent task → registry 有 running task。
2. 父 turn 想结束 → TurnEndCheck(force-Wait hook)检测 hasRunning → nudge 注入 + 跑一步(不结束)。
3. 父调 Wait → 挂起(busy→waiting)。
4. 后台 task 完成 → tryWake → 父 Wait 唤醒(woke: task finished)。
5. workbench Task 段更新(task 终态)。
6. 父 TaskGet(task_id) → 取 result + acknowledge → task 出 registry。
7. hasRunning()=false → 下次 TurnEndCheck 放行 → turn 正常结束。

## 范围

- 用现有 test harness(mock provider + 真实 DB 或 mock store),不启 Electron。
- 若某环节在纯单测环境难模拟(如真 LLM stream),可用 mock stream / 直接触发 hook + registry 状态转换拼接,覆盖"状态机链路"而非"真模型输出"。

## 风险

- 集成测 harness 搭建成本(model mock、DB、hook 注册、registry)。
- 易 flaky(时序)—— 用确定性的 mock,不靠真实 setTimeout race。

## 明确化补遗(2026-07-07)

**测试粒度(PASS 判据)**:覆盖**状态机链路全转换**即 PASS —— 用 mock provider / 直接触发 hook + registry 状态转换拼接,断言每个环节的 registry/workbench/turn 状态正确转换(TaskStart→running、TurnEndCheck nudge→不结束、Wait→waiting、wake→woke:task finished、TaskGet→acknowledge 出 registry、hasRunning=false→放行结束)。**不强求真 LLM stream**。nudge 防死循环用"同 turn 标记"断言(收 nudge 后再结束不再 nudge)。确定性 mock 时钟,不靠真实 setTimeout race。

## 验收

见 `acceptance-10.md`。
