# Issues & 工作流生命周期

一个 **effort = 一个文件夹 `<name>/`**,在四个目录间**流转**:任意时刻只在一个目录里,**位置即阶段**(无需状态字段)。文件夹随阶段推进整体 `mv`,内部文件累积。

```
docs/issues/<name>/   ① 问题记录        (issue.md)
       ↓ mv 整个文件夹
docs/design/<name>/   ② 讨论细化        (+ design.md)
       ↓ mv
docs/plan/<name>/     ③ 拆分实施 + 验收 (+ sub-N.md + acceptance-N.md,一一对应)
       ↓ git checkout -b <name>,逐 sub 实施 + 验收(不通过回该 sub,不跳过)
       ↓ 全部通过 + 用户同意 → 合并 master
       ↓ mv
docs/archive/<name>/  ④ 归档(完整记录)
```

因为文件夹整体流转,**effort 内部文件互链永远是 `./`**,phase 切换不会断链;只有跨 effort / 指向 `docs/arch/` 的链接要小心。

> 本流程已固化成用户级 skill `/effort`(new / design / plan / next / status / archive),跨项目可用。

## 目录 = 阶段

| 目录 | 阶段 | 文件夹内含 |
|------|------|-----------|
| `docs/issues/` | ① 问题 | issue.md |
| `docs/design/` | ② 设计 | + design.md |
| `docs/plan/` | ③ 实施计划 | + sub-N.md / acceptance-N.md |
| `docs/archive/` | ④ 已合并归档 | 完整记录 |

## 执行规则

1. **一个 effort 一个文件夹,只在其中一个目录里**。不跨目录分散它的文件。
2. 每个 sub 既有**实施文件**也有**对应验收文件**(一一对应)。
3. 执行前**先建新 git branch**(`<name>`)。
4. 验收不通过 → 回该 sub 修改,不跳过。
5. 合并 master 需**用户同意**。
6. **任何文件移动后跑 `npm run check:links`**(`scripts/check-doc-links.cjs`,断链非零退出)。

## 实战经验(pilot 摩擦 → 规则)

2026-07 两个 effort 跑完整周期后总结:

1. **plan 文件是唯一真相源**。引用计划的内容(定时 prompt、commit 说明、对话)**只指 plan 路径,不复述内容**——内联摘要会在 plan 改动时过时(pilot 中 cron 触发时 sub-2 描述是改前旧版,靠"按 plan 文件"才没出错)。
2. **归档/迁移后跑 check:links**。文件夹整体流转时内部链接保持 `./`;但跨 effort / 指向 arch 的链接可能断,脚本兜底。
3. **issue 与 design spec 同名时**,issue 改名 `issue.md` 避冲突。

## 生命周期之外的文档目录

长期参考文档,不参与 effort 生命周期:

- `docs/arch/` — code-as-truth 架构文档(当前架构唯一活参考)
- `docs/basic/` — 项目入门
- `docs/visualization/` — 可视化图表
- `docs/.docloop/` — 文档循环追踪(独立 effort)

## 历史说明

2026-07 之前的 effort(tool-rename-consistency、task-view-simplification 等)用的是"文件分散在 issues/design/plan 三处、合并后收集到 archive"的旧模型;现归档于 `docs/archive/`(end-state 与流转模型一致)。新 effort 一律用上面的**流转模型**。
