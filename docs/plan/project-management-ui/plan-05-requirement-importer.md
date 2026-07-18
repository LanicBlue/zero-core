# Plan 05：旧 Requirement Importer 与 Legacy 边界

## 目标

提供显式、无损、幂等的旧 Requirement 导入；不删除旧系统，不建立双写。

## 依赖

Acceptance 00–03 通过；本阶段不依赖 Work/WorkRun UI。

## 实施范围

```text
select Project/Requirement(s)
→ choose target FlowDefinition
→ preview state/document/id mapping
→ validate conflicts
→ execute
→ verify hash/count/provenance
```

- 默认模板可建议同名状态，但未知状态必须要求明确映射；
- preview 列出目标 id、definition version、文档 hash、冲突和 provenance；
- execute 使用 idempotency key，中断恢复不重复创建；
- import 复制内容，不改旧 Requirement 状态、表或文档；
- legacy 页面/API 保持明确命名；何时只读/删除由后续用户决定。

## 布局方案

Importer 是 Flows 下的完整 route，不是 modal。页面保留 selected Project identity，并使用
`Select → Map → Preview → Execute → Verify` stepper；step、selection 和 preview revision
可恢复。

### Select / Map

```text
┌ Stepper / import id / saved progress ────────────────────────────────────────┐
├ Legacy Requirements 42% ───────────┬ Target Definition + mapping 58% ───────┤
│ search/filter/select all visible   │ definition/version                     │
│ virtualized rows                   │ state mapping table                    │
│ title/status/doc count             │ document/id/provenance policy          │
└────────────────────────────────────┴─────────────────────────────────────────┘
┌ sticky footer：selected N / conflicts N              Back · Validate/Preview ┐
```

- source list row 48px，100/1,000 Requirement 使用 server pagination/virtualization；
- “select all”只作用于当前明确 query，并显示真实 selected count，不把未加载项静默选中；
- state mapping row 44px，unknown/missing target 固定占位并阻止 Preview；
- target definition/version sticky 摘要始终可见，切换目标必须使旧 preview stale。

### Preview

- 顶部 summary 显示 create/skip/conflict/error/hash totals；
- full-width table 列：source 220、source state 120、target state 120、target id 180、
  documents 120、hash/provenance flex、result 120；
- conflict/error 固定在前，可筛选；document diff 和完整 provenance 在宽屏 480px/标准
  420px drawer；
- 1,000 row 不全量挂 DOM；preview revision/idempotency key 在 header 和 sticky footer 可见；
- Execute 是显式主操作，存在 unresolved conflict 时禁用并给出可定位原因。

### Execute / Verify

- execute 页面显示 aggregate progress、当前 batch 和 result table，不因切 section 取消任务；
- completed/skipped/conflict/failed 可筛选，单项 deep link 到新 Flow 或旧 Requirement；
- Verify 固定展示 preview count/hash 与实际 count/hash 对比，差异不能只出现在 toast/log；
- 重试失败 batch 保持同一 import/idempotency identity。

### Standard/compact

- `1024 × 768` Select/Map 仍双栏但比例 45/55；
- `900 × 600` 使用 Source/Mapping tab，sticky footer 保留 selected/conflict/next；
- Preview/Verify compact row 只显示 source→target/result，其他字段进 drawer；
- stepper 可横向压缩 label，但当前 step、Back、Next/Execute 不得隐藏。

### 容量与视觉证据

三档视口覆盖 0/1/100/1,000 Requirement、1/20 source state、1/20 target state、60 字符标题、
200 字符 target id、无冲突/部分冲突/全冲突、执行中断与 hash mismatch。保存 Select、Map、
Preview、conflict drawer、Execute 和 Verify 的视觉证据。

## 完成定义

[Acceptance 05](acceptance-05-requirement-importer.md) 通过并生成 `result-05.md`。
