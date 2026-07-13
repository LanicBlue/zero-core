# acceptance-4:Task 合并单 action

> 对应 [./sub-4.md](./sub-4.md)。

## 功能验收

1. **Task 工具 5 action 工作**:`Task {action:'get'/'list'/'kill'/'finish'/'resume'}` 各自工作,行为同原对应工具。
   - 验证:单测每个 action(参照原 task-get/list/kill/finish/resume 测试逻辑)。
2. **顶层 type:object**:Task inputSchema 经 zod `~standard.jsonSchema` 转换,顶层 type:object,无顶层 oneOf/anyOf,action 是 required enum。
   - 验证:手动跑一次 schema 转换断言(sub-5 正式加进 ACTION_SCHEMAS)。
3. **action 必填**:`Task {}`(无 action)→ 校验失败。
   - 验证:单测空 input 被拒。
4. **meta**:Task meta = `{category:"task", isReadOnly:false, isDestructive:false, isConcurrencySafe:false}`。
   - 验证:读 getToolMeta(Task)。
5. **max_completed config 挂 Task**:Task configSchema 含 max_completed(默认 5)。
   - 验证:读 getToolConfigSchema(Task)。
6. **6 旧文件删除**:task-start/get/list/kill/finish/resume.ts 不存在。
   - 验证:文件系统检查 + grep 无残留 import(taskStartTool/taskGetTool 等)。
7. **TOOL_DEFS 注册**:TOOL_DEFS 含 taskTool,不含 6 个旧 task 工具。
   - 验证:`ALL_TOOLS["Task"]` 存在,`ALL_TOOLS["TaskStart"]` 等不存在。

## 不破坏验收

8. **Subagent delegate 后台仍工作**(sub-1):不受 Task 合并影响。
9. **Shell background 仍工作**(sub-2):不受影响。

## build

10. **typecheck 过**(删文件后无残留 import)。
