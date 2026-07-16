# Design: wiki-search(wiki 存储模型重设计)

> ⚠️ **废止(2026-07-16)**:本设计不再推进。folder-per-node 统一节点模型在 Windows 上会造成不可接受的小文件负担,模型不成立。详见 [issue.md](./issue.md) 顶部废止说明。现有 wiki 子系统保持现状不动。

- **状态**:❌ **废止**(已归档)
- **来源**:[issue.md](./issue.md) + 2026-07-16 讨论;落地 [doc-artifacts-as-files](../../issues/doc-artifacts-as-files/issue.md) 的 wiki 半边
- **蓝本**:用户 2026-07-16 提供的参考架构《面向 AI Agent 的统一 Wiki 架构》(`agent-wiki-architecture.md`,仓库外)——本设计以其为蓝本,按 zero-core 现实裁剪

## 概述

把 wiki 从「DB 索引 + 磁盘正文(半迁移)」重设计为**面向 agent 的语义文件系统**(参考架构 §16 核心论点),并按 zero-core 单用户本地应用的现实裁剪:

- 统一根(`~/.zero-core/wiki/`)+ 三命名空间 `knowledge` / `memory` / `projects`(磁盘已存在)
- **统一最小节点结构**:每个节点 = `<title>/.wiki/{node.json, summary.md, content.md, links.json}`
- **路径即身份(无稳定 id)**;路径 = title 链(不存独立 slug → 消解脏 path)
- 树导航 + 图关联(links.json 双向 + 路径引用,工具维护)
- 数据面 6 工具(expand/read/search/create/update/delete)与「管理面」(地址/scope/注入)分离
- **去 DB(wiki)**:文件即真源 + 启动内存视图(参照 skills)
- 地址翻译层:工具访问先指 wiki-root,经 `addresses.json` 解析到真实路径再读写,返回值用路径映射包装

## 参考架构:采纳的原则

1. **统一节点结构**:每个节点同构(folder + `.wiki/` 元数据 + 正文);不再「目录节点 vs 文件 sidecar」。节点可**同时**有正文和子节点。
2. **文件化存储 + 节点化访问 + 树导航 + 图关联**。
3. **路径即身份**:无稳定 id;路径 = title 链。rename/move 靠工具按 links.json 双向改写对端(见 D2.2)。
4. **路径 = title 链 = 文件系统位置**:不存独立 slug/前缀字段 → 直接修掉用户投诉的脏 path(`project:d0842d2e-...` / `software-dev 工作流` slug)。
5. **links.json 双向 + 路径引用**:出向 + 入向(backlink)都存,工具维护;`in` 列表即反向索引,读反链/改链/删链都是 O(该节点链数)。
6. **数据面/管理面分离**(参考 §10):agent 只用 expand/read/search/create/update/delete;地址注册/scope/注入策略属管理面。
7. **search**:逻辑 scope only(不许物理路径扩范围),返回命中字段+片段+原因,**检索前过滤**(参考 §9.3/§11)。
8. **默认软删除**(参考 §9.6,暂缓):有子节点/反向链接时禁硬删,返回影响范围 —— 当前实现先硬删(移 folder),需要归档再加 `status`。
9. **乐观并发**(参考 §9.5,暂缓):单用户 last-write-wins;多 agent 写撞了再加 `revision`。
10. **派生数据可重建**:索引/反链缓存都能从节点重建(参考 §14)。

## 与参考架构的差异(zero-core 裁剪)

