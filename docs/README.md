# zero-core 文档入口

项目文档按“当前事实、未来工作、历史记录”分层。阅读前先确认文档所在目录，避免把计划当作已经实现。

| 目录 | 性质 | 是否描述当前行为 |
| --- | --- | --- |
| [`basic/`](basic/README.md) | 入门与当前事实基线 | 是 |
| [`arch/`](arch/README.md) | 深入架构、技术债和质量边界 | 是；仍以代码/测试为准 |
| [`ops/`](ops/self-update-runbook.md) | 运维操作说明 | 是；使用前核对脚本版本 |
| [`issues/`](issues/README.md) | 已记录、尚未实施的问题 | 否 |
| [`design/`](design/README.md) | 正在讨论的设计 | 否 |
| [`plan/`](plan/README.md) | 已通过设计评审、等待或正在实施的计划 | 否，除非验收和代码都证明已落地 |
| [`archive/`](archive/README.md) | 已完成或终止 effort 的历史材料 | 否 |
| [`visualization/`](visualization/README.md) | 手工或生成式交互快照 | 不保证；看每项状态 |

根目录 [`README.md`](../README.md) 提供安装、命令和运行入口。

## 判断文档是否可信

1. 先看文档状态和核对日期。
2. 沿生产入口确认模块是否实例化和调用。
3. 用测试确认行为，而不是只相信源码注释。
4. 计划、验收清单和 archive 只能解释意图/历史，不能证明当前代码已经实现。
5. 遇到冲突时，把差异记录到当前架构文档或 issue，不要静默选择较顺眼的一份。

## 文档验证

```bash
npm run check:links
```

该命令只检查 `docs/` 内相对 `.md` 文件链接。它不会验证目录链接、Markdown anchor、源码链接、外部网址或 HTML/SVG 内容，因此完整审计还需要额外检查。
