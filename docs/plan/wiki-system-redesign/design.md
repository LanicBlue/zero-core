# zero-core Wiki 系统重构设计

> 状态：Proposed（实施基线）  
> 范围：Wiki 存储、工具、权限、Prompt、项目同步、REST/IPC 与 UI  
> 依据：《面向 AI Agent 的统一 Wiki 架构》  
> 本文只定义设计，不包含实现；旧 Wiki 数据不迁移。

## 1. 目标与结论

zero-core 的 Wiki 应从当前的“SQLite 节点元数据 + 磁盘 Markdown 正文 + nodeId/短 ID 寻址”重构为：

```text
独立 SQLite Wiki 数据库
+ 统一规范路径
+ 内部稳定 ID
+ 关系表与 FTS5
+ 外部 Agent grants
+ 逻辑地址解析
+ 项目仓库语义镜像
```

Agent 看到的始终是一棵树：

```text
wiki-root
├── knowledge
├── memory
│   └── <stable-agent-id>
└── projects
    └── <stable-project-id>
```

核心结论：

- 数据库统一位于 `${ZERO_CORE_DIR}/db/`：Core 状态使用 `core.db`，Wiki 使用独立 `wiki.db`；正文不再拆到磁盘 Markdown 文件。
- 已退役的 `knowledge.db` 由数据库布局切换直接删除，不迁移或保留兼容读取。
- `wiki-root/...` 是 Agent 可见的规范路径；SQLite `id` 仅供内部关联，绝不暴露给 Agent。
- Project Wiki 是仓库结构的语义镜像，源码和仓库文档正文仍以 Git 仓库为事实源。
- 当前单个 `Wiki(action, ...)` 工具可以保留，但 action 收敛为 `expand/read/search/create/update/delete/link/unlink/move`。
- `wikiAnchors` 不再同时承担权限和注入；权限改为 Agent 配置中的 `wikiGrants`，Prompt 注入改为独立的 `wikiContext`。
- 逻辑地址注册、仓库绑定、grants 与 Prompt 发布属于管理面，不属于普通 Agent 的 Wiki 数据工具。
- 项目索引在成功 commit/merge 后按 Git diff 更新；不自动复制源码正文。
- 不迁移当前 `project_wiki` 表或 `~/.zero-core/wiki/*.md`。新系统启用后旧数据直接停止读取。

## 2. 当前实现与目标差距

| 方面 | 当前实现 | 目标实现 |
|---|---|---|
| 存储 | `sessions.db.project_wiki` 保存元数据，正文位于 `~/.zero-core/wiki` | `db/core.db` 保存应用状态；独立 `db/wiki.db` 保存节点、正文、链接、地址、索引和审计 |
| 身份 | UUID、合成 root ID、8 字符短 ID、title path 并存 | Agent 只使用规范路径或逻辑地址；内部 ID 透明 |
| 路径 | `project:<id>`、`header:*`、`intent:*`、`structure:*` | 统一 `wiki-root/<namespace>/...` |
| 节点类型 | 依靠 `header/intent/structure/project/memory` | `root/namespace/project/directory/source_file/document/...` |
| 链接 | 节点行中保存无方向的 nodeId 数组 | 独立 `wiki_links` 表，一条记录天然支持 backlink |
| 正文操作 | `docRead/docWrite/docEdit` 操作磁盘文件 | `read/update` 操作 SQLite TEXT，支持 revision 和局部编辑 |
| 搜索 | title/summary/path 子串或 JS regex，不搜正文 | FTS5 + exact/substring/glob/regex，并可统一搜索源码 |
| 权限 | resolved anchors 同时决定读、写和 Prompt 注入 | Agent grants 决定访问；wikiContext 只决定 Prompt 注入 |
| 项目索引 | 扫描部分代码/文档，生成 header/intent/structure | 每个 Git tracked 文件和推导目录均有镜像节点 |
| Prompt | 根正文 + 一层 children + 短 ID 说明 | 注入逻辑地址、丰富 Memory/Project manifest 和按需读取指导 |
| UI | 全局/项目树、简单子串搜索、原始正文 textarea | 规范路径树、结构化搜索、Markdown、关系、源码、同步与权限配置 |

当前实现中值得保留的部分：

- 单个 action 型管理工具符合 zero-core 现有工具约定。
- Zustand 按节点懒加载 children、按选中节点加载正文的模式合理。
- Prompt section 使用缓存快照，适合控制 token 和 prefix cache。
- 项目扫描已经具备 Git 游标、增量更新、全量重建和 UI 通知的基础设施。
- `ToolResult<T>` 已支持“工具返回结构化 JSON，Agent host 再格式化为文本”的方向。

## 3. 总体架构

### 3.1 数据面与管理面

```text
Wiki Data Plane                     Management Plane
├── expand                          ├── logical addresses
├── read                            ├── repository bindings
├── search                          ├── Agent grants
├── create                          ├── context policies
├── update                          └── Prompt compile/publish
├── delete
├── link / unlink
└── move
```

普通 Agent 只调用数据面。管理面由 UI、REST 管理接口或受信任的管理 Agent 使用。

### 3.2 物理目录

数据库布局由 Plan 00 统一：

```text
${ZERO_CORE_DIR}/
├── db/
│   ├── core.db
│   └── wiki.db
├── wiki/
│   └── attachments/
└── backups/
    ├── core/
    └── wiki/
```

单独数据库的理由：

- Wiki 可能增长到十万或百万节点，不应放大 session/message 数据库的 WAL、备份和维护成本。
- FTS、项目重建和 Wiki snapshot 可以独立执行。
- 旧 `project_wiki` 可以完全停止使用，不需要改造主数据库中的旧表。
- Wiki 备份、完整性检查和未来导入导出有清晰边界。
- 两个数据库分别拥有连接、migration、WAL、checkpoint、backup 和 close 生命周期，不使用跨库 transaction。

`WikiDatabase` 使用单独的 `better-sqlite3` 连接，启用：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

`DatabaseManager` 在 composition root 中统一编排路径、打开和关闭顺序：CoreDatabase 与 WikiDatabase 全部 ready 后才能构造 WikiService、AgentService 和 recovery。它不暴露 `ATTACH DATABASE` 或跨库事务。Core 与 Wiki 的业务关联使用稳定 Agent/Project ID、幂等 service 操作和修复检查。

