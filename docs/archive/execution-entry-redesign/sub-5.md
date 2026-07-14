# sub-5:RENAMED_TOOLS 迁移 + schema 覆盖

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:sub-4(Task 工具存在 + taskActionSchema export)。

## 范围

RENAMED_TOOLS 补齐 Task 旧名映射(6×PascalCase + lowercase + snake_case → Task),修 sub-4 删旧工具名后的旧配置引用;action-tool-schema.test.ts 加 Task 覆盖。

## 改动

### src/core/tool-registry.ts RENAMED_TOOLS
- [RENAMED_TOOLS](../../../src/core/tool-registry.ts#L83) 现有 task_status→TaskGet / TaskStop→TaskKill / task_start→TaskStart 等(指向已被 sub-4 删除的工具)。
- 改/补,全部指向 **Task**:
  - PascalCase:TaskStart/TaskGet/TaskList/TaskKill/TaskFinish/TaskResume → Task
  - lowercase:taskstart/taskget/tasklist/taskkill/taskfinish/taskresume → Task
  - snake_case:task_start/task_get/task_list/task_kill/task_finish/task_resume → Task
  - 历史 task_status→TaskGet / TaskStop→TaskKill / task_stop→TaskKill 等 → 改指向 Task
- 这样旧配置(policy.tools 的 task_start/TaskGet 等 key)经 buildToolsSet 迁移([index.ts:176](../../../src/tools/index.ts#L176))映射到 Task。

### config key 迁移
- 旧 config key TaskList(含 max_completed)→ Task(走 RENAMED_TOOLS 同款迁移)。
- 验证 buildToolsSet 的 policy.tools 迁移覆盖。

### tests/unit/action-tool-schema.test.ts
- [ACTION_SCHEMAS](../../../tests/unit/action-tool-schema.test.ts#L31) 加 Task(sub-4 export 的 taskActionSchema)。

## 不做(scope 边界)

- category 修正(sub-6)
- prompt 互引文案(sub-7)
- 不改工具功能

## 验证

见 [./acceptance-5.md](./acceptance-5.md)。
