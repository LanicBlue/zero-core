# acceptance-7:prompt 互引统一

> 对应 [./sub-7.md](./sub-7.md)。

## 验收

1. **无旧工具名引用**:Subagent/Task/Shell/Wait/Orchestrate/Cron 的 prompt 里无 "TaskStart"/"TaskGet"/"TaskList"/"TaskKill"/"TaskFinish"/"TaskResume" 字样(sub-4 后这些工具不存在)。
   - 验证:grep 这些字符串于上述工具 prompt → 0 命中。
2. **新形态引用**:prompt 里用 `Task action:'get'/'list'/'kill'/'finish'/'resume'` 形态。
   - 验证:grep "Task action" / "action:'get'" 等于相关 prompt → 命中。
3. **Subagent delegate 后台文案**:Subagent prompt 说明 delegate 默认后台返 task_id。
   - 验证:读 Subagent prompt 含 "background"/"task_id"。
4. **Shell background + 超时转后台文案**:Shell prompt 含 `background?:true` + 超时转后台 + agent 决定。
   - 验证:读 Shell prompt。
5. **bash.ts:244 修**:不再有过时 "auto-backgrounds as a safety net (you get a task_id)" 文案;改反映 sub-3 实际行为。
   - 验证:读 bash.ts prompt,无过时文案。
6. **Wait prompt 更新**:Wait prompt 指向 Subagent delegate / Shell background 派后台(不再 TaskStart)。
   - 验证:读 Wait prompt。

## 不破坏验收

7. **功能不变**:prompt 文案改动不影响 execute 行为。
   - 验证:各工具现有测试(action 调用)仍过。

## build

8. **typecheck 过**(prompt 改动不影响类型)。
