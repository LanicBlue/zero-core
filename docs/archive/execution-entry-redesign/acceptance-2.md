# acceptance-2:Shell 恢复 background + timeout 默认

> 对应 [./sub-2.md](./sub-2.md)。

## 功能验收

1. **background?:true 立即后台返 task_id**:`Shell {command, background:true}` → 立即返回(不等命令),文本含 task_id。
   - 验证:单测 mock runBackground 返回固定 id,断言 execute 返回 task_id 且立即 resolve。
2. **background 默认 blocking**:`Shell {command}`(无 background)→ blocking 等结果(现状不变)。
   - 验证:单测 blocking 路径返回 stdout + [Completed in Xs](同现状)。
3. **timeout 默认 300s**:`Shell {command}`(无 timeout input,无 config)→ 用 300s 超时。
   - 验证:单测断言传给 exec 的 timeout = 300000ms(或 mock exec 验 opts.timeout)。
4. **timeout input 可覆盖**:`Shell {command, timeout:10}` → 用 10s。
   - 验证:单测 timeout input 优先于默认 300s。
5. **configSchema 去 timeout**:Shell 工具 configSchema 不含 timeout。
   - 验证:读 getToolConfigSchema(Shell) → 无 timeout 字段。

## 不破坏验收

6. **blocking 命令仍工作**:正常短命令 blocking 返回 stdout + [Completed in Xs]。
   - 验证:现有 Shell 测试仍过。
7. **TaskStart{shell} 仍工作**:未动(sub-4 才删)。
   - 验证:TaskStart 现有测试([sub4-task-tools.test.ts](../../../tests/unit/sub4-task-tools.test.ts))仍过。

## 前端验收

8. **ToolsPage 不渲染 Shell timeout config**:Shell 工具详情不显示 timeout 配置项。
   - 验证:configSchema 去掉后 [ToolsPage.tsx](../../../src/renderer/components/tools/ToolsPage.tsx) 不渲染。

## build

9. **typecheck 过**。
