# acceptance-8:懒重建 + interrupted-status seed

对应 `sub-8.md`(补完 sub-3)。

## 用例

### 懒重建
1. **不 eager 全建**:`restoreAllSessions` 启动后,**只有 incomplete turn 的 session** 有 loop;已完成 turn 的 session 无 loop(直到 activate)。
2. **activateSession 按需建**:用户打开一个未建 loop 的 session → `activateSession` 建 loop(无回归)。
3. **activeSessions 锚定保留**:每个 agent 仍指向其最近 session(UI 列表正常)。
4. **假设审计**:`getRuntimeTaskTree` / config-sync / metrics / sessionManager 在 loop 未预建时不报错(按需建或容忍)。
5. **recovery 不回归**:有 incomplete turn 的 chat session 仍 auto-resume;delegated 仍冻结(sub-3 不变)。

### interrupted-status seed
6. **冻结子显 Interrupted**:冻结子(delegated + incomplete turn)的 task 记录 seed 进父 registry 时 status = `interrupted`;父 workbench 显 `[taskX] Interrupted`。
7. **非冻结子不误标**:已完成/正常子 task 的 status 不被误标 interrupted。
8. **TaskGet(interrupted) 联动**:`TaskGet` 对 seed 的 interrupted task 返回 waited + "[interrupted by restart]"(sub-4 已实现,本 sub 确认数据源 seed 正确)。

## 验证手段

- 集成测:构造 chat(完成)+ chat(incomplete)+ delegated(incomplete)三 session,重启后断言 loops 只含 incomplete;delegated 不 resume;delegated task 在父 registry status=interrupted。
- 单测:restoreDelegatedTasks 对 incomplete-turn 子标 interrupted;对完成子不标。
- typecheck 三层 + vitest(sibling cwd)。
