# Issues 与 effort 生命周期

`docs/issues/` 记录已经确认、但尚未进入设计/实施的问题。目录位置表示阶段，不表示功能已经实现。

```text
docs/issues/<name>/   问题与证据
        ↓ 整体移动
docs/design/<name>/   设计与决策
        ↓ 整体移动
docs/plan/<name>/     实施步骤与 acceptance
        ↓ 实施、验收、用户同意
docs/archive/<name>/  历史记录
```

## 当前问题

- [`agent-eval-harness/`](agent-eval-harness/issue.md)
- [`archive-observability/`](archive-observability/issue.md)
- [`doc-artifacts-as-files/`](doc-artifacts-as-files/issue.md)
- [`memory-maintenance/`](memory-maintenance/issue.md)
- [`prompt-cache-control/`](prompt-cache-control/issue.md)
- [`skill-script-sandbox/`](skill-script-sandbox/issue.md)

这些文档中的方案、行业材料和“下一步”都是提案。判断现状请回到 [`../basic/`](../basic/README.md)、[`../arch/`](../arch/README.md) 和源码/测试。

## 执行规则

1. 一个 effort 使用一个目录，移动阶段时整体移动，保持内部相对链接稳定。
2. issue 先写可复现现象、当前代码证据、影响和明确非目标；不要提前把偏好写成已决定方案。
3. design 记录关键选择、替代方案、迁移和失败语义。
4. plan 的每个阶段必须有对应 acceptance；验收失败不能跳到下一阶段。
5. 合并或归档需要用户同意。
6. 移动或修改文档后运行 `npm run check:links`，再检查目录、源码和 anchor 链接。

## 兼容历史

早期 effort 没有严格遵守“一个目录整体流转”，归档中会出现不同命名和分散记录。不要为了统一格式改写历史验收；在 [`../archive/README.md`](../archive/README.md) 维持清晰边界即可。
