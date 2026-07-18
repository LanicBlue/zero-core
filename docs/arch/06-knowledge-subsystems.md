# 06 - 知识子系统

> **⚠ plan-08 cutover 后此文档大部分过时**。Wiki 已从 v0.8 的"`project_wiki` 表 +
> 磁盘镜像 markdown 树 + anchor 决定 scope"模型**重设计**为:
>
> - 独立 `db/wiki.db`(7 张表:`wiki_nodes` / `wiki_links` / `wiki_addresses` /
>   `wiki_repositories` / `wiki_source_bindings` / `wiki_nodes_fts` / `wiki_audit_log`)。
> - **正文直接存 `wiki_nodes.content`**(不再下沉磁盘 markdown)。
> - **scope 由 `wikiGrants` + `wikiContext` 决定**(在 CallerCtx 中编译,plan-05/07),
>   不再由 anchors 决定。
> - 节点寻址用 **canonical path** 或 **logical address**(`memory://` /
>   `project://` / `runtime://...`),不再用 nodeId/short id。
> - Project 镜像通过 `wiki_repositories` + `wiki_source_bindings` 表跟踪 git
>   repo(source_root + indexed_revision + per-file blob_oid),不再用
>   `header:/intent:/structure:` provenance 节点。
>
> 下文 §2/§2.5/§2.6 描述的 v0.8 模型(`WikiStore` / `wiki-anchor-injection.ts` /
> `ProjectWikiStore` / `WikiSkeletonService` 写 `header:/intent:/structure:` /
> 磁盘镜像树 `diskPathFor` / `wiki_anchors` / `wikiAnchors` / `wiki_scan_cursors`)
> 已全部**物理删除**(plan-08 §1)。本文保留这些段落仅作为**历史参考**,
> 阅读时请对照:
>
> - [plan-01-database-contracts.md](../plan/wiki-system-redesign/plan-01-database-contracts.md)(新 schema)
> - [plan-02-core-service-address-auth.md](../plan/wiki-system-redesign/plan-02-core-service-address-auth.md)(地址 + 授权)
> - [plan-03-project-git-mirror.md](../plan/wiki-system-redesign/plan-03-project-git-mirror.md)(Project git 镜像)
> - [plan-04-wiki-tool-search.md](../plan/wiki-system-redesign/plan-04-wiki-tool-search.md)(Wiki v2 tool)
> - [plan-05-agent-runtime-prompt.md](../plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md)(grants/context + Prompt)
> - [plan-06-data-api-browser-ui.md](../plan/wiki-system-redesign/plan-06-data-api-browser-ui.md)(数据面 API/UI)
> - [plan-07-management-ui.md](../plan/wiki-system-redesign/plan-07-management-ui.md)(管理面 API/UI)
> - [plan-08-cutover-hardening.md](../plan/wiki-system-redesign/plan-08-cutover-hardening.md)(cutover + 备份 + 维护)
> - [design.md](../plan/wiki-system-redesign/design.md)(完整设计)

## 0. Wiki v2(plan-01..plan-08 cutover 后的当前模型)

### 0.1 数据存储

- **独立 `db/wiki.db`**(`WikiDatabase` 持有,`src/server/wiki/wiki-database.ts`)。
  生命周期与 core.db 解耦:独立 WAL / checkpoint / backup / health / close。
  PRAGMA: `journal_mode=WAL` + `foreign_keys=ON` + `busy_timeout=5000`。
