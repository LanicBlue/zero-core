# 任务

- [x] T001.01 评审生成的 spec 覆盖
  - type: governance
  - done: 生成的 consumer-requirements spec 符合 PRD 意图
  - verify: openprd change . --validate --change zero-core

- [x] T001.02 补齐领域服务、数据读取与状态同步
  - type: implementation
  - deps: T001.01
  - done: 领域服务、数据读取和状态同步已经接通，界面不会停留在假可见状态。 涉及: 使用现有 SQLite 数据库 / session-db 数据库访问。
  - verify: openprd run . --verify

- [x] T001.03 实现FR1: 系统记录每次工具执行（工具名、参数、结果/错误、执行时间、关联的 session/turn）
  - type: implementation
  - deps: T001.02
  - done: 已完成：FR1: 系统记录每次工具执行（工具名、参数、结果/错误、执行时间、关联的 session/turn）
  - verify: openprd run . --verify

- [x] T001.04 实现FR2: 前端展示工具错误统计（总调用数、错误数、错误率）
  - type: implementation
  - deps: T001.03
  - done: 已完成：FR2: 前端展示工具错误统计（总调用数、错误数、错误率）
  - verify: openprd run . --verify

- [ ] T001.05 实现FR3: 用户可选择工具进行分析
  - type: implementation
  - deps: T001.04
  - done: 已完成：FR3: 用户可选择工具进行分析
  - verify: openprd run . --verify

- [ ] T001.06 实现FR4: AI 基于错误上下文生成分析报告
  - type: implementation
  - deps: T001.05
  - done: 已完成：FR4: AI 基于错误上下文生成分析报告
  - verify: openprd run . --verify

- [ ] T001.07 实现FR5: 提供数据清理功能
  - type: implementation
  - deps: T001.06
  - done: 已完成：FR5: 提供数据清理功能
  - verify: openprd run . --verify

- [ ] T001.08 打通主流程闭环：工具执行错误时开发者查看统计标签页分析原因并优化代码
  - type: implementation
  - deps: T001.07
  - done: 主流程关键节点已经打通，用户可以按预期从入口走到结果收尾。涉及: 工具执行错误时开发者查看统计标签页分析原因并优化代码。
  - verify: openprd run . --verify

- [ ] T001.09 验证数据库正确记录工具执行详情
  - type: verification
  - deps: T001.08
  - done: 已验证：数据库正确记录工具执行详情
  - verify: openprd run . --verify

- [ ] T001.10 验证前端正确展示错误统计
  - type: verification
  - deps: T001.09
  - done: 已验证：前端正确展示错误统计
  - verify: openprd run . --verify

- [ ] T001.11 验证AI 分析建议质量合格（给出具体原因和改进方向）
  - type: verification
  - deps: T001.10
  - done: 已验证：AI 分析建议质量合格（给出具体原因和改进方向）
  - verify: openprd run . --verify

- [ ] T001.12 回归非功能约束：记录不影响工具执行性能异步写入 / 分析响应时间小于10秒
  - type: verification
  - deps: T001.11
  - done: 非功能约束已经回归确认。涉及: 记录不影响工具执行性能异步写入 / 分析响应时间小于10秒。
  - verify: openprd run . --verify

- [ ] T001.13 回归边界条件与失败处理：边界情况：工具无错误记录时提示暂无数据 / 边界情况：错误记录少于 5 条时提示数据不足，建议积累更多数据 等 6 项
  - type: verification
  - deps: T001.12
  - done: 边界条件与失败处理已经回归确认。涉及: 边界情况：工具无错误记录时提示暂无数据 / 边界情况：错误记录少于 5 条时提示数据不足，建议积累更多数据 等 6 项。
  - verify: openprd run . --verify

- [ ] T001.14 验证成本与额度护栏
  - type: verification
  - deps: T001.13
  - done: 已验证免费、试用或低权限用户不能绕过额度、并发、频率或总量限制
  - verify: openprd run . --verify

- [ ] T001.15 验证滥用与越权路径
  - type: verification
  - deps: T001.14
  - done: 已覆盖重复请求、并发请求、越权身份和异常恢复等负向场景
  - verify: openprd run . --verify

- [ ] T001.16 验证成本监控、报警和止损
  - type: verification
  - deps: T001.15
  - done: 已确认用量或成本信号、报警阈值和人工/自动止损动作可执行
  - verify: openprd run . --verify

- [ ] T001.17 维护 docs/basic 项目基础文档
  - type: documentation
  - deps: T001.16
  - done: 已检查 docs/basic 是否缺失或因本次需求、流程、结构、依赖、产品行为变化而过期；若涉及后端、脚本、Agent 或工具链变更，已同步评估 CLI 与 API 接入面，并在 backend-structure.md 中记录事实或不适用原因；需要更新的基础文档已同步
  - verify: openprd standards . --verify

- [ ] T001.18 更新文件说明书和文件夹 README
  - type: documentation
  - deps: T001.17
  - done: 本次变更涉及的文件说明书和文件夹 README 已检查；缺失的已补齐，过期的已更新
  - verify: openprd standards . --verify

- [ ] T001.19 运行 OpenPrd spec 校验
  - type: governance
  - deps: T001.18
  - done: 生成的 change 通过 OpenPrd 校验
  - verify: openprd change . --validate --change zero-core