| 参考架构 | zero-core 取舍 | 理由 |
|---|---|---|
| project wiki = repo 语义镜像(§6-7) | ✅ 采纳(**磁盘已验证**) | `projects/<pid>/` **已镜像 repo 相对路径**(实测:`apps/desktop/electron.vite.config.ts__*.md`、`eslint.config.mjs__*.md`、每个 script 都有节点)+ 混入 agent 注解节点(如「实验记忆 — Wiki vs Basic Tools 对照」)。= 镜像 + 注解 hybrid,正是参考 §7 模型 |
| repositories.json 绑定 + sync/stale 工作流(§6.1/§13) | ✅ 已有(实装) | `wiki-skeleton-service` 扫 repo 建 header/intent/structure 节点 + `WikiScanCursorStore`(lastScannedRef)git 增量 + `rescanProjectFull` 兜底 + 只跟 main 分支。= 参考的 repo 绑定+sync 已落地;迁文件模型时改它写 `.wiki/` 而非 DB(见 D8) |
| 完整管理面(address registry / prompt publisher / 版本发布 / admin 工具,§10) | ⚠️ 轻量化 | 单用户本地应用;「地址」=虚拟前缀+scope,「注入」= `sendProjectPrompt` contextBundle。不做版本化 prompt bundle 发布。但 `addresses.json` 路径映射 **采纳** |
| 完整 ACL(subject×op×node×session,deny wins,§11) | ⚠️ 简化 | 单用户;「权限」即 **scope 可见性**(per-session visible root);检索前过滤仍保留 |
| `memory/<agent-id>` 多 agent 隔离(§2.2) | ⚠️ 待定 | zero-core 有子代理,但是否 per-agent memory 隔离未定(现 memory 偏全局/项目级) |
| 稳定 ID ≠ 路径(§5) | ❌ 不采纳 | 用户定:**路径即身份**,无 id。links/addresses 全用路径;rename 靠工具按 `in`/`out` 改写对端(rename 稀有,可接受) |
| node.json 含 id/kind/status/revision/source/memory/permissions(§4.1) | ⚠️ 砍到最小 | 用户定 YAGNI:node.json 只留 `created_at`+`updated_at`(+可选 `schema_version`)。type 位置派生,其余需要再加 |
| links 出向 + backlink 全局派生(§4.4/§14) | ⚠️ 改为双向路径存储 | 用户定:links.json 双向 + 路径引用,工具维护;`in` 即反向索引,无需全局反链索引 |
| `.wiki/{node.json,summary.md,content.md,links.json}` 4 文件/节点(§4) | ✅ 采纳 | 用户定:统一最小节点结构,所有节点同构 4 文件(见 D2) |
| git commit 同步工作流(§13) | ❌ 不做 | wiki 在 `~/.zero-core`,非 git repo;无 repo 绑定则无 sync 语义 |

## 决策

### D1 总体模型 = 语义文件系统(参考蓝本 + zero-core 裁剪)
见「概述」+「差异表」。核心:统一节点 + 路径即身份 + 路径即 title 链 + 数据/管理面分离 + 去 DB。

### D2 节点布局 = 统一最小节点结构(4 文件 `.wiki/`,参考 §4)
所有节点(含根)同构:
```
<node>/                         # folder 名 = title = path 段
└── .wiki/
    ├── node.json               # 节点属性(见 D2.1;最小:created_at+updated_at)
    ├── summary.md              # 短摘要;create 时必填;供注入/expand/搜索结果
    ├── content.md              # 详细正文;有但可空
    └── links.json              # 双向链接(out + in)+ 路径引用;工具维护,不手改
```
- **路径 = title 链 = 文件系统位置**(folder 名即 title;不存独立 slug → 消解脏 path)。
- summary.md / content.md 分离:summary 必填(注入/搜索用),content 按需(可空)。search 命中 summary.md + content.md(node.json 元数据不进正文搜索)。
- 根节点特例:`wiki-root/.wiki/` 除 node.json 外,再加 `addresses.json`(见 D5)。

### D2.1 node.json schema = 最小(用户定:YAGNI,需要再加)
```json
{
  "schema_version": 1,                      // 文件格式版本(建议留做迁移版本号;可删)
  "created_at": "2026-07-16T11:00:00+08:00",
  "updated_at": "2026-07-16T11:00:00+08:00"
}
```
- **只留 created_at + updated_at**(schema_version 建议 1 行,可删)。其余全部**派生或暂不加,需要时再扩**:
  - 身份/位置:`id`→路径;`title`→folder 名;`path`/`parent_id`→FS 派生。
  - 类型:`kind`/`namespace`→**位置派生**(在 `memory/`/`knowledge/`/`projects/` 下即对应类型)。= gate ④ 定。
  - 生命周期:`status`(软删暂缓,删即移 folder,要归档再加);`revision`(乐观锁暂缓,单用户 last-write-wins)。
  - 来源:`provenance`/`source`(repo 镜像路径即节点自身路径,冗余;content_hash 待 Q6 定再加)。
  - memory 治理:`memory_type`/`durability`/`confidence`/`owner_agent`(暂不加)。
  - `flags`、flow 的 `requirement_ids`(→ 需要时归 links.json relation)。
