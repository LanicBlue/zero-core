# v0.8 实现计划(impl-plan)

> [workflow-spec.md](./workflow-spec.md) 的实现拆解索引。每阶段详情见对应 `plan-Px.md`。
> 规范是「为什么/是什么」,本文档是「按什么顺序做、怎么算 done」。

## 推进方式
- **sub1 实现**每一阶段(按下面顺序,对照该阶段 `plan-Px.md`)。
- **sub2 三步验收**(按该阶段 `acceptance-Px.md`):
  1. **review 代码** —— 读 sub1 的实际改动,对照 acceptance 清单逐条核对(实现是否到位、有无越界、是否符合契约)。
  2. **写测试脚本** —— 针对该阶段验收项写测试,**包含 unit 测试(数据/store/migration/逻辑)和 e2e 测试(UI/端到端流程,用已有 e2e 基建 `ZERO_CORE_TEST_FIXTURE`,见 `project-e2e-test-setup`)**。每条 acceptance 验收项都要有对应测试覆盖。
  3. **执行测试** —— 跑测试,确认绿。
- 验收(含 review + 测试)通过 → commit git → 下一阶段;不通过 → 把 sub2 的 review 意见 + 测试失败喂回 sub1 迭代到通过。
- 每阶段宣称完成前:`npm run build:lib`(tsc 类型检查,契约见 `feedback-build-verification`)+ 测试绿。
- schema 变更走显式 migration + 同步 `*_COLUMNS`(契约 1.2)。
- 遇到规范没覆盖或无法解决的问题,停下来问用户。

## 关键路径与并行
- **关键路径**:P0 → P1 → P2 → P3 → P7(流程闭环)。
- 可并行:**P4(cron)/ P5(project)/ P6(template+seed)** 互相独立,关键路径推进到 P2 后可穿插。
- **P8(UI 收尾)** 依赖 P1/P2;**P9(清理)** 最后。

## 阶段索引

| 阶段 | 文件 | 范围 | 路径 |
|---|---|---|---|
| P0 | [plan-P0.md](./plan-P0.md) | 数据模型 & schema(地基) | ✅ 关键 |
| P1 | [plan-P1.md](./plan-P1.md) | wiki 存储分离 + 多锚点 | ✅ 关键 |
| P2 | [plan-P2.md](./plan-P2.md) | agent 运行时(废 agent-as-tool/subagents/memory 合并) | ✅ 关键 |
| P3 | [plan-P3.md](./plan-P3.md) | 工具重组(4 action + verify) | ✅ 关键 |
| P4 | [plan-P4.md](./plan-P4.md) | cron 重写 + 调度台 | 并行 |
| P5 | [plan-P5.md](./plan-P5.md) | project 模块 + 项目页 | 并行 |
| P6 | [plan-P6.md](./plan-P6.md) | template 改名 + prompt + seed | 并行 |
| P7 | [plan-P7.md](./plan-P7.md) | 流程重做(拉模型,闭环) | ✅ 关键(终点) |
| P8 | [plan-P8.md](./plan-P8.md) | UI 收尾(wiki 浏览器 / agent 配置) | 依赖 P1/P2 |
| P9 | [plan-P9.md](./plan-P9.md) | 清理 dead path + 债务 | 最后 |

## 全局完成定义(每阶段都要)
- `npm run build:lib`(tsc)通过。
- sub2 写的该阶段测试绿 + 已有测试不退化。
- schema 变更:旧 DB migration 跑通(契约 1.2)。
- 该阶段规范引用的「落地待办」对应项可勾。
