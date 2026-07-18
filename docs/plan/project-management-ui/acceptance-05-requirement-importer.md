# Acceptance 05：旧 Requirement Importer 与 Legacy 边界

对应 [Plan 05](plan-05-requirement-importer.md)。

- [ ] preview 列出状态、文档、冲突、目标 id/version 和来源 hash。
- [ ] unknown state/definition mismatch 不被静默猜测。
- [ ] execute 幂等，中断恢复不产生重复 FlowInstance。
- [ ] import 后正文/hash/count/provenance 与 preview 一致。
- [ ] 旧 Requirement 表、状态、文档和 UI 数据源不被修改。
- [ ] importer 不自动运行，新旧系统无双写。
- [ ] Legacy 入口和 import 后目标 Flow deep link 位于统一 Project navigation。

## 布局与容量

- [ ] Importer 是完整 route，Select/Map/Preview/Execute/Verify step 和 import identity 可恢复。
- [ ] 宽屏 Select/Map 为 42/58，`1024 × 768` 为 45/55，`900 × 600` 为 Source/Mapping tab。
- [ ] sticky footer 始终显示 selected/conflict 与 Back/Next/Execute，长列表不把操作推离视口。
- [ ] 1,000 Requirement 使用 pagination/virtualization；select-all 作用域与真实 count 明确。
- [ ] Preview unresolved conflict 排前且可筛选，完整 document/provenance 在 480/420px drawer。
- [ ] Execute/Verify 显示 aggregate 与逐项结果，preview/actual count/hash mismatch 占固定区域。
- [ ] compact Preview 保留 source→target/result，其他字段可从 drawer 完整读取。
- [ ] 三档视口与 0/1/100/1,000 source、20×20 state、长 title/id、conflict/interrupted/
  mismatch 有视觉证据。