- **迁出(去冗余)**:summary → summary.md;relations → links.json;doc_pointer → 废(content.md 即正文)。

### D2.2 links.json schema = 双向 + 路径引用(用户定:不要 id)
```json
{
  "out": [ { "target": "projects/multica/tests/runtime/test_executor.py", "relation": "tested_by" } ],
  "in":  [ { "source": "projects/multica/apps/desktop/executor.py",       "relation": "used_by" } ]
}
```
- `target`/`source` = **路径**(相对 wiki-root 的规范地址),不用 id。
- **工具维护双向**(不手改):
  - 加链 A→B:写 A.`out`{target:B},同时写 B.`in`{source:A}。
  - 删节点 X:遍历 X.`out`/X.`in`,到对端各自删对应条目,再删 X。
  - **改/删引用是 O(X 的链数)直接操作** —— `in` 列表本身就是「谁指向我」的反向索引,无需全库扫描。
- **rename X 代价**:按 X.`in`(指向我的)改各 source 的 `out`、按 X.`out` 改各 target 的 `in` 里 X 旧路径→新路径;多写几个文件,但 `in`/`out` 精确告知改哪。用户接受(rename 稀有)。

### D3 身份 = 路径即身份(无稳定 id)✅ 用户定
- 节点身份 = 它在 wiki-root 下的路径(folder 名链)。**不上稳定 id**。
- links.json 用**路径**引用(D2.2);addresses 的 alias 用 `target_path`(D5)。全库无 id 概念。
- rename/move 靠工具按 links.json `in`/`out` 精确改写对端(见 D2.2);比稳定 id 多一点写,换无 id 索引、单一身份概念。
- 现表 `id`/`source_req_id` 等:迁移时废弃(身份转路径)。

### D4 命名空间 = knowledge / memory / projects(参考 §2,直接映射 zero-core 现状)
```
~/.zero-core/wiki/              # = wiki-root(磁盘已存在 3 目录)
├── knowledge/                  # ↔ 现 knowledge/(跨项目共享知识;读多写少)—— 纯 agent 自撰,最小结构
├── memory/
│   └── <agent-id>/             # ✅ per-agent(现状已 per-agent:db-migration memoryArea 按 agentId 分目录)
│                               #    新建 agent 自动建、删 agent 自动删(hook:createAgent/deleteAgent)
└── projects/
    └── <project-name>/         # ✅ 用人类名 projectName(现 ensureProjectSubtree 已有 projectName,只用于 title → 改用于 folder)
```
- knowledge/memory = **最小结构**(纯 agent 自撰节点,无镜像);projects **结构更丰富**(见 D8)。
- 修脏 path:`project:d0842d2e-...` → `projects/<project-name>/`;`software-dev 工作流` → folder 名即 title。
- **type 位置派生**:目录即类型(无 `kind` 字段);projects 内部 header/intent/structure 子类 → 见 D8。

