# design/archive — 已完成 / 已退役的设计文档

本目录存放**已完成落地**或**已被取代**的设计文档,保留作历史记录,不再作为当前依据。

当前架构以 [`docs/arch/`](../../arch/) 为准。

## 内容

### hook-redesign/(hook 生命周期重做的执行记录)

per-loop registry + step 中心 + 去 turn 表的那次重做,已全部合并到 master。

- `hook-redesign/README.md` — 编排索引(unit 顺序 + sub1/sub2 执行模型)
- `hook-redesign/steps/<unit>/impl.md` + `accept.md` — 每个 green-unit 的实现/验收 spec(1A–5B)
- `hook-redesign-steps.md` — 旧的分步索引(拆细前的入口,已指向 README)

**权威 spec 留在 design 根**:[`../hook-step-redesign.md`](../hook-step-redesign.md)(背景、命名映射、step 级恢复设计),arch 文档(03/05/09)引用的就是它。

> 这些是执行期的拆分文档,工作完成后归档。要理解当前的 hook 系统请读 `../hook-step-redesign.md` + `docs/arch/03-runtime-engine.md`,不要回这里翻步骤。