- 7 张核心表 + `wiki_schema_version`:
  - `wiki_nodes(id, parent_id, name, path, kind, summary, content, attributes_json, revision, created_at, updated_at, archived_at)` — INTEGER PRIMARY KEY 自带 INTEGER affinity;`content` TEXT 直接存正文(不再下沉磁盘);active path/sibling 用 partial unique index(`WHERE archived_at IS NULL`),归档后可重建同路径。
  - `wiki_links(source_id, target_id, relation, created_at, created_by)` — 复合主键,一表双向(in/out);source CASCADE、target RESTRICT。
  - `wiki_addresses(address, target_id, resolver, scope, kind, prompt_policy, revision, ...)` — 静态逻辑地址表;动态地址(`memory://` / `project://`)不入此表,运行时解析。
  - `wiki_repositories(repository_id, project_node_id, project_id, source_root, default_branch, indexed_revision, sync_status, ...)` — 项目镜像 git repo 绑定,1:1 与项目根节点。
  - `wiki_source_bindings(node_id, repository_id, source_path, source_kind, indexed_revision, blob_oid)` — 文件/目录节点的源码映射,UNIQUE(repository_id, source_path)。
  - `wiki_nodes_fts(name, summary, content)` — FTS5 external-content(content='wiki_nodes', content_rowid='id'),无 trigger,由 repository 在显式 transaction 内同步。
  - `wiki_audit_log(audit_id, request_id, actor_agent_id, session_id, action, node_path, old_revision, new_revision, detail_json, created_at)` — 公开 opaque 操作 receipt。
- 固定根(`wiki-root` + `wiki-root/knowledge` / `wiki-root/memory` / `wiki-root/projects`)由 `WikiDatabase.open` bootstrap,幂等。
- Schema init/migration **不在** `db-migration.ts` 的旧 `project_wiki` 段;由 `wiki-schema.ts` 的 `initWikiSchema` + `wiki_schema_version` 表管理。fresh core.db 不再创建 `project_wiki` 表。

### 0.2 数据面 vs 管理面(双平面分离)

- **数据面**(`/api/wiki`,plan-06):Agent 与 UI 共享的 wiki tree 操作。9 个 Wiki tool action(expand/read/search/create/update/delete/link/unlink/move)走 CallerCtx 编译的 `wikiAccess` 授权。
- **管理面**(`/api/wiki-admin`,plan-07):配置 Wiki policy —— addresses / repositories / grants / context / sessions。20 个 endpoint;authority 由 server host 注入 `WIKI_ADMIN_AUTHORITY`(renderer 不能从 body 自授身份)。
- **维护面**(`/api/wiki-maintain`,plan-08 §3 + §5):backup / restore / integrity / foreign-keys / fts rebuild / optimize / explicit legacy cleanup。不操作活跃 DB 的 checkpoint/VACUUM/migration;只读 PRAGMA(integrity_check/foreign_key_check/optimize)安全。

### 0.3 Grants + Context(scope 与 prompt 编译)

- 每个 Agent 有 `wikiGrants`(显式 scope list:canonical scope + actions + 可选 path constraint)和 `wikiContext`(prompt 注入规则:scope + template + limit + view)。
- 会话启动时 `compileWikiAccess(agent, sessionCtx)` 把 grants 编译为 `WikiAccess`(scope 树 + per-scope actions)。每次 tool call 快照到 CallerCtx。
- `compileWikiContext(agent, sessionCtx)` 把 context rules 物化为 prompt 段落。
- Project `activeProjectId` 在 session build 时注入;`project://` 地址按 activeProjectId 解析。
- Agent Editor(`WikiAccessSection.tsx` / `WikiContextSection.tsx`)显式编辑 grants/context;publish 走 CAS + audit + 热同步。

### 0.4 Project git 镜像

- 项目根节点(`wiki-root/projects/<projectId>` 绑定到 `wiki_repositories`)。
- `WikiProjectIndexer.ensureBinding` / `sync` / `rebuildFromScratch` 把 git repo 的文件/目录结构镜像到 `wiki_nodes`(kind=`source_file` / `source_directory` 等)+ `wiki_source_bindings`(per-file blob_oid + indexed_revision)。
- 增量扫描用 `git diff <indexed_revision>..<default_branch>`;feature-branch WIP 不进 wiki,只跟 main/master。
- rename 走两阶段 swap(避免 partial UNIQUE 冲突),FTS 在 phase-1 同步改名(round-3 FIX 1)。
- 状态可观察:`wiki_repositories.sync_status`(pending/indexing/idle/failed)+ `last_indexed_at` + `last_error`;UI/Project mirror card 显示进度。

