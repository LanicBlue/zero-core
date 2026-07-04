# acceptance-F5 — 清理 · 测试要求

> 节点 F5 验收。对应 [plan-F5.md](plan-F5.md)。

## 完成判定
旧 requirement-tools / verify-tool 文件删除,无残留引用;注释/文档准确;code-graph 重生成;全量 + 端到端 delivery 绿。

## 静态检查
- `grep -rn "CreateRequirement\|CreateRequirementWithDoc\|createRequirementTool\|createRequirementWithDocTool\|verifyTool" src/` → 仅剩 RENAMED_TOOLS 的 back-compat 映射 + 历史注释(无实际代码引用 / import)。
- 两个旧文件(requirement-tools.ts、verify-tool.ts)已删,无 import 残留。
- code-graph 重生成且入提交。

## 测试 / 回归
- 三层 tsc + build:lib + 全量 vitest 绿。
- 端到端 delivery:create→pick→ready→plan→startBuild→finishBuild→PM work→verify→合并 work→closed 全通;返工回路通。
- 既有引用旧工具名的测试已改测 Flow(或经 RENAMED_TOOLS 仍绿)。

## 提交门
- 三层 tsc + build:lib + vitest(含 delivery 回归)+ acceptance-F1~F4 全过 + diff 只含清理 + code-graph 重生成。

## 完成后
project 类 = Project / Work / Flow 三工具;需求→代码合并全 Flow 驱动 + hook 反应;无旧工具残留。
