# Step 5B · code-graph 重生成 + 总验证(impl)

> sub1 只读本文档。前置:5A 完成。收尾步。

## 背景
code-graph 必须反映最终代码结构;跑一遍总验证确保全绿。

## 目标
1. `npm run build:codegraph` 重生成 `docs/visualization/code-graph.html` + `code-graph-data.json`(不手改,[[feedback-pre-commit-docs]])。
2. 总验证(见 accept)全绿。
3. 最终 commit(Phase 5)。

## 要改的文件
- `docs/visualization/code-graph.html`、`code-graph-data.json`(脚本生成)

## 边界
- ❌ 不手改 code-graph 文件。
- ❌ 不改代码(若总验证发现红,回对应 phase 的 sub1 修,不在本步改)。

## 自检
- build:codegraph 无报错。
- 总验证(accept A1-A4)全绿。
