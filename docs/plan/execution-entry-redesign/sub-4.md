# sub-4:Task 合并单 action + 删旧 + 注册

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:sub-1(Subagent 接管 start{agent})+ sub-2(Shell background 接管 start{shell})。

## 范围

把 6 个独立 task 工具合并成单 `Task` action 工具(5 action:get/list/kill/finish/resume,**不含 start** —— 已被 Subagent/Shell 接管),删 6 旧文件,注册到 TOOL_DEFS。复刻 [project-tool.ts](../../../src/tools/project-tool.ts) 结构。

## 改动

### 新建 src/tools/task-tool.ts
- 单 `Task` 工具,扁平 schema:`z.object({ action: z.enum(["get","list","kill","finish","resume"]), ...各 action 字段全 optional })`
- execute `switch(input.action)` 分发,每个 case 内联原工具 execute 逻辑(从旧文件搬):
  - get:单 task 钻取,按 running/interrupted/completed 三状态分支(搬 [task-get.ts](../../../src/tools/task-get.ts))
  - list:富列表 + tree,带 max_completed config(搬 [task-list.ts](../../../src/tools/task-list.ts))
  - kill:running→kill / interrupted→abandon(搬 [task-kill.ts](../../../src/tools/task-kill.ts))
  - finish:优雅收尾,仅 agent(搬 [task-finish.ts](../../../src/tools/task-finish.ts))
  - resume:解冻冻结子,仅 agent(搬 [task-resume.ts](../../../src/tools/task-resume.ts))
- meta:`{ category:"task", isReadOnly:false, isDestructive:false, isConcurrencySafe:false }`(action 惯例)
- config:max_completed 从 TaskList 挂到 Task(configSchema)
- per-action 必填 runtime 校验(参照各原工具)
- export `taskActionSchema`(供 sub-5 action-tool-schema 覆盖)
- format:透出 data.text

### 删除 6 旧文件
- task-start.ts(功能被 Subagent/Shell 接管)
- task-get.ts / task-list.ts / task-kill.ts / task-finish.ts / task-resume.ts(逻辑搬进 task-tool.ts)

### 注册 src/tools/index.ts
- [TOOL_DEFS](../../../src/tools/index.ts#L102):6 个 task 工具(taskStartTool...taskResumeTool)→ 1 个 taskTool
- import 改:删 6 个 import,加 taskTool

## 不做(scope 边界)

- RENAMED_TOOLS 迁移(sub-5)—— 本 sub 删旧名后旧配置/prompt 引用暂失效,sub-5 映射修复
- category 修正(sub-6)
- prompt 互引文案(sub-7)
- action-tool-schema.test.ts 覆盖(sub-5)

## 中间状态注意

- 本 sub 删 TaskStart/TaskGet/.../TaskResume 工具名后,旧 agent 配置(policy.tools 的 task_start 等 key)和旧 prompt 引用("use TaskGet")暂时失效,直到 sub-5(RENAMED_TOOLS)+ sub-7(prompt)完成。
- **本 sub 后系统 build 过、新 Task 工具工作,但旧名引用暂时断** —— 已知中间状态,sub-5/sub-7 修复。acceptance 验证新 Task 工作,不要求旧名兼容(那是 sub-5)。

## 验证

见 [./acceptance-4.md](./acceptance-4.md)。
