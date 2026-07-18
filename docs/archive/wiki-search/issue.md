# Issue: wiki-search

- **状态**:❌ **废止**(2026-07-16,已归档——不再推进)
- **提出**:2026-07-16
- **类型**:功能完善(search)+ 数据模型清理(path/title)
- **来源**:2026-07-16 "Wiki search 没完善" 讨论

> ⚠️ **废止(2026-07-16)**:本 effort 不再推进。
> **原因**:设计中定的「folder-per-node」统一节点模型(`<node>/.wiki/{node.json,summary.md,content.md,links.json}`)会让 wiki 节点数 × 每节点多文件持续膨胀,对 Windows 文件管理(资源管理器 / FS / 备份)造成不可接受的小文件负担——模型本身在本机环境不成立。
> **处置**:整个 wiki 子系统 redesign 取消;现有 wiki(`wiki-tool` / `wiki-node-store` / `project_wiki` DB / 磁盘镜像树)保持现状不动,不迁不改。本目录归档保留设计记录与取消理由,供日后参考。

## 问题

Wiki search 既**功能不全**又**寻址模型不干净**,两件事缠在一起:

1. **search 不搜正文**:目前只匹配 title / summary / path 三个元数据字段([wiki-tool.ts:660](../../../src/tools/wiki-tool.ts)),节点正文(doc body)不在检索范围——某词只出现在正文深处就搜不到。正文存在(`docRead` 能读,`readNodeDetail` `wiki-node-store.ts:807`),只是没纳入 search。
2. **path/title 模型脏**:存的 `path` 字段构造不一致——有 slug(`workflow/software-dev`)、有塞 UUID(`project:d0842d2e-...`)、有 type 前缀(`intent:`/`header:`/`memory:`);title 也有 "software-dev 工作流" 这种带多余后缀的。语义上 path 应该就是 `title1/title2/title3`(标题链),现在却是机器 slug + id + 前缀的混合,跟 title 重复又不一致。

合起来:agent 想按 title 链干净地寻址/搜索节点,被脏 path 和缺正文搜索挡住。

## 现状 / 真相源 / 影响面

### search 现状
- 匹配:title / summary / path(内存,substring 或 regex,大小写不敏感)
- 范围:`subtree` 参数(nodeId / short-id)收窄到子树,**已含根节点**(`collectSubtree` [wiki-tool.ts:117](../../../src/tools/wiki-tool.ts))
- 寻址:`walkTitlePath` [wiki-tool.ts:286](../../../src/tools/wiki-tool.ts) 逐段匹配 `n.title`(expand/docRead 的 `path` 参数在用);`resolveNodeIdArg` 只收 nodeId/short-id,**没接 title-path**
- 输出:每节点一行 `#id | type | title size\n   summary`,**不标命中字段、不排序**

### path/title 脏值的来源(已定位)

| 脏值 | 来源 | 性质 |
|---|---|---|
| `project:<uuid>` | `projectSubtreeRootPath` `wiki-node-store.ts:121` `return \`project:${projectId}\`` | 代码 |
| `intent:` / `header:` / `memory:` 前缀 | `synthesizePath` | 代码(给 type 分类用) |
| slug(`workflow/software-dev`) | `sanitizeSeg` / `nodeSlug`(本只该用于磁盘文件名) | 代码 |
| "software-dev 工作流" 等 title | 无 seed,运行时起的节点名 | 数据 |

### 关键耦合(决定改法)

- **type 派生靠 path 前缀**:`deriveTypeFromPosition` `wiki-node-store.ts:1913` 用 `path.startsWith("intent:"/"header:"/"memory")` 分类——但是**多路分层回退**(id 前缀 `wiki-root:` → project、path 前缀、nodeType、projectId),path 前缀**大部分冗余**;唯 **memory 类型强依赖 `path.startsWith("memory")`**,删前缀要给它换信号(看 parent 是否 memory root)。
- **磁盘文件名 title-based**(`nodeSlug(title)+id8`),**不依赖存的 path** → 改 path 字段不动磁盘文件,风险低。
- **title-path 寻址已能用**:`walkTitlePath` 逐段匹配 `n.title`(不是匹配 path 字段)→ 即使 path 还脏,title-path 寻址照样工作 → **search 改进不依赖 path 清理**。

### 影响面(若推进)

[wiki-tool.ts](../../../src/tools/wiki-tool.ts)(search 重写 + 寻址统一)、`wiki-node-store.ts`(`projectSubtreeRootPath` / `synthesizePath` / `deriveTypeFromPosition` / slug)、可能涉及存量数据迁移(`~/.zero-core` 下 6687 个 wiki 文件)。

## 相关方向 / 待 design 决策

讨论中已收敛的若干点(供 design 落实,非定案):

- **search 行为(A)**:正文搜索 **always-on**(grep/rg,Windows 无则回退 JS 扫描)、**删 path 匹配**、`subtree` → 改名 `root`、所有节点参数统一收 nodeId 或 title-path(给 `resolveNodeIdArg` 加 `walkTitlePath` 回退)、输出**标命中字段 + 按字段排序 + 去重**
- **path 模型(B)**:path 统一为裸 title 链(不 slug / 不塞 id / 不加前缀)
- **design 待决**:① A 与 B 是否拆独立 sub;② **project path 用项目名(可变→改名要级联)还是 UUID(稳定但丑)**;③ 删 path 前缀后 type 怎么派生(memory 换信号);④ **存量数据迁移范围**(全清 vs 只改生成逻辑)

## 下一步

进 ② design 细化(`/effort design`)。**暂不实施。**