### 0.5 备份与维护(plan-08 §3)

- `BackupService`(`src/server/wiki-backup-service.ts`):SQLite Backup API 在线 snapshot Core/Wiki 各自独立,manifest sidecar JSON 记 source/sha256/schema_version/business_revision/sqlite_version/verified。**不复制活跃 DB 文件**。
- `restoreSnapshot` 复制到临时 DB(不覆盖活跃);verify integrity + foreign keys + 业务计数。
- 写 Wiki 不触发 Core checkpoint/mtime/WAL 变化(独立 DB + 独立 connection)。
- readonly 诊断绝不对活跃 DB checkpoint/VACUUM/migration(memory feedback-sessions-db-readonly)。

### 0.6 FS guard(plan-08 §2)

- `core/protected-paths.ts` 集中列出 db/core.db{,-wal,-shm} + db/wiki.db{,-wal,-shm} + backups/{core,wiki} + wiki/.runtime + wiki/。
- `tools/wiki-path-guard.ts` 重写:Read/Write/Edit/Grep/Glob/Shell 统一断言 `assertNotProtectedPath`。canonicalize 处理相对路径/引号/env var/大小写/symlink/junction/shell 拼接。
- 唯一例外:管理备份服务(不在 Agent shell 内)。

### 0.7 性能基线(plan-08 §4)

可重复 benchmark 脚本 `scripts/wiki-benchmark.ts --nodes=100000` (CI) 或 `--nodes=1000000` (发布前手工):
canonical path read / parent expand+pagination / incoming-outgoing links / FTS top-k / authorized multi-scope search / bounded subtree move。
每场景前 `EXPLAIN QUERY PLAN` 断言用 path/parent/target/FTS 索引(避免硬件 flaky)。
结果记录参考硬件/数据规模/耗时/内存/commit SHA。1M 由人工触发,报告附在 `docs/plan/wiki-system-redesign/bench-1M.json`(若未附则不能宣称百万节点已验证)。

---

## 1. 当前实际分层

| 子系统 | 当前定位 | 是否在默认 Agent 会话主链路 | 主要入口 |
|------|------|------|------|
| MCP | 外部工具协议接入 | 是，以工具形式暴露 | `MCPManager` + `ToolRegistry` |
| Wiki v2 (plan-01..08) | 项目知识 + Agent 记忆 + Project 镜像,独立 wiki.db + grants/context | 是,Wiki v2 tool + context bundle 注入 | `WikiService` + `Wiki` v2 tool(`/api/wiki` 数据面) + `/api/wiki-admin` 管理面 |

> 历史上的 KB 子系统(本地文档 → chunk → embedding → 向量检索)与 Gen1 `MemoryNodeStore`(FTS5 节点记忆)已退役(详见 §3)。**v0.8 的 anchor-scope + 磁盘镜像 markdown 模型也已在 plan-08 cutover 中退役**(本文 §2 以下保留作历史参考)。

实际运行图(plan-08 后):

```mermaid
graph TB
    Start["server/index.ts startup"] --> DB["DatabaseManager.open (core.db + wiki.db)"]
    DB --> WikiDb["WikiDatabase (wiki.db)"]
    WikiDb --> WikiService["WikiService (nodeRepo + linkRepo + auditRepo + authz)"]
    WikiService --> DataApi["/api/wiki (数据面,plan-06)"]
    WikiService --> AdminApi["/api/wiki-admin (管理面,plan-07)"]
    WikiService --> MaintainApi["/api/wiki-maintain (维护面,plan-08)"]
    WikiService --> Indexer["WikiProjectIndexer (git mirror,plan-03)"]
    WikiService --> AgentService["AgentService (CallerCtx.wikiAccess 编译)"]
    AgentService --> Loop["AgentLoop"]
    Loop --> CallerCtx["CallerCtx per tool call (snapshot wikiAccess)"]
    CallerCtx --> WikiV2Tool["Wiki v2 tool (9 action)"]
    Loop --> ContextBundle["context bundle (compileWikiContext,plan-05)"]
```