### D5 地址 / scope = 地址翻译层(参考 §3/§10)
**根 `wiki-root/.wiki/addresses.json`** 管理路径映射:
```json
{
  "schema_version": 1,
  "addresses": [
    { "address": "memory://",  "resolver": "current_agent_memory_root", "scope": "session",        "kind": "dynamic" },
    { "address": "project://", "resolver": "current_project_root",      "scope": "session",        "kind": "dynamic" },
    { "address": "runtime://", "target_path": "projects/multica/src/runtime", "scope": "project:multica", "kind": "alias" }
  ]
}
```
**解析流(工具访问任意地址)**:
1. 地址(`memory://` / `project://` / `wiki://...` / 相对路径)→ 先到 wiki-root
2. 查 addresses.json:dynamic 用 resolver(current_agent_memory_root / current_project_root)按 session 解析;alias 查 `target_path`
3. 解析到 wiki-root 下真实物理路径 → 读写
4. **返回值用路径映射包装**:agent 看到 `project://src/...` 而非物理路径
- 动态地址(memory://、project://)= per-session 注入的可见根 = contextBundle scope(对齐不泄露不变式)。
- alias(runtime://)用 `target_path`;rename 目标时工具同步改(同 links 维护)。alias 暂可选(管理面,先不做也行)。
- search 的 `root` 参数 = 上述地址/路径(nodeId 或 title-path 合一,相对 agent 可见根)。

### D6 工具协议 = 数据面 6 个(参考 §9)
归并现 wiki-tool 的 expand/search/create/update/delete/createMemory/docRead/docWrite/docEdit → **expand / read / search / create / update / delete**(memory 语义由 namespace 表达,不单独 createMemory)。
- `create`:必填 summary(generate summary.md);content 可空;同时建 `.wiki/{node.json,summary.md,content.md,links.json}`。
- `read` 分层:summary / content / section(参考 §9.2)。
- `update`:字段/section patch(参考 §9.5);改 links 由工具经 link 操作触发(双写,见 D2.2)。
- `delete`:遍历 links 删对端条目(见 D2.2),再移 folder。
- `rename/move`:改 folder + 按 `in`/`out` 改写对端路径(D2.2)。
- `search`:grep `summary.md`+`content.md`(always-on)+ `root` + 命中字段标注(`[title]`/`[summary]`/`[body]`)+ 排序 + 去重 + 片段。
- 所有工具的地址入参/返回值过 D5 翻译层。

### D7 去 DB(wiki)
文件即真源 + 启动扫描建内存视图(参照 skills:纯文件、无 SQLite、registry 启动扫描)。type → 位置派生(不存);relations → links.json;其余(provenance/flags/...)需要时入 node.json。scope 强制从 DB 挪到地址翻译层。内存视图也服务于 rename/delete 的对端定位(虽 `in`/`out` 已自带反向索引,视图加速查找)。

### D8 projects 子树 = 比 knowledge/memory 丰富(讨论中)
实测 `wiki-skeleton-service` 已是 projects 的镜像引擎(无 LLM 静态扫描器):
- **auto-index**:扫 repo(main 分支)→ 建**统一无类型节点**镜像 repo 文件树(一个 repo 文件/目录 = 一个节点;取消 header/intent/structure 分类)。
- **git 增量 sync**:`lastScannedRef` 按 (archivist, project) 维度,合并后 `git log/diff <last>..main` 只重读变化;`rescanProjectFull` 周期全量兜底漂移;只跟 main(feature WIP 不进 wiki)。
- **archivist agent 充实**:LLM 给节点 content.md 加语义正文(骨架之后)。
- **写入守卫**:`upsertProjectNode` 强制 scope=自己 project 子树;本服务是 project 结构的唯一写入方(无类型约束)。

**新模型下的待决(projects 专属)**:
1. ✅ **取消 header/intent/structure 子类**(用户定):projects 节点统一无类型;以后需要子类/provenance 再加 node.json。
2. ✅ **provenance 一并取消**(同上;sync 可重建,需要时入 node.json)。
3. ✅ **projectId ↔ folder 映射 = 不需要**:**全删重建 + 路径即身份** → folder 名(projectName)就是项目身份,skeleton sync 改按 folder 名 key(无 projectId)。rename 项目 = folder 改名 = sync 游标失效 → 下次全量 rescan(可接受)。
4. **骨架 owns 边界 → plan 细节**:无子树分裂;skeleton rescan 时保留 agent 写的 content.md(不踩)。
5. ✅ **全删重建,且按新规则**(用户定):skeleton service **整体重写为新模型** —— 无类型 / 路径即身份 / folder-per-node / `.wiki/{node.json,summary.md,content.md,links.json}` / `repository.json` 含 git 版本号 / **写文件不碰 DB**(废 `upsertProjectNode`)。全删后由 **NEW skeleton** 重扫 repo 重建(**不是重跑旧 skeleton**);knowledge/memory 从空起步。⚠️ 待确认:全删是否含 knowledge/memory 现有用户内容?

### D8.1 projects 的 `.wiki/` 布局
**容器 `projects/.wiki/`** = 标准最小(node.json + summary.md + content.md + links.json),**无额外**:
- 项目列表 = `readdir` 子文件夹(folder 名即项目);FS 强制 folder 名唯一 → 无需 registry;无 projectId(folder 名即身份)。

**项目根 `projects/<name>/.wiki/`** = 标准最小 + **`repository.json`**(仅 project 根有):
```
projects/<name>/.wiki/
├── node.json          # 最小(同所有节点,统一)
├── summary.md
├── content.md
├── links.json
└── repository.json    # repo 绑定(仅 project 根)
```
```json
{ "path": "D:/work/multica", "lastScannedRef": "abc1234deadbeef" }
```
- `path`(repo 绝对路径)必有(用户定;skeleton 扫描根)。
- `lastScannedRef`(**git 版本号 / commit SHA**)必有(用户定):增量 sync 游标 + 标记镜像对应的 repo 版本;不存则全量 rescan。
- remote/branch 等暂不加(YAGNI,默认 main)。
- node.json 保持最小 → repo 绑定单独 `repository.json`(project 根独有,可扩展),不污染统一的最小 node.json。

## 待决策(design→plan gate)

① ✅ **已定**:路径即身份,**无稳定 id**。links/addresses 全用路径引用;rename 靠工具按 `in`/`out` 改写对端(D3/D2.2)。
② ✅ **已定**:统一最小节点结构 = 4 文件 `.wiki/`(node.json + summary.md[必填] + content.md[可空] + links.json[双向路径,工具维护])。
③ ✅ **已定**:memory per-agent(`memory/<agent-id>/`,新建 agent 自动建、删 agent 自动删;现状已 per-agent)。
④ ✅ **已定**:type **位置派生**(node.json 不存 kind;`memory/`/`knowledge/`/`projects/` 目录即类型)。
⑤ ✅ **基本定**:地址翻译层(addresses.json + resolver + 返回包装;动态地址 = contextBundle scope)。resolver 实现细节待 plan。
⑥ ✅ **已定:全删重建**(用户确认,含 knowledge/memory 笔记)。旧 wiki(`<title>__<hash>.md` + `project_wiki` DB)整体废弃;projects 由**新规则 skeleton**(无类型/路径即身份/写 `.wiki` 文件)重扫 repo 重建(**非重跑旧 skeleton**),knowledge/memory 从空起步。无迁移/回滚/自愈负担。
⑦ ✅ **已定**:node.json 最小 = `{created_at, updated_at}`(+可选 schema_version),其余需要再加(D2.1)。
⑧ ✅ **projects 全定**:Q5 人类名(folder=projectName);Q6 skeleton 已有(简化为**无类型** repo 镜像 + git sync);Q3 无需 projectId(folder 名即身份);Q1/Q2 取消 header/intent/structure 子类 + provenance(需要时入 node.json);repository.json 含 `path` + `lastScannedRef`(git 版本号,必有)(D8.1);⑥ 全删重建。Q4 骨架 owns 边界 → plan 细节。

## 影响面 / sub 划分(待 plan 细化)

- **sub-1** 节点模型 + 内存视图(`.wiki/` 4 文件读写 + node.json 最小 schema + links 双向路径 + rename/delete 链维护 + 校验)
- **sub-2** 命名空间 + 地址翻译层(knowledge/memory/projects 清理 + addresses.json + resolver + 返回包装 + scope 注入)
- **sub-3** 工具协议归并(expand/read/search/create/update/delete 过翻译层)
- **sub-4** skeleton 改写为新规则(无类型 / 路径即身份 / 写 `.wiki` 文件 / `repository.json` 带 git 版本号 / 不碰 DB)+ 全删后由**新 skeleton** 重扫 repo 重建 projects(非重跑旧 skeleton)
- **sub-5** search 重写(建新模型 + grep + 输出优化)

顺序:模型 + 迁移先行 → namespace/地址 → 工具 → search(依赖新模型)。

## 关联

- [issue.md](./issue.md)(本 effort 问题记录)
- 参考架构《面向 AI Agent 的统一 Wiki 架构》`agent-wiki-architecture.md`(用户 2026-07-16 提供,仓库外,蓝本)
- [doc-artifacts-as-files](../../issues/doc-artifacts-as-files/issue.md)(伞:agents/templates + 虚拟路径 infra;wiki 半边在此 design 落地)
- [arch/06-knowledge-subsystems.md](../../arch/06-knowledge-subsystems.md)(现有 wiki 架构说明)