## 4. 节点树与路径

### 4.1 固定根结构

首次初始化只创建四个系统节点：

```text
wiki-root
├── knowledge
├── memory
└── projects
```

`wiki-root` 本身可寻址，但通常没有 Agent grant。

创建 Agent 时，由管理服务按不可变 `AgentRecord.id` 幂等创建：

```text
wiki-root/memory/<stable-agent-id>
```

系统只固定 Memory 根，不规定 `preferences/lessons/tasks` 等子树。Agent 根据自己的长期记忆动态创建、移动和合并子节点。删除 Agent 时默认归档 Memory 根，而不是级联硬删除。

注册项目时，由项目管理服务按不可变 `ProjectRecord.id` 创建：

```text
wiki-root/projects/<stable-project-id>
```

仓库索引器随后在该节点下建立仓库镜像。

### 4.2 规范路径

所有持久路径都满足：

- 必须以 `wiki-root` 开头。
- 使用 `/`，不接受 `\`、`.` 或 `..` 路径段。
- 去除重复 `/` 和末尾 `/`。
- 路径段不能为空，并执行长度和非法字符校验。
- 数据库存储规范路径；Agent 输入的逻辑地址只在调用边界解析。

示例：

```text
wiki-root/projects/zero-core/src/tools/wiki-tool.ts
```

普通节点的 `name` 是路径最后一段，也是默认展示名。Agent/Project 根的 `name` 是稳定业务 ID，展示名称使用 `attributes.display_name`。当前 `title` 字段应删除：

```text
display title = attributes.display_name ?? name
```

### 4.3 内部稳定 ID

内部 ID 的作用是：

- `parent_id` 和 links 使用整数关联，避免字符串路径连接和全库搜索。
- 节点 rename/move 时 links 与静态逻辑地址无需更新。
- 支持高效 backlink、外键约束和事务。

Agent 不传、不看、也不缓存内部 ID。REST/UI 可以使用规范路径作为资源键，数据库层在索引中 O(log N) 查到 ID。

## 5. 数据库设计

表名统一使用 `wiki_` 前缀，避免与 zero-core 其他领域表混淆。

### 5.1 `wiki_nodes`

```sql
CREATE TABLE wiki_nodes (
    id              INTEGER PRIMARY KEY,
    parent_id       INTEGER,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'node',
    summary         TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    attributes_json TEXT,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    archived_at     TEXT,

    CHECK(attributes_json IS NULL OR json_valid(attributes_json)),
    FOREIGN KEY(parent_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
);

CREATE INDEX idx_wiki_nodes_parent ON wiki_nodes(parent_id);
CREATE INDEX idx_wiki_nodes_kind ON wiki_nodes(kind);
CREATE INDEX idx_wiki_nodes_archived ON wiki_nodes(archived_at);
CREATE UNIQUE INDEX uq_wiki_nodes_active_path
    ON wiki_nodes(path) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_wiki_nodes_active_sibling
    ON wiki_nodes(parent_id, name) WHERE archived_at IS NULL;
```

`summary` 和 `content` 分开保留，但物理上都位于 SQLite：

- `summary`：expand、搜索结果和 Prompt 注入使用。
- `content`：Markdown 正文，按需 read。
- `revision`：乐观并发控制。
- `attributes_json`：Memory 属性、来源状态、显示名等非通用字段。
- 归档节点保留原始 path/name；partial unique index 允许同路径重新创建。restore 必须先检查 active path/sibling 冲突。

第一版 `kind` 是闭集：

```text
root, namespace, project, directory,
source_file, source_symlink, source_submodule,
knowledge, memory, node
```

文档、测试、配置、资产等细分类放在 `attributes.source_kind`，未知通用节点使用 `node`；不得让任意 kind 字符串直接进入 UI 图标和搜索契约。

一般数 KB 到数百 KB 的正文直接使用 SQLite `TEXT`。图片、PDF、视频、数据集和大型日志放入 `attachments/`，数据库只保存元数据和相对位置。

### 5.2 `wiki_links`

```sql
CREATE TABLE wiki_links (
    source_id   INTEGER NOT NULL,
    target_id   INTEGER NOT NULL,
    relation    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    created_by  TEXT,

    PRIMARY KEY(source_id, target_id, relation),
    FOREIGN KEY(source_id) REFERENCES wiki_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
);

CREATE INDEX idx_wiki_links_target ON wiki_links(target_id);
```

一条记录同时支持 outgoing 和 incoming 查询，不双写反向链接。推荐关系：

```text
depends_on, used_by, contains, implements,
tested_by, documented_by, derived_from,
supersedes, related_to
```

### 5.3 `wiki_addresses`

```sql
CREATE TABLE wiki_addresses (
    address         TEXT PRIMARY KEY,
    target_id       INTEGER,
    resolver        TEXT,
    scope           TEXT NOT NULL,
    kind            TEXT NOT NULL,
    prompt_policy   TEXT,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,

    FOREIGN KEY(target_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
);
```

支持：

- 静态地址：`runtime://` 等管理者注册的地址在表中指向内部节点 ID；地址字符串不包含也不暴露该 ID。
- 动态地址：`memory://`、`project://` 是系统保留 resolver，不插入 `wiki_addresses`。它们分别按 `CallerCtx.agentId/activeProjectId` 解析稳定根路径。
- 规范路径：不需要注册，始终可由 resolver 直接处理。

`resolver` 是闭集声明值，不是函数名或可执行脚本。语法非法返回 `INVALID_ADDRESS`；已知动态地址缺少运行上下文返回 `ADDRESS_UNRESOLVED`；有效地址或 alias 不存在返回 `NOT_FOUND`。

地址管理不进入普通 Wiki tool schema。

### 5.4 仓库绑定

zero-core 已有 `ProjectRecord.workspaceDir`，它继续作为本机 checkout 的事实源。Wiki DB 不重复保存本地绝对路径，只保存共享的索引状态：

```sql
CREATE TABLE wiki_repositories (
    repository_id       TEXT PRIMARY KEY,
    project_node_id     INTEGER NOT NULL UNIQUE,
    project_id          TEXT NOT NULL UNIQUE,
    source_root         TEXT NOT NULL DEFAULT '',
    default_branch      TEXT NOT NULL DEFAULT 'main',
    indexed_revision    TEXT,
    sync_status         TEXT NOT NULL DEFAULT 'pending',
    last_error          TEXT,
    last_indexed_at     TEXT,

    FOREIGN KEY(project_node_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
);
```

文件与目录节点的源码映射使用独立表，而不是从 Wiki path 猜测：

```sql
CREATE TABLE wiki_source_bindings (
    node_id             INTEGER PRIMARY KEY,
    repository_id       TEXT NOT NULL,
    source_path         TEXT NOT NULL,
    source_kind         TEXT NOT NULL,
    indexed_revision    TEXT NOT NULL,
    blob_oid            TEXT,

    UNIQUE(repository_id, source_path),
    FOREIGN KEY(node_id) REFERENCES wiki_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(repository_id) REFERENCES wiki_repositories(repository_id) ON DELETE CASCADE
);
```

### 5.5 全文索引

```sql
CREATE VIRTUAL TABLE wiki_nodes_fts USING fts5(
    name,
    summary,
    content,
    content='wiki_nodes',
    content_rowid='id',
    tokenize='unicode61'
);
```

FTS 固定索引 `name/summary/content`。所有增删改由 repository 在同一个显式 transaction 内同步 node、FTS 和 audit；不使用隐藏 trigger。索引属于可重建数据。

### 5.6 审计与幂等

所有写操作建议记录：

```sql
CREATE TABLE wiki_audit_log (
    audit_id         TEXT PRIMARY KEY,
    request_id       TEXT UNIQUE,
    actor_agent_id   TEXT,
    session_id       TEXT,
    action           TEXT NOT NULL,
    node_path        TEXT,
    old_revision     INTEGER,
    new_revision     INTEGER,
    detail_json      TEXT,
    created_at       TEXT NOT NULL
);
```

`request_id` 用于安全重试；工具执行和 FTS 更新与审计记录应在同一事务中完成。

## 6. Project Wiki：仓库的语义镜像

### 6.1 镜像规则

项目根映射一个已注册仓库：

```text
wiki-root/projects/<stable-project-id>   # display_name = zero-core
├── README.md
├── docs
│   └── design
├── src
│   ├── runtime
│   ├── server
│   └── tools
└── tests
```

索引器以 Git commit 为边界：

1. 使用 `git ls-tree -r --name-only <revision>` 获取 tracked 文件。
2. 从文件路径推导目录节点。
3. 每个 tracked 文件创建一个 source-bound 节点。
4. 路径、kind、source binding 和 blob OID 由索引器管理。
5. `summary/content/links` 是语义层，索引器不得在普通增量同步中覆盖 Agent 已充实的内容。

节点职责：

- 项目根：目标、版本、技术栈、入口、主要模块、近期变化和同步状态。
- 目录：职责、入口、关键子项、依赖和跨目录关系。
- 文件：职责、主要 symbol、依赖、测试和修改注意事项。

源码或 `docs/*.md` 正文不写入 `wiki_nodes.content`。读取原文时通过 `wiki_source_bindings` 找到仓库和 source path，再从 Git 或 checkout 读取。

### 6.2 避免重复文档

必须遵守唯一事实源：

| 信息 | 事实源 |
|---|---|
| 源码 | Git 仓库 |
| 项目文档正文 | Git 仓库中的 docs/README |
| Wiki 摘要与语义说明 | `wiki_nodes.summary/content` |
| 文件与目录关系 | Git 树 + source bindings |
| 横向功能关系 | `wiki_links` |
| Agent 私有经验 | `memory/<agent>` |
| 通用知识 | `knowledge` |

Project Wiki `content` 只解释“这个对象负责什么、如何关联、修改时注意什么”，不粘贴原文。

### 6.3 结构所有权

source-bound 项目的节点存在性、name、path、kind 和 source binding 由索引器拥有：

- 普通 Agent 可以更新其 summary/content/links，但不能用 Wiki tool 移动或删除 source-bound 节点。
- 新建、重命名和删除真实文件应由文件工具完成，并在 commit 后同步 Wiki。
- 对 source-bound 节点调用 `move/delete` 返回 `SOURCE_MANAGED`。
- 若未来确需项目内纯语义节点，再增加明确的 `origin=annotation` 类型；第一版不加入，避免破坏镜像的一致性。

### 6.4 Git commit 同步

成功 commit 或 main merge 后：

```text
commit succeeded
→ 获取 old indexed_revision 与 new HEAD
→ git diff --name-status -z old..new
→ pending → indexing
→ 在一个 Wiki transaction 中处理 add/modify/delete/rename
→ 更新受影响目录摘要候选和 source bindings
→ 更新 indexed_revision
→ 校验 links/FTS/foreign keys
→ synced
```

具体规则：

- add：创建缺失目录链和文件节点。
- modify：更新 blob OID、source revision，并标记语义摘要可能 stale。
- rename：保留内部 ID，移动节点并更新后代 materialized path。
- delete：将 source-bound 节点归档，默认不立即丢弃语义内容和 links。
- 空目录：Git 不跟踪空目录，因此没有独立节点。
- 同步失败：保留旧 `indexed_revision`，记录 `last_error`，项目根显示 `stale/failed`。
- rename swap/cycle：先把同批受影响 source binding/path 移到 transaction 内唯一临时名，再写最终路径，避免 SQLite UNIQUE 冲突。

当前 `WikiSkeletonService` 应重构为 `WikiProjectIndexer`；不再生成 `header/intent/structure` 前缀，也不再靠扫描时读取所有文件正文生成摘要。

`view="source"` 默认读取 `indexed_revision` 对应的 Git blob，保证 Wiki 与源码版本一致。UI 或编码场景若要读当前工作区，可显式选择 `source_view="workspace"`，返回 dirty/revision 状态并继续执行现有路径逃逸和符号链接检查。

## 7. 权限模型

### 7.1 Agent 配置

权限保存在 `AgentRecord`，而不是 Wiki 节点或 Wiki DB：

```ts
interface WikiGrant {
  scope: string;
  actions: Array<
    "expand" | "read" | "search" | "create" | "update" |
    "delete" | "link" | "unlink" | "move"
  >;
}

interface WikiContextEntry {
  address: string;
  profile: "compact" | "standard" | "deep";
  channel: "system" | "off";
  budgetTokens?: number;
}

interface AgentRecord {
  wikiGrants?: WikiGrant[];
  wikiContext?: WikiContextEntry[];
}
```

示例：

```json
{
  "wikiGrants": [
    {
      "scope": "wiki-root/knowledge",
      "actions": ["expand", "read", "search"]
    },
    {
      "scope": "memory://",
      "actions": ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"]
    },
    {
      "scope": "project://",
      "actions": ["expand", "read", "search", "update", "link", "unlink"]
    }
  ]
}
```

默认 grant 由 Agent template 明确写入，而不是在 Wiki 工具内隐藏授予。推荐模板默认值：

- 自己的 Memory：完整数据面权限。
- Knowledge：read/expand/search。
- active project：按角色授予；普通研究 Agent 只读，维护项目 Wiki 的 Agent 可 update/link。

### 7.2 编译与执行

`AgentService` 在创建 session 时：

1. 读取 Agent 已发布的 `wikiGrants`。
2. 使用当前 Agent/Project 的稳定业务 ID解析 `memory://` 和 `project://`。
3. 将逻辑地址或规范路径编译为 canonical scope。
4. 生成 `CompiledWikiAccess` 放入 `SessionConfig` 和 `CallerCtx`。

```ts
interface CompiledWikiGrant {
  canonicalScope: string;
  actions: WikiAction[];
}

interface CallerCtx {
  wikiAccess?: {
    agentId: string;
    activeProjectId?: string;
    grants: CompiledWikiGrant[];
    policyRevision: number;
  };
}
```

Wiki 工具不再接收 `wikiAnchorNodeIds`，也不允许模型在 input 中自报 agentId、projectId 或 scope。

### 7.3 授权规则

- scope 覆盖自身和后代，必须按路径段匹配，不能使用普通字符串前缀误匹配。
- 第一版仅 allowlist；多条 grant 的 actions 取并集。
- 不实现 discover、visibility、deny、节点 ACL 或节点权限继承。
- 深层 scope 不自动授予祖先访问；Prompt 应直接给 Agent 可用逻辑地址。
- 搜索先计算具有 `search` action 的 canonical scopes，再在这些 scopes 内查询和生成 snippet。
- 返回 links 时，对端不在任何可见 grant 中则不返回该 link。
- Work/Cron 只能提供 active project/context，不能扩大 Agent grants；effective access 始终来自已发布 Agent 配置。

错误规则必须在查节点内容前执行：

```text
没有任何 grant 覆盖 canonical path → NOT_FOUND
有 grant 覆盖，但缺少当前 action   → ACCESS_DENIED
有 action，数据库中没有节点         → NOT_FOUND
```

这样即使 Agent 猜到 `wiki-root/memory/other-agent`，也不能确认该节点是否存在。

### 7.4 UI 与管理调用

Wiki Browser 是管理员界面，不伪装成某个 Agent。REST host 为 UI 注入管理 authority，UI 不提交任意 `callerCtx` 或 grants。

### 7.5 Core 对象与 Wiki 的关系

`core.db` 是 Agent、Project、Work、Cron、Session 的事实源；`wiki.db` 不复制这些业务对象：

| Core 对象 | Wiki 关系 |
|---|---|
| Agent | `wiki-root/memory/<agent-id>`，grants/context 保存在 AgentRecord |
| Project | `wiki-root/projects/<project-id>`，`wiki_repositories.project_id` 是应用层软引用 |
| Work | 保存 agent/project/work 状态；不默认创建 Wiki 根，可携带逻辑地址 context |
| Cron | 指定运行 Agent及可选 Project/Work；不拥有独立 Wiki 权限 |

跨库不建立 foreign key。Agent/Project 创建与删除由管理 service 编排为幂等操作，并在 session build/startup diagnostics 修复缺失 root/binding。Work/Cron 只能缩小运行上下文，不能扩大 Agent 已发布 grants。第一版不创建 `works/` 或 `crons/` Wiki namespace；未来若需要查询 Work 产物关系，再单独设计可重建的 entity-reference 表。

## 8. Wiki 工具定义

### 8.1 保留单个 action tool

zero-core 已统一使用 action 型工具，故不必向模型注册九个独立 function。保留一个：

```text
Wiki(action, ...)
```

但 action 收敛为：

```text
expand, read, search, create, update,
delete, link, unlink, move
```

删除：

```text
createMemory, updateMemory,
docRead, docWrite, docEdit
```

Memory 由路径/namespace 表达；doc 操作合并到 read/update。

### 8.2 寻址

输入统一使用：

```text
node: "project://src/tools/wiki-tool.ts"
```

也接受规范路径：

```text
node: "wiki-root/projects/zero-core/src/tools/wiki-tool.ts"
```

不再接受 full nodeId、短 ID 或层级 title path。所有输出同时返回 canonical path 和当前 session 下的首选逻辑地址。

### 8.3 `expand`

```json
{
  "action": "expand",
  "node": "project://src/tools",
  "limit": 50,
  "cursor": null,
  "include_links": false
}
```

返回当前节点的 summary、直接 children 和分页游标，不返回长正文。children 在 SQL 层按授权过滤。

### 8.4 `read`

```json
{
  "action": "read",
  "node": "project://src/tools/wiki-tool.ts",
  "view": "content",
  "section": null,
  "line_start": null,
  "line_end": null,
  "source_view": "indexed"
}
```

`view`：

```text
summary, content, links, all, source
```

读取 source 时返回 repository ID、source path、revision、dirty 状态和内容范围。

### 8.5 `search`

```json
{
  "action": "search",
  "query": "AgentExecutor",
  "scope": "project://",
  "target": "both",
  "mode": "fulltext",
  "fields": ["name", "summary", "content"],
  "case_sensitive": false,
  "kinds": ["source_file"],
  "limit": 20,
  "cursor": null
}
```

`target`：`wiki | source | both`。  
`mode`：`exact | substring | glob | regex | fulltext | hybrid`。

实现建议：

- exact/substring：在授权后的 SQL 查询中执行；默认大小写不敏感。
- glob：由服务端按路径段实现 `*`、`**`、`?`，不直接等同 SQL LIKE。
- fulltext：使用 FTS5，先加入授权 scope 条件再生成 snippet。
- source：复用 ripgrep，cwd 固定为已绑定 checkout，scope 转为允许的仓库相对目录。
- regex：源码使用 ripgrep；Wiki 正文第一版在授权且有上限的候选集上执行安全 worker，并限制 pattern 长度、候选数和总时间。不要直接在主线程对全库使用 JavaScript RegExp。
- hybrid：先融合 path/title/FTS/source 结果；Embedding 留作未来扩展。

第一版 regex 默认硬上限：pattern 2,048 UTF-8 bytes、授权候选 50,000、输入正文总量 16 MiB、worker wall time 250 ms、返回结果 200。测试可通过依赖注入缩短 timeout，但生产值只能由 host 配置收紧。分别返回 `REGEX_INVALID/REGEX_LIMIT_EXCEEDED/REGEX_TIMEOUT`。

Hybrid 排序固定为 `(match_type_rank ASC, normalized_score DESC, canonical_path ASC, target ASC)`；rank 枚举和 score 归一化函数属于共享契约，不能依赖数据库内部 ID 破同分。

FTS5 `unicode61` 不能覆盖所有 Unicode case folding。中文不受大小写影响；若后续需要完整国际化大小写规则，再接 ICU tokenizer 或规范化 shadow column。

### 8.6 `create`

```json
{
  "action": "create",
  "parent": "memory://",
  "name": "failed-approaches",
  "summary": "已验证无效的方案与原因。",
  "content": "",
  "attributes": {
    "memory_type": "experience",
    "durability": "long_term"
  },
  "request_id": "..."
}
```

校验 parent 的 create grant、同级名称、规范路径和近似重复项。source-bound Project 子树不允许普通 Agent 用 create 改变镜像结构。

### 8.7 `update`

字段更新：

```json
{
  "action": "update",
  "node": "memory://failed-approaches",
  "expected_revision": 18,
  "changes": {
    "summary": "...",
    "attributes": {
      "durability": "permanent",
      "review_after": null
    }
  }
}
```

局部正文更新：

```json
{
  "action": "update",
  "node": "memory://failed-approaches",
  "expected_revision": 18,
  "operations": [
    {
      "op": "replace_text",
      "old_text": "旧内容",
      "new_text": "新内容",
      "expected_occurrences": 1
    }
  ]
}
```

第一版支持：

```text
replace_text, insert_before, insert_after,
append, prepend, replace_section,
append_to_section, delete_section
```

在内存中读取单行 TEXT、修改后同一事务写回是可接受的；不需要立即引入 sections 表。错误码：

```text
EDIT_TARGET_NOT_FOUND
EDIT_TARGET_AMBIGUOUS
WRITE_CONFLICT
```

Section 使用 CommonMark AST（项目显式依赖 `unified/remark-parse` 或等价直接依赖），同时识别 ATX 与 Setext heading。一个 section 从目标 heading 开始，到下一个同级或更高级 heading 前结束；fenced code 内的 `#` 不是 heading。同名匹配必须通过 `level/occurrence` 消歧，否则返回 `EDIT_TARGET_AMBIGUOUS`。

### 8.8 `link/unlink`

```json
{
  "action": "link",
  "source": "project://src/tools/wiki-tool.ts",
  "target": "project://tests/unit/p3-management-tools.test.ts",
  "relation": "tested_by"
}
```

工具检查 source 的 link 权限和 target 的可见性，然后只写一条 `wiki_links` 记录。backlink 通过 target index 查询。

### 8.9 `move/delete`

- `move` 在事务中更新自身与后代 materialized path，links 和静态逻辑地址保持不变。
- 只有被直接移动的根节点 revision +1；后代 path 是派生更新，后代 revision/updated_at 不变。change event 必须携带 subtree 的 `oldPath/newPath`。
- 普通 Agent move 默认最多 10,000 个节点，超限返回 `MOVE_TOO_LARGE`；Git indexer/管理异步任务可使用受控内部批量路径并记录耗时/WAL。
- 规范路径型 grants 不自动改写；管理面返回受影响 Agent 列表供管理员确认。
- `delete` 默认归档整棵子树；所有后代同时标记 archived，active partial unique index 允许未来重建同路径节点。
- 有 children、incoming links、逻辑地址或 source binding 时拒绝硬删除。
- source-bound Project 节点只能由 Git 同步移动/归档。

### 8.10 ToolResult

`wiki-tool.ts` 不再主要返回拼好的长文本：

```ts
type WikiToolData =
  | WikiExpandResult
  | WikiReadResult
  | WikiSearchResult
  | WikiMutationResult;

ToolResult<WikiToolData>
```

`format(result)` 再为 Agent 生成紧凑 Markdown；REST/UI 直接消费 JSON。mutation 返回的 `auditId` 是可公开的 opaque operation receipt（`wiki_audit_log.audit_id`），不属于被禁止暴露的 node/link/source 整数 ID。

第一版共享错误码闭集：

```text
INVALID_REQUEST, INVALID_PATH, INVALID_NAME,
INVALID_ADDRESS, ADDRESS_UNRESOLVED,
NOT_FOUND, ACCESS_DENIED, ALREADY_EXISTS,
WRITE_CONFLICT, EDIT_TARGET_NOT_FOUND, EDIT_TARGET_AMBIGUOUS,
SOURCE_MANAGED, SOURCE_UNAVAILABLE, SYNC_FAILED,
REGEX_INVALID, REGEX_LIMIT_EXCEEDED, REGEX_TIMEOUT,
HARD_DELETE_BLOCKED, MOVE_TOO_LARGE, INTERNAL_ERROR
```

后续阶段只能引用该 union；新增 code 必须先更新设计、共享契约和所有相关 acceptance，不能由某个 sub 静默扩展。

## 9. Prompt 与上下文注入

### 9.1 解耦权限与注入

当前 `wiki-anchor-injection.ts` 将 anchor 同时用于：

- 决定可读写子树；
- 决定注入 system/context；
- 生成短 ID 导航。

新系统拆为：

```text
wikiGrants  → 只决定工具权限
wikiContext → 只决定 Prompt 内容和预算
addresses   → 只决定 Agent 使用的逻辑地址
```

`wiki-anchor-injection.ts` 应由 `wiki-context-compiler.ts` 取代。

### 9.2 推荐注入内容

默认 `standard` profile：

```text
## Wiki Context

Available addresses:
- memory://  → your long-term memory
- project:// → active project semantic map

### Agent Memory
- Memory 根 summary/content 中的稳定规则
- durability=permanent/long_term 的高价值记忆
- preference/procedure/experience 的代表节点
- 最近更新且与当前 Agent 职责相关的节点
- 一级导航及必要的二级候选

### Active Project
- 项目目标、版本、技术栈与同步状态
- 入口和主要模块
- 根目录与关键目录 summary
- capabilities / constraints / risks / recent changes
- 与当前 work/requirement 相关的节点候选

### Retrieval guidance
先 search 定位，再 expand 了解结构，最后 read 正文或 source。
```

建议默认预算：

| 内容 | compact | standard | deep |
|---|---:|---:|---:|
| Memory | 800 | 1,800 | 3,500 tokens |
| Project | 1,200 | 2,800 | 5,000 tokens |
| 地址与使用指导 | 300 | 400 | 500 tokens |

预算是上限，不要求填满。完整历史、低置信度 hypothesis、过期 task_state、长正文和整棵项目树不固定注入。

截断顺序固定为：地址/检索指引 → 根稳定规则 → permanent/long_term preference/procedure → Project 目标/约束/sync → 当前 work 相关候选 → 近期高价值节点 → 导航补充。每类内部使用稳定 tuple（显式 priority、durability、confidence、updated_at、canonical path），并输出 dropped count/token 统计。

### 9.3 编译与缓存

`AgentService` 在 session 创建或 active project 改变时编译 Wiki system section。它把 `{name, compute, cacheBreak}` 作为通用 dynamic system section 放入 SessionConfig；`AgentLoop` 只消费通用 sections，不得 import Wiki compiler/store，也不得出现 Wiki 专用 section 字面量或 `promptAssembler.invalidate("wiki-...")`：

- 保存 `addressRevision`、`policyRevision`、节点 revision 快照。
- section 保持 `cacheBreak: false`，兼容当前 prefix cache。
- 普通 Wiki 写入不在同一 turn 中重算 Prompt。
- Memory 归档完成、用户显式 refresh、Agent 配置发布或项目切换由 AgentService config-sync 通道排队。
- 空闲 session 可立即交换 compiled snapshot；busy session 只在 `StepEnd` hook 后的安全边界应用。地址/grants/context policy 发布不能改变在途工具调用使用的 `CompiledWikiAccess`。
- `PostTurnComplete` 已删除，任何实现和验收不得引用它。
- runtime wiring 测试必须从正式 AgentService/session 入口证明 compiler 被调用、section 被组装和安全边界刷新，不能只直接测试 compiler 形成 dead-path 假阳性。

工具自身 prompt 应删除关于 `#xxxxxxxx`、`docRead/docWrite/docEdit`、header/intent 和 pure-anchor scope 的长说明，改成简短的 action 说明与 `search → expand → read` 工作流。

## 10. REST、IPC 与服务层

### 10.1 服务分层

建议新增：

```text
WikiDatabase
├── WikiNodeRepository
├── WikiLinkRepository
├── WikiAddressResolver
├── WikiAuthorizationService
├── WikiSearchService
├── WikiProjectIndexer
└── WikiContextCompiler
```

不要继续用通用 `SqliteStore<T>` 实现核心 Wiki 写操作，因为 move、links、FTS、revision、审计和项目同步都需要多表事务。

### 10.2 UI API

路径包含 `/`，不宜继续放在 `:nodeId` 路由参数。统一使用 POST body：

| Endpoint | 用途 |
|---|---|
| `POST /api/wiki/expand` | 直接 children + cursor |
| `POST /api/wiki/read` | summary/content/links/source |
| `POST /api/wiki/search` | 结构化搜索 |
| `POST /api/wiki/create` | 创建节点 |
| `POST /api/wiki/update` | revision 更新 |
| `POST /api/wiki/delete` | 归档/删除 |
| `POST /api/wiki/link` | 建立关系 |
| `POST /api/wiki/unlink` | 删除关系 |
| `POST /api/wiki/move` | 移动/重命名 |
| `POST /api/wiki/context/preview` | Prompt 预览 |

管理 API 单独放置：

```text
/api/wiki-admin/addresses/*
/api/wiki-admin/repositories/*
/api/wiki-admin/grants/*
/api/wiki-admin/context/*
/api/wiki-admin/reindex/*
```

`ipc-proxy.ts` 和 `preload-types.ts` 暴露结构化 request/response，不再使用旧 `wikiGetChildren(nodeId)`、`wikiReadDetail(nodeId)` 和 legacy `/api/project-wiki` CRUD。

### 10.3 数据变更通知

继续使用 `data:changed`，collection 改为 `wiki_nodes/wiki_links/wiki_sync`。事件至少包含：

```json
{
  "path": "wiki-root/projects/zero-core/src/tools/wiki-tool.ts",
  "old_path": null,
  "parent_path": "wiki-root/projects/zero-core/src/tools",
  "op": "update",
  "revision": 19
}
```

前端只失效已加载的相关 branch、detail 和 relation cache，不全量重拉。

## 11. UI 改造

### 11.1 Wiki Browser

保留当前三栏/两栏懒加载思路，修改为：

- 左侧以 canonical path 为 key，支持 logical address scope 选择。
- 顶部 scope：Global、Knowledge、某 Agent Memory、某 Project、自定义逻辑地址。
- 节点 breadcrumb 显示首选逻辑地址和 canonical path。
- 节点图标由 kind/source binding 决定，不再依赖 header/intent/structure。
- archived 节点默认隐藏，可由管理员打开。

### 11.2 搜索 UI

搜索栏增加：

- target：Wiki / Source / Both。
- mode：Full-text / Substring / Glob / Regex / Exact。
- case sensitive。
- fields、kind、scope 与 limit。
- 结果显示 matched field、snippet、score、source revision 和逻辑地址。

点击 source 结果时定位对应 Wiki 节点并打开 Source tab，而不是只显示平铺节点标题。

### 11.3 节点详情

`WikiDetail` 改为 tabs：

```text
Overview | Content | Relations | Source | History
```

- Overview：summary、kind、revision、attributes、sync 状态。
- Content：使用现有 `react-markdown + remark-gfm` 渲染；编辑时发送 expected_revision 和局部/整段 patch。
- Relations：incoming/outgoing 分组，支持 link/unlink。
- Source：显示 indexed/workspace 版本、路径、代码范围和 stale/dirty 提示。
- History：审计记录和 revision。

source-bound 节点的 move/delete/create 控件禁用并解释“结构由 Git 管理”。

### 11.4 Agent Editor

删除当前 `WikiAnchorsSection`，替换为两个概念清晰的区块：

1. **Wiki Access**
   - 每行：scope/address + action chips。
   - 支持 `memory://`、`project://` 和管理员静态 alias 的编译预览。
   - 显示编译后的 canonical scopes。
   - 检测无效地址、重复 grant 和危险的 `wiki-root` 全权。

2. **Wiki Context**
   - address、profile、channel、token budget。
   - 显示真实 Prompt preview 和 token 估算。
   - Memory/Project 默认项可编辑，但与 access 分开。

`PermissionsSection` 仍管理文件系统 readScope/executionMode；Wiki grants 可在独立 Wiki section 中编辑，避免把两类权限混在一张表里。

### 11.5 Project 与管理 UI

Project 页面增加 Wiki 索引卡片：

- repository/project binding。
- workspaceDir（来自 ProjectRecord，只读显示）。
- branch、indexed revision、HEAD、sync status、last error。
- Reindex、Validate、Open Wiki。

Wiki Settings 增加 Logical Addresses 管理页：

- 地址、类型、target/resolver、scope、Prompt policy、revision。
- create/update/delete 前预览受影响的 Agent context。
- 动态地址 resolver 只允许系统白名单。

UI 管理调用由 server 注入 admin authority，不把管理 action 暴露给普通 Wiki tool。

## 12. 代码修改清单

| 文件/模块 | 修改方向 |
|---|---|
| `src/server/database/*` | Plan 00：统一 DB paths/lifecycle，`CoreDatabase` 取代 `SessionDB`，删除退役 `knowledge.db` |
| `src/server/wiki-node-store.ts` | 重写为独立 Wiki DB repository/service；删除磁盘正文、短 ID 和 anchor-scope 方法 |
| `src/server/core-database.ts` | 不再承载新 Wiki 表；保存 Agent/Project/Work/Cron/Session 等 Core 业务数据 |
| `src/server/db-migration.ts` | 不新增旧 Wiki 迁移；新 Wiki schema 由 `WikiDatabase` 独立初始化 |
| `src/shared/types.ts` | 新增 WikiNodeView、WikiLink、WikiGrant、WikiContext、结构化 request/result；删除旧 WikiNode 兼容字段 |
| `src/server/project-wiki-store.ts` | 删除兼容层 |
| `src/server/project-wiki-router.ts` | 删除 legacy CRUD router |
| `src/server/wiki-router.ts` | 改为结构化 data/admin API，并注入 UI authority |
| `src/server/wiki-skeleton-service.ts` | 重构/更名为 `wiki-project-indexer.ts`，基于 Git tree/diff 镜像全部 tracked 路径 |
| `src/server/wiki-scan-cursor-store.ts` | 游标并入 `wiki_repositories.indexed_revision`，删除独立旧 cursor |
| `src/server/wiki-operations.ts` | 更新 enrich/rebuild/commit prompt 与调用，使用规范路径和新 indexer |
| `src/tools/wiki-tool.ts` | 新 action schema、逻辑地址、grants、结构化 ToolResult、FTS/source search、revision update |
| `src/tools/types.ts` | `CallerCtx.wikiAccess` 取代 `wikiAnchorNodeIds` |
| `src/tools/wiki-path-guard.ts` | 从阻止磁盘 Markdown 改为阻止 Agent 直接访问 `wiki.db/backups/.runtime` |
| `src/runtime/wiki-anchor-injection.ts` | 删除；compiler 位于 server Wiki 层，由 AgentService 注入通用 system section |
| `src/runtime/types.ts` | `wikiGrants/wikiContext/compiled access` 取代 `wikiAnchors` |
| `src/runtime/agent-loop.ts` | 仅消费通用 dynamic system sections 与 CallerCtx compiled access；删除 Wiki import、字面 section 和 anchor 重解析 |
| `src/server/agent-store.ts` | round-trip `wikiGrants` 与 `wikiContext` |
| `src/server/agent-service.ts` | 编译 grants/context、处理 hot update 与 active project 变化 |
| `src/server/template-store.ts` | 模板改用新 grants/context；Archivist prompt 删除 header/intent/short-ID 指令 |
| `src/server/index.ts` | 初始化 WikiDatabase/services，挂新 routers，移除 ProjectWikiStore |
| `src/main/ipc-proxy.ts` | 替换 legacy Wiki ROUTE_MAP |
| `src/shared/preload-types.ts` | 暴露结构化 Wiki/Admin API |
| `src/renderer/store/wiki-store.ts` | path-keyed lazy cache、分页、搜索筛选、relations/source/history cache |
| `src/renderer/components/wiki/*` | 新 Browser、Search 和 Detail tabs |
| `src/renderer/components/agents/WikiAnchorsSection.tsx` | 删除，拆为 WikiAccessSection 与 WikiContextSection |
| `src/renderer/components/agents/AgentEditor.tsx` | 接入 grants/context 与 preview |

同时更新所有依赖旧 WikiStore 的 PM、memory archive、enrichment、archivist 与测试代码。Memory 写入统一使用新 Wiki service/tool，不再使用 `createMemory/updateMemory` 专用分支。

## 13. 无迁移切换方案

本设计明确不迁移旧数据，因此实现阶段采用 clean cutover：

1. Plan 00 将活动主库切换为 `db/core.db`，删除退役 `knowledge.db`。
2. 新增独立 `db/wiki.db` 和新 service，不读取 `core.db.project_wiki`。
3. 初始化固定根、现有 Agent Memory 根和现有 Project 根。
4. 用新 `WikiProjectIndexer` 从各项目 Git revision 全量重建 Project Wiki。
5. Knowledge 与 Memory 从空树开始。
6. 切换 Wiki tool、Prompt、REST/IPC 和 UI 到新 service。
7. 删除运行时对 `ProjectWikiStore`、旧 anchors 和磁盘正文的引用。
8. 旧 `project_wiki` 表和 `~/.zero-core/wiki` 旧 Markdown 仅作为停止使用的遗留物；只能由显式维护命令清理，启动不得静默删除。

不实现：

- 旧表到新表的数据搬迁。
- 双读、双写或兼容 fallback。
- UUID/短 ID 到 canonical path 的转换接口。
- 旧 `wikiAnchors` 到 grants/context 的自动转换。

## 14. 实施阶段

实施与 `docs/plan/wiki-system-redesign/README.md` 一一对应：

| Phase | 所有权与主要 contract |
|---|---|
| 00 Database Foundation | `db/core.db`、DatabaseManager、旧 Core 安全切换、删除 `knowledge.db` |
| 01 Database & Contracts | WikiDatabase、DDL、path、closed kind/error/view、repository/FTS/audit |
| 02 Core Service | WikiService 签名、address resolver、compiled grants、CRUD/edit/move/archive |
| 03 Project Mirror | repository binding、Git tree/diff、source read/search、sync 触发 |
| 04 Tool & Search | flat Wiki action schema、CallerCtx contract、结构化结果、regex worker/hybrid ranking |
| 05 Runtime & Prompt | AgentRecord round-trip、正式 tool 接线、server compiler、StepEnd 安全边界 |
| 06 Data API & Browser | 合并两套 IPC、path-keyed store、Browser/Search/Detail、change event |
| 07 Management UI | address/repository/grant/context 管理与发布、真实 preview |
| 08 Cutover & Hardening | 删除全部 legacy、DB 保护/备份/性能、文档和 release gate |

阶段间不做旧 Wiki 数据兼容；每一阶段在开发分支上使用新空 Wiki DB。阶段产物的 TypeScript contract 必须由拥有阶段先落地，后续阶段只能消费，不能静默重定义。

## 15. 测试与验收标准

### 15.1 核心数据

- 百万级节点下，按 path read、parent expand、backlink 和分页查询不全表扫描。
- rename/move 后内部 links 和静态逻辑地址仍有效。
- revision 冲突稳定返回 `WRITE_CONFLICT`。
- FTS 与 nodes 在事务失败时不会出现半更新。
- `PRAGMA integrity_check` 与 `foreign_key_check` 通过。

### 15.2 权限

- Agent 只能访问 grants 覆盖的 canonical scopes/actions。
- 猜测其他 Agent Memory 路径只得到 `NOT_FOUND`。
- 缺 action 但 scope 已授权时得到 `ACCESS_DENIED`。
- 搜索不能通过结果数、snippet、links 或排序泄露未授权节点。
- LLM 输入不能覆盖 caller agent、active project 或 compiled grants。

### 15.3 项目同步

- 每个 tracked 文件和推导目录都有唯一 source-bound 节点。
- commit rename 保留节点 ID、summary/content 和 links。
- Wiki 不保存源码或 repo 文档全文。
- indexed revision 落后时 Prompt、UI 和 read result 均显示 stale。
- sync 失败不推进 revision，也不留下半棵新树。

### 15.4 工具与搜索

- expand 不返回长正文。
- read 支持 summary/content/section/source 范围读取。
- update 的 exact replacement 能区分 not found、ambiguous 和 conflict。
- search 支持大小写不敏感、glob、regex、FTS 和 source/both。
- regex 有 pattern、候选、时间和结果上限。
- Agent tool output 不出现数据库 ID、旧 prefix 或短 ID。

### 15.5 Prompt 与 UI

- 默认 standard 注入包含丰富 Memory/Project manifest，但不超过预算。
- grants 与 context 改动分别预览，互不隐式改变。
- UI 懒加载，不因一次变更重拉整棵树。
- Markdown、relations、source、history 均能独立加载。
- source-bound 节点的结构操作在 UI 和服务端都被阻止。

## 16. 后续考虑

第一版不应提前实现，但接口需预留：

- Embedding 与 graph-aware hybrid ranking。
- 超大且频繁局部编辑正文的 `wiki_sections` 表。
- 附件解析、OCR 和附件全文索引。
- ICU tokenizer/Unicode normalization shadow columns。
- 多 repository 项目和 monorepo source roots。
- 逻辑地址与 Prompt policy 的版本发布、回滚和 session pinning。
- grants 在节点 move 后的影响分析与管理员批量迁移。
- Memory 置信度衰减、review_after、合并和归档策略。
- SQLite Backup API/VACUUM INTO snapshot、可选本地 Git 备份和 JSONL 变更日志。
- 项目能力索引和 symbol/call graph；它们应是可重建关系或 attributes，不建立第二套文档树。

## 17. 实施前需要确认的默认决策

本文已采用以下推荐默认值，若没有新的产品要求，可直接按此实现：

1. 活动数据库统一为 `${ZERO_CORE_DIR}/db/core.db` 与独立 `${ZERO_CORE_DIR}/db/wiki.db`；退役 `knowledge.db` 直接删除。
2. source-bound Project 节点的结构完全由 Git indexer 管理，普通 Wiki tool 不能 create/move/delete 它们。
3. Agent template 显式提供 grants；系统不在工具内部暗中授予 active project 写权限。
4. Prompt 使用 `standard` profile，Memory 与 Project 均注入比当前一层 anchor 更丰富的 manifest。
5. 旧 Wiki 数据不迁移、不双写；新系统从空 Knowledge/Memory 和重建 Project Wiki 开始。
6. Agent/Project 根使用稳定业务 ID 路径段，重命名只更新 `attributes.display_name`。