---

## 2. (Legacy v0.8) Wiki Tree — 已被 §0 Wiki v2 取代

> **以下 §2/§2.x 全部描述 v0.8 模型,plan-08 cutover 后已退役**。保留作历史参考。
> 当前模型见 §0 Wiki v2。
> 阅读时请把以下概念替换:
>   - `WikiStore` / `ProjectWikiStore` / `wiki-node-store.ts` → `WikiService` + `wiki-node-repository.ts`(新 wiki.db)
>   - `wiki-anchor-injection.ts` + `wikiAnchors` / `wikiAnchorNodeIds` → `wikiGrants` + `wikiContext`(CallerCtx 编译)
>   - `project_wiki` 表 + 磁盘镜像 markdown → `wiki_nodes.content` TEXT(直接存)
>   - `diskPathFor` / `writeNodeDetail` / `readNodeDetail` → 直接 SQL 读写 `wiki_nodes.content`
>   - `header:` / `intent:` / `structure:` provenance → `wiki_repositories` + `wiki_source_bindings` 表(per-file blob_oid + indexed_revision)
>   - `WikiScanCursorStore` → `wiki_repositories.indexed_revision` + `wiki_source_bindings.indexed_revision`
>   - `WikiSkeletonService`(写 header:/intent:) → `WikiProjectIndexer`(只写 wiki_nodes + wiki_source_bindings)
>   - 短 id `#xxxxxxxx` → canonical path / logical address(`memory://` / `project://` / `runtime://...`)
>   - `Wiki` v1 tool(expand/search/docRead/docWrite/docEdit + projectId 闸门)→ `Wiki` v2 tool(9 action:expand/read/search/create/update/delete/link/unlink/move)

### 2.1 启动与依赖注入

`src/server/index.ts` 在启动早期创建全局 `WikiStore`:

#### 存储根与隔离

[`src/server/wiki-node-store.ts`](../../src/server/wiki-node-store.ts) 顶部定义全局磁盘根:

```ts
export const WIKI_DISK_ROOT = join(ZERO_CORE_DIR, "wiki");
```

所有 Wiki 正文文件都落在这棵目录树里。这是一个 **强隔离根**:

- `readNodeDetail` / `writeNodeDetail` / `deleteNodeDetail` / `diskPathFor` 全部在返回前过一遍 [`isInsideWikiDisk()`](../../src/server/wiki-node-store.ts) —— 如果算出的路径以任何形式逃出 `WIKI_DISK_ROOT`(legacy 行、buggy upsert、外部相对路径如 `src/foo.ts`),直接 throw,绝不写。
- agent 的 FS 工具(Shell / Read / Grep / Glob / Write / Edit)通过 `wiki-path-guard` **反向** 复用同一个根,**拒绝** 任何解析进 `WIKI_DISK_ROOT` 的路径 —— Agent 永远碰不到正文文件,只能通过 nodeId 走 `Wiki` 工具的 `ExpandNode` / `UpdateWikiNode`,由 store 层代为读写。

#### 路径推导:folder = 目录,leaf = 文件

正文路径由节点的 **位置** 推导,不是查表。核心函数 [`WikiStore.diskPathFor(nodeId)`](../../src/server/wiki-node-store.ts):

```text
节点类型                    磁盘路径
─────────────────────────  ────────────────────────────────────────────────────────
global root (WIKI_GLOBAL)  <ROOT>/global-root__<id8>.md
container root             <ROOT>/<path>/<path>__<id8>.md          (area 级,无自己的 subdir)
  (knowledge/projects/memory)
subtree root (wiki-root:*) <ROOT>/<area>/<seg>/<seg>__<id8>.md     (自带 id-suffix subdir)
regular leaf (无子节点)     <ROOT>/<area>/<...segs>/<slug>__<id8>.md
regular folder (有子节点)   <ROOT>/<area>/<...segs>/<slug>/<slug>__<id8>.md   ← 正文移进同名子目录
```

