# plan-F5 — 清理

> 节点 F5(依赖 F4)。目标:删旧文件、扫注释、code-graph、全回归。Flow 全面接管,无残留。对应 [project-flow.md](./project-flow.md) §8。

## 范围
- 删 `requirement-tools.ts`、`verify-tool.ts`(若 F3 已移注册、F4 已接管 UI,此时无人引用)。
- 扫旧工具名注释/文档:agent-service、fresh-db-seed、runtime/types、server/index、template-store(blockedTools)等处对 CreateRequirement/CreateRequirementWithDoc/verify 的引用,更新为 Flow(或确认经 RENAMED_TOOLS 自动迁移、注释准确性)。
- template-store 的 blockedTools 列表里 "CreateRequirement" → "Flow"(或留 RENAMED 处理 + 注释)。
- code-graph 重生成。
- 全量回归 + 端到端 delivery 链。

## 实现步骤
1. grep 全仓 `CreateRequirement`/`CreateRequirementWithDoc`/`verify-tool`/`createRequirementTool`/`verifyTool` 残留,逐一处理(删引用 / 改 Flow / 改注释)。
2. 删两个旧工具文件(requirement-tools.ts、verify-tool.ts),确认无 import 残留(tsc 会抓)。
3. code-graph:`npm run build:codegraph`。
4. 全量 vitest + 三层 tsc + build:lib。
5. 端到端 delivery 手动/e2e 跑通(F3 已搭,本阶段确认无回归)。

## 关键文件
删:`requirement-tools.ts`、`verify-tool.ts`。改注释/引用:agent-service、fresh-db-seed、runtime/types、server/index、template-store、tests。

## 风险
- 删文件前确认无 import(tsc 抓);template-store blockedTools 等字符串引用经 RENAMED_TOOLS 是否仍有效——确认。
- 既有测试若直接 import 旧工具(createRequirementTool/verifyTool)需改测 Flow。
