# acceptance-10:端到端集成测

对应 `sub-10.md`(补完 sub-6)。

## 用例

1. **完整链路跑通**:TaskStart(后台 agent task)→ TurnEndCheck nudge(因 hasRunning)→ 父 Wait → task 完成 → 唤醒 → workbench 更新 → TaskGet 消费 → hasRunning=false → turn 结束。全链路断言通过。
2. **无后台 task 不 nudge**:无 running task 时 TurnEndCheck 放行,turn 直接结束(回归守卫)。
3. **nudge 防死循环**:agent 收 nudge 后不 Wait 直接再结束 → 同 turn 不再 nudge(标记生效),不无限续步。
4. **确定性**:测试不靠真实 setTimeout race,用 mock 时钟/直接触发(不 flaky)。

## 验证手段

- 集成测文件(tests/unit/ 或 tests/integration/),跑过(sibling cwd vitest)。
- 覆盖 acceptance-6 case 4 的端到端语义(各环节已单测,本测串成链)。
- typecheck 三层。