要点:

- `area` 由位置决定:`projects/<projectId>/` / `memory/<agentId>/` / `knowledge/`。memory 的 per-agent 子树 root(`wiki-root:memory-agent:<agentId>`)由 `subtreeArea()` 归到 `memory`,`subtreeSeg()` 取 `<agentId>` 作目录段。
- `segs` 由 `resolveAreaAndSegs()` 从节点 **向上走 parent 链** 收集(cycle-guarded,`visited` set 防环),每经过一个普通中间祖先压一个 `nodeSlug(cur)` 段;遇到 container root / subtree root / global root 即停。
- `nodeSlug(node)` = `sanitizeSeg(title)`(`: / \` → `_`,去首尾 `_`,保留中文,`.` / `..` 被 drop 作 path-traversal 防护),空则 fallback 到 `id8(id)`。
- `id8(id)` = id 前 8 字符,作文件名后缀保证 area 目录内唯一。
- **folder ≠ leaf**:当一个普通节点 **有子节点**(`getChildren().length > 0`),它的正文文件被搬进 **同名子目录**,子节点的目录链才接得上。这是 `diskPathFor` 里 `isFolder` 分支的目的。

#### leaf → folder 提升(首次有子节点时)

[`create()`](../../src/server/wiki-node-store.ts) 在 INSERT 前先检查:如果新节点将是它 parent 的 **第一个子节点**,调 `promoteLeafToFolder(parentId)` 把 parent 的正文从 `<chainDir>/<slug>__<id8>.md` `renameSync` 进 `<chainDir>/<slug>/<slug>__<id8>.md` —— **在** 创建 child 的目录之前搬,避免子目录创建撞上还在原位的文件。container / subtree root layout 不随 children 变,跳过。失败 best-effort(`writeNodeDetail` 会按新位置重推导兜底)。

#### 改名 / reparent 时正文跟着搬

[`update()`](../../src/server/wiki-node-store.ts) 改 title 或 parentId 会改变 `diskPathFor` 推导结果(slug 变、segs 变)。流程:先用 **旧行** 算出 `oldDetailFile` → 写新行 → 用 **新行** 算出 `newDetailFile` → 若两者不同,`mkdirSync` + `renameSync` 把正文搬到新位置。**正文永远跟着节点走,不会丢在旧路径成孤儿**(除非 rename 失败,best-effort)。

#### 启动一次性迁移

旧库的正文文件是 **平铺布局**(`legacyDeriveContentFilePath`:`<ROOT>/<area>/<path>__<id8>.md`,全在一个 area 目录里)。[`fresh-db-seed.ts`](../../src/server/fresh-db-seed.ts) 的 `ensureWikiSkeleton()` 在 **每次启动** 末尾调 [`wikiStore.migrateWikiDiskLayout()`](../../src/server/wiki-node-store.ts):

- 遍历所有节点,算 `legacyDeriveContentFilePath(node)` 和 `diskPathFor(node.id)`,相同跳过;
- 旧文件不存在 → `skipped++`(已迁移过 / 从未有正文);
- 旧文件存在 → `mkdirSync(newFile/..)` + `renameSync(oldFile, newFile)`,并 `UPDATE doc_pointer` 到新路径,`moved++`;
- 幂等:跑过的库再跑全是 skipped。

#### 写入 / 读取原语

- [`writeNodeDetail(nodeId, content)`](../../src/server/wiki-node-store.ts):永远写 **推导路径**,绝不写 `node.docPointer`;写完才把 `docPointer` 盖成推导路径(当 cache,防 legacy/逃逸值)。`mkdirSync(file/..)` 保证父目录存在。**改正文不动 DB 其他列** —— 想改 title/summary 走 `update()`。
- [`readNodeDetail(nodeId)`](../../src/server/wiki-node-store.ts):永远读 **推导路径**,`docPointer` 只在缓存命中时省一次 `diskPathFor`,**绝不** 直接读它(legacy 行可能指向库外)。

### 2.6 archivist 增量扫描与摘要懒加载(v0.8 M2)

> Wiki 的 **项目子树结构**(header=代码文件 / intent=需求文档 / structure=模块)不是手写的,是 [`WikiSkeletonService`](../../src/server/wiki-skeleton-service.ts)(无 LLM 的静态扫描器)扫 workspace 建出来、增量维护的。

#### 入口与触发

- `buildSkeleton(projectId)` —— 增量扫描入口。由 `createProject` 在后台触发,cron / requirement-hooks / 项目通知分发也会调。
- `rescanProjectFull(projectId)` —— 周期全量 rescan,作漂移兜底(RFC §2.13),跑完把 cursor 重置到 main 当前 HEAD 并盖 `lastFullScanAt`。

两个入口都先 `git.ensureRepo(workspaceDir)`(非 repo 自动 `git init`),再 `wiki.ensureProjectSubtree(projectId, name)`。

#### 增量:git diff,不是全目录遍历

`buildSkeleton` 的核心是 **按 (archivist, project) 维度的 git 游标**(`WikiScanCursorStore`,游标不挂 agent 上 —— RFC §4.2,agent 可能换人/被删):

```mermaid
sequenceDiagram
    participant T as trigger (createProject/cron)
    participant S as WikiSkeletonService
    participant G as ArchivistGit
    participant C as WikiScanCursorStore
    participant W as WikiStore

    T->>S: buildSkeleton(projectId)
    S->>G: ensureRepo(workspaceDir)
    S->>W: ensureProjectSubtree(projectId)
    S->>C: get(archivistId, projectId).lastScannedRef
    S->>G: changesSince(workspaceDir, lastScannedRef)
    alt isInitial=false AND files.length=0
        S-->>T: { filesScanned: 0, notes: ["no changes since last scan"] }
    else 有变化
        S->>S: ingestFiles(projectId, files)
        S->>C: setLastScannedRef(archivistId, projectId, changeSet.ref)
        S-->>T: ScanResult
    end
```

`changesSince` 跑 `git log/diff <last>..main` 给出变化文件清单 —— **只重读变化部分**(决策 19/26)。**Feature-branch WIP 永远不进 wiki**(决策 26),只跟 main。没有变化直接 no-op 返回。

#### 摘要懒加载:扫描时不读源码

扫描时 **不读源码** —— `ingestFiles` 对每个文件 upsert 一个 `header:<relPath>` / `intent:<relPath>` 节点,`summary` 留空字符串。目录节点扫完盖一个 placeholder summary(`Project root: N file(s).` / `Directory <rel>: N file(s).`)。

真正读源码算 rich summary 推迟到 **第一次 expand**,由 [`ensureSummary(nodeId)`](../../src/server/wiki-skeleton-service.ts) 触发:

1. `summary` 已非空 → 直接返回(已物化,零 IO);
2. `header:` / `intent:` 节点 → 从 path 切出 relPath,`resolve(workspaceDir, relPath)` 算绝对路径,`existsSync` 校验;
3. `header:` 调 `summarizeCodeFile`:`readFileSync` → 行数 / exports(`extractExports`)/ 头 3 行 head,拼成 `<relPath> — N line(s). Exports: ... Head: ...`;
4. `intent:` 调 `summarizeDocFile`:读文件、抽标题/段;
5. 算出来非空 → `wiki.update(id, { summary })` 写回行(**lazy 物化**:第一次读付钱,以后命中 row summary 零 IO)。

structure / project / memory 节点没有源文件,原样返回现有 summary。

这个设计让 **建骨架**(O(文件数) 的 upsert,但零读盘)和 **看节点**(O(1) per expand,只读被点的那一个)的代价解耦,大仓库扫骨架从分钟级降到秒级。

#### 写入权限护栏

`WikiSkeletonService` 是 `WikiStore.upsertProjectNode` 的 **唯一调用方**。store 层强制:scope = 自己 project 子树、type 只能是 `header` / `intent` / `structure`。archivist agent 角色不直接写库 —— 它经这个服务建骨架(决策 9/18/39),需要深度充实的内容走 `Wiki` 工具的 create/update(带 provenance 标 `confirmed` / `derived`)。

#### 节点 summary / body 语义(工具层约定,面向所有用 Wiki 的 agent)

Wiki 是所有 agent 共用的工具,不是某个角色专属。因此 `summary` 与 `body`(正文 doc)的语义是 **Wiki 工具层的通用约定**,写在 [`wiki-tool.ts` 的 prompt](../../src/runtime/tools/wiki-tool.ts) 里,任何用 Wiki 的 agent 都遵守,不绑定 archivist 等具体角色:

- **`summary`(节点摘要)**= 以该节点为根的 **子树 abstract**(一行,概括这棵子树"是什么")。
- **非叶节点的 `body`(正文)**= 该子树的 **overview**(子节点们集体做什么、如何配合)。写一个父节点的 body = 写它的子树 overview。
- **叶节点的 `body`(正文)**= 实际内容。若该叶子镜像一个项目文件(`header:<relPath>`),body 是该文件的 **注释/说明**(它的作用、定位、坑),**不是文件内容的拷贝**(文件在工作区,读它用 Read)。
- 一致性:父节点的 summary 摘自它的 body,body overview 它的子节点 —— 两者应当吻合。summary 保持一行,body 控制在 overview 的篇幅(一两段),不要整段塞原文。

执行归各 agent 在自己的 work 里按此约定产出;扫描时 `ensureSummary` 的启发式回填仅作 bootstrap fallback,后续 agent 会覆写成符合上述语义的内容。本轮只明确语义,不做代码生成逻辑。

#### 短 id 寻址(降低 token)

注入大纲和工具结果 **不再带完整 nodeId**(叶节点是 36 字符 UUID,合成根 `wiki-root:<projectId>` ~46 字符),改为统一的 8 字符短 id:

- `shortIdOf(nodeId) = sha1(nodeId).slice(0,8)`,显示为 `#xxxxxxxx`([`formatNodeId`](../../src/runtime/wiki-anchor-injection.ts))。确定、跨 session 稳定、无需 per-session 状态;对叶节点和合成根一视同仁,agent 看不到 `wiki-root:` 字面量。
- agent 在 `expand` / `search` / `create` / `update` / `delete` / `docRead` / `docWrite` / `docEdit` 的 `nodeId` / `parentId` 入参里直接传 `#xxxxxxxx`;工具入口 [`resolveNodeIdArg`](../../src/runtime/tools/wiki-tool.ts) 依次试精确全 id → 短 id 扫描(scope 内 sha1-8 唯一命中)→ 报错。歧义(同短 id 多命中,~65k 节点才可能)时让 agent 改用 title path,不静默猜。
- 完整 nodeId 仍是 store 主键;**只在 agent 可见的文本层**换短 id。UI 内部 IPC(`/nodes/:nodeId/children`、`/detail`)仍用完整 id,renderer 树渲染不动。

## 3. 已退役:KB 子系统与 Gen1 Memory

历史上 db/core.db 里曾并存三套知识/记忆后端。v0.8 之后只剩 `project_wiki` 一套;另两套已整体移除。

| 旧子系统 | 状态 | 处置 |
|------|------|------|
| **Wiki tree** (`project_wiki`) | ✅ 唯一主线 | §2 |
| **KB**(`kb_entries` + `kb_chunks`,向量 RAG) | ❌ 已移除 | 服务端 `kb-*`、`/api/kb`、IPC、KB UI 页、shared 类型全删;`kb_entries`/`kb_chunks` 表由 db-migration DROP。将按 **wiki 格式切文件** 重做,不再走 embedding |
| **Gen1 MemoryNodeStore**(`memory_nodes` / `_subjects` / `_edges` / `_fts`) | ❌ 已移除 | `memory-node-store.ts` + `memory-node-router.ts` + `/api/memory-nodes` + IPC 全删;表由 db-migration DROP。写入迁到 wiki memory 子树 |
| **旧实体记忆**(`memory_entities` / `memory_relations`,`MemoryStore`) | ❌ 早已移除 | v0.8 清理僵尸时删除 + db-migration DROP |
| **RAG 注入**(`runtime/hooks/rag-hooks.ts` + `ragContext`/`getRagContext`) | ❌ 已移除 | hook 从未生效(`getRagContext` 从不注入),整条死管道清掉 |
| **旧 memory 工具**(`MemoryRecall` / `MemoryNote` / `memory-tools.ts`) | ❌ 早已移除 | v0.8 P2 §11.6 删除,记忆改走 `Wiki` 工具 |

### 3.1 为什么删 KB

KB 子系统(上传文件 → chunk → embedding → 语义检索)是一条与 wiki 并行的 RAG 路径,从未接到 agent —— `rag-hooks` 是死的(无 `getRagContext` 注入),且要外部 embedding provider 无人配置。知识/记忆改为统一以 wiki 子树承载。该功能以后会以"按 wiki 格式切文件"的方式重做,不复用向量 embedding 路线,因此当前的基础设施整条退役而非保留。

### 3.2 为什么删 Gen1 MemoryNodeStore

v0.8 M5 已把记忆写入迁到 wiki memory 子树(extractor-A + compression-hooks 都写 wiki)。`MemoryNodeStore` 只剩两个残余用途:compression-hooks 在 wiki 不可用时的回退写入、以及已删 KB 页的 memory-node 视图。两者都已不需要,store 整条移除。`MemoryNodeInput` 类型搬到 `compression-engine.ts`(生产者侧)。

### 3.3 维护者提示

- **改 `project_wiki` schema** → 改 `db-migration.ts`(`migrateWikiTableSchema` / `migrateWikiDetailToDisk` 子函数,§2.5 启动迁移)。
- 旧 KB / Gen1 memory 的表 DROP 在 `runMigrations` 的"Drop legacy memory + knowledge-base tables"段(`db-migration.ts`),`DROP IF EXISTS` 幂等,fresh DB 不会建这些表。
- 不再有 `/api/kb`、`/api/memory-nodes`、`getMemoryNodeStore`、`getRagContext`、`memoryConfig.memory` 这些接口面 —— 文档/代码里若再提到它们即过时。

## 4. 三类知识能力的边界

```mermaid
graph LR
    MCP["MCP tools"] --> Tools["ToolRegistry / streamText tools"]
    Wiki["Wiki tree"] --> Anchors["system/context anchors"]
    Wiki --> WikiTool["Wiki tool"]
```

| 维度 | MCP | Wiki tree |
|------|-----|-----------|
| 默认会话可见性 | 作为工具可见 | system/context anchors + Wiki 工具 |
| 写入时机 | 用户配置外部 server | 用户/工具/Extractor/Compression |
| 数据形态 | 外部工具协议 | 树形节点/子树/锚点 |
| 推荐演进 | 增强健康检查与重连 | 强化版本、权限、检索体验 |

## 5. 架构建议

### 5.1 近期建议

- 把 Wiki tree 明确作为唯一长期记忆主线:文档、UI、工具命名都围绕 Wiki anchors / Wiki memory 组织(已完成大半:KB/Gen1 memory 已删)。
- 为 `Wiki` 工具补足面向 Agent 的操作说明:什么时候读索引、什么时候读节点详情、什么时候写入新节点。

### 5.2 中期建议

- 给 Wiki 节点建立更清晰的作用域模型:global / project / agent / session,避免所有长期知识最终都堆在同一棵树上。
- 引入 Wiki 节点的版本/来源元数据:由用户写入、Extractor 写入、Compression 写入应能区分,便于回滚和信任判断。
- 重做"文件知识库"时,以 **wiki 格式切文件**(把导入文档拆成 wiki 节点挂知识子树)实现,而非恢复向量 embedding;这样与现有 wiki anchor / scope 模型天然一致,不必再造一套并行存储。
