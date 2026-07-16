# docs/plan — 实施拆分 + 验收(进行中)

放**正在执行**的 effort 的 `plan-*.md`(实施路线)+ 对应 `acceptance-*.md`(验收标准),一一对应。每个主题一个子目录。

> **当前进行中:** [`wiki-system-redesign/`](wiki-system-redesign/)——统一 SQLite Wiki、Agent grants/context、Project Git 语义镜像、工具与 UI 重构。
> 已完成的实施计划归档到 [`../archive/`](../archive/)(随各 effort 的 spec 一起)。

## 执行约定

- 每个 sub 既有 `plan-<id>.md` 也有对应 `acceptance-<id>.md`。
- 执行前先建新 git branch;按 sub 实施 → 对应 acceptance 验收;通过 → 下一个,不通过 → 回该 sub 修改。
- 合并 master 需用户同意;合并后整组(spec + plan + acceptance)移到 [`../archive/<topic>/`](../archive/)。

完整生命周期见 [`../issues/README.md`](../issues/README.md)。
