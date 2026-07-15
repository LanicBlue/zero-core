# acceptance-4 Task(#1 + #10)

> 独立验收清单。对应 [`./sub-4.md`](./sub-4.md)。重点验 **runtime 接线**(feedback-verify-runtime-wiring):不能只验 deleteDelegatedTask 存在,要验 Task get 真的删了行 + restoreDelegatedTasks 真的不再 re-seed。

## #1 acknowledge 删 DB 行

1. **deleteDelegatedTask 删行**:session-db.deleteDelegatedTask(id) 后,getDelegatedTask(id) 返 undefined。
2. **Task get 删 DB 行(接线!)**:完成态 task,调 Task `get` → 之后 `db.getDelegatedTask(taskId)` 返 undefined(不只 registry 内存删)。这是核心断言——证明 acknowledgeTask 真调了 deleteDelegatedTask。
3. **re-seed 不再复活(端到端)**:完成 task → Task get(acknowledge + 删行)→ 模拟 loop 重建(调 restoreDelegatedTasks)→ 该 task **不出**现在新 registry(行已删,无 re-seed)。这是修"新 turn 后又出现"的直接证据。
4. **abandon 也删行**:interrupted task → TaskKill(abandon 路径)→ DB 行删除(getDelegatedTask undefined)。
5. **未 acknowledge 的完成 task 仍 re-seed(不误伤)**:完成 task,**不** get → restoreDelegatedTasks → 仍 re-seed(行还在,inbox 存活)。
6. **interrupted task 仍 re-seed(不误伤 sub-8)**:interrupted task(未 abandon/acknowledge)→ restoreDelegatedTasks → 仍 re-seed 为 interrupted(resume 链不破)。
7. **归档 no-op 安全**:行已被 acknowledge 删后,deleteSessionData(子 session)的 `DELETE FROM delegated_tasks WHERE session_id=?` 不报错(no-op)。
8. **acknowledgeTask 无 db 时容错**:测试 stub 无 db(config.db undefined)→ acknowledgeTask 不抛(?. 短路),registry.acknowledge 仍生效。

## #10 list 汇总

9. **list 末尾有 Summary 行**:`Task { action: "list" }` 输出含 `Summary: ...` 行。
10. **聚合正确**:3 个 task tokens 分别 100/200/300 → Summary tokens=600;elapsed 同理求和;max = 三者最长。
11. **空 list 也安全**:无 task 时 Summary 行不崩(或显示 0)。
12. **filter/taskIds 路径仍有 Summary**:list 带 filter 或 taskIds 时,Summary 反映过滤后集合。

## 通用

13. **typecheck 绿**。
14. **既有 task 测试不回归**:`sub4-task-action-tool.test.ts`、`sub10-e2e-delegation.test.ts` 仍绿。
