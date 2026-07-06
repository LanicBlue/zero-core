# Issues & 工作流生命周期

所有 issue 统一放 `docs/issues/`。每个 issue 走以下生命周期:

```
docs/issues/        ① 问题记录(背景 + 现状 + 真相源/影响面)
       ↓
docs/design/        ② 讨论细化(方案选项 + 权衡 + 决策)
       ↓
docs/plan/          ③ 拆分实施(sub-impl-*.md + 对应 acceptance-*.md)
       ↓
git branch          ④ 执行:按 sub 实施 → 对应 acceptance 验收
                          通过 → 下一个;不通过 → 回该 sub 修改
       ↓
master              ⑤ 全部通过 + 用户同意 → 合并 master
       ↓
docs/archive/       ⑥ 归档(把 issues/design/plan 相关文件移入)
```

## 目录职责

| 目录 | 作用 | 何时进入 |
|------|------|----------|
| `docs/issues/` | 问题记录(不含方案细节) | 发现问题即建 |
| `docs/design/` | 方案讨论与细化 | 准备动手讨论时 |
| `docs/plan/` | 实施拆分 + 验收标准 | 需求明确后 |
| `docs/archive/` | 已合并 issue 的文件归档 | 合并 master 后 |

## 执行规则

1. 每个 sub 既有**实施文件**也有**对应验收文件**(一一对应)。
2. 执行前**先建新 git branch**。
3. 验收不通过 → 回到该 sub 的实施文件修改,不跳过。
4. 合并 master 需**用户同意**。
5. 合并后把该 issue 相关的 issues/design/plan 文件归档到 `docs/archive/`。

## 实战经验(pilot 摩擦 → 规则)

2026-07 两个 effort 跑完整周期后总结,后续照此避免重复踩坑:

1. **plan 文件是唯一真相源**。任何引用计划的内容(定时 prompt、commit 说明、对话)都**只指向 plan 文件路径,不内联复述计划内容**——内联摘要会在 plan 改动时过时(pilot 中 cron 触发时的 sub-2 描述就是改前的旧版,靠"按 docs/plan/.../plan.md"以文件为准才没出错)。
2. **任何文件移动后跑 `npm run check:links`**。docs 重构/归档/改名后,相对链接会断(plan/spec/acceptance 移成同级目录后,跨文件链接要 collapse 回 `./`)。脚本 `scripts/check-doc-links.cjs` 检查所有相对 .md 链接可达,断链非零退出。
3. **归档时同 effort 文件归同目录**。issue/design/plan 移进 `archive/<topic>/` 后彼此成兄弟,跨文件链接统一改 `./`(不要保留 `../../design/...` 这种旧路径)。issue 与 design spec 同名时,issue 改名 `issue.md` 避冲突。
4. **issue 状态行跨阶段手动同步**(①issue→②design→③plan→④执行→合并)。当前手动;skill 化后由命令自动维护。

## 生命周期之外的文档目录

以下目录是**长期参考文档**,不参与 issue 生命周期,不要往里塞 issue/design/plan:

- `docs/arch/` — code-as-truth 架构文档(按代码反向推导,长期维护)
- `docs/basic/` — 项目入门(prd / tech-stack / 结构 / 规范)
- `docs/visualization/` — 可视化图表(架构图 / 数据流 / code-graph)
- `docs/.docloop/` — 文档循环追踪(独立 effort)
