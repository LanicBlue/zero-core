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
│   └── <agent-name>
└── projects
    └── <project-name>
```

核心结论：

- Wiki 数据统一存入独立的 `wiki.db`，正文不再拆到磁盘 Markdown 文件。
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
| 存储 | `project_wiki` 表保存元数据，正文位于 `~/.zero-core/wiki` | 独立 `wiki.db` 保存节点、正文、链接、地址、索引和审计 |
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

建议将 Wiki 从主 `sessions.db` 中分离：

```text
${ZERO_CORE_DIR}/wiki/
├── wiki.db
├── attachments/
├── backups/
├── changes/             # 可选 JSONL 审计导出
└── .runtime/
```

单独数据库的理由：

- Wiki 可能增长到十万或百万节点，不应放大 session/message 数据库的 WAL、备份和维护成本。
- FTS、项目重建和 Wiki snapshot 可以独立执行。
- 旧 `project_wiki` 可以完全停止使用，不需要改造主数据库中的旧表。
- Wiki 备份、完整性检查和未来导入导出有清晰边界。

`WikiDatabase` 使用单独的 `better-sqlite3` 连接，启用：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

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

创建 Agent 时，由管理服务幂等创建：

```text
wiki-root/memory/<agent-name>
```

系统只固定 Memory 根，不规定 `preferences/lessons/tasks` 等子树。Agent 根据自己的长期记忆动态创建、移动和合并子节点。删除 Agent 时默认归档 Memory 根，而不是级联硬删除。

注册项目时，由项目管理服务创建：

```text
wiki-root/projects/<project-name>
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

节点 `name` 是路径最后一段，也是默认展示名。当前 `title` 字段应删除；确有展示名需求时使用 `attributes.display_name`：

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
    path            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL DEFAULT 'node',
    summary         TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    attributes_json TEXT,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    archived_at     TEXT,

    UNIQUE(parent_id, name),
    CHECK(attributes_json IS NULL OR json_valid(attributes_json)),
    FOREIGN KEY(parent_id) REFERENCES wiki_nodes(id) ON DELETE RESTRICT
);

CREATE INDEX idx_wiki_nodes_parent ON wiki_nodes(parent_id);
CREATE INDEX idx_wiki_nodes_kind ON wiki_nodes(kind);
CREATE INDEX idx_wiki_nodes_archived ON wiki_nodes(archived_at);
```

`summary` 和 `content` 分开保留，但物理上都位于 SQLite：

- `summary`：expand、搜索结果和 Prompt 注入使用。
- `content`：Markdown 正文，按需 read。
- `revision`：乐观并发控制。
- `attributes_json`：Memory 属性、来源状态、显示名等非通用字段。

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

- 静态地址：`runtime://` 指向某个内部节点 ID。
- 动态地址：`memory://`、`project://` 由当前 session 解析。
- 规范路径：不需要注册，始终可由 resolver 直接处理。

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

通过 trigger 或显式 store transaction 保证 `wiki_nodes` 和 FTS 同步。索引属于可重建数据。

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
wiki-root/projects/zero-core
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
      "scope": "wiki-root/memory/${agent_id}",
      "actions": ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"]
    },
    {
      "scope": "wiki-root/projects/${active_project}",
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
2. 展开 `${agent_id}` 和 `${active_project}`。
3. 将逻辑地址或模板路径规范化为 canonical scope。
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

错误规则必须在查节点内容前执行：

```text
没有任何 grant 覆盖 canonical path → NOT_FOUND
有 grant 覆盖，但缺少当前 action   → ACCESS_DENIED
有 action，数据库中没有节点         → NOT_FOUND
```

这样即使 Agent 猜到 `wiki-root/memory/other-agent`，也不能确认该节点是否存在。

### 7.4 UI 与管理调用

Wiki Browser 是管理员界面，不伪装成某个 Agent。REST host 为 UI 注入管理 authority，UI 不提交任意 `callerCtx` 或 grants。

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
    "summary": "..."
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
- 规范路径型 grants 不自动改写；管理面返回受影响 Agent 列表供管理员确认。
- `delete` 默认归档。
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

`format(result)` 再为 Agent 生成紧凑 Markdown；REST/UI 直接消费 JSON。错误使用稳定 code + message，不靠字符串正则识别。

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

### 9.3 编译与缓存

`AgentService` 在 session 创建或 active project 改变时编译 `wiki-context` section：

- 保存 `addressRevision`、`policyRevision`、节点 revision 快照。
- section 保持 `cacheBreak: false`，兼容当前 prefix cache。
- 普通 Wiki 写入不在同一 turn 中重算 Prompt。
- Memory 归档完成、用户显式 refresh、Agent 配置发布或项目切换时使 section 失效。
- 地址/grants/context policy 发布后，现有 session 在安全边界重编译；不能让一次工具调用中途改变地址语义。

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
   - 支持 `${agent_id}`、`${active_project}` 模板预览。
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
| `src/server/wiki-node-store.ts` | 重写为独立 Wiki DB repository/service；删除磁盘正文、短 ID 和 anchor-scope 方法 |
| `src/server/session-db.ts` | 不再承载新 Wiki 表；只保留 Agent/Project 等业务数据 |
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
| `src/runtime/wiki-anchor-injection.ts` | 由 `wiki-context-compiler.ts` 替代 |
| `src/runtime/types.ts` | `wikiGrants/wikiContext/compiled access` 取代 `wikiAnchors` |
| `src/runtime/agent-loop.ts` | 注入新 wiki-context section；buildCallerCtx 传 compiled access；删除 anchor 重解析 |
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

1. 新增独立 `wiki.db` 和新 service，不读取 `project_wiki`。
2. 初始化固定根、现有 Agent Memory 根和现有 Project 根。
3. 用新 `WikiProjectIndexer` 从各项目 Git revision 全量重建 Project Wiki。
4. Knowledge 与 Memory 从空树开始。
5. 切换 Wiki tool、Prompt、REST/IPC 和 UI 到新 service。
6. 删除运行时对 `ProjectWikiStore`、旧 anchors 和磁盘正文的引用。
7. 旧 `project_wiki` 表和 `~/.zero-core/wiki` 旧 Markdown 仅作为停止使用的遗留物；确认新版本稳定后再通过显式维护命令清理，启动迁移不得静默删除。

不实现：

- 旧表到新表的数据搬迁。
- 双读、双写或兼容 fallback。
- UUID/短 ID 到 canonical path 的转换接口。
- 旧 `wikiAnchors` 到 grants/context 的自动转换。

## 14. 实施阶段

### Phase 1：核心存储

- `WikiDatabase`、DDL、repositories、links、FTS、audit。
- path normalizer、address resolver、authorization service。
- 节点 CRUD、revision、局部编辑和事务测试。

### Phase 2：项目镜像

- `WikiProjectIndexer` 全量 Git tree 建图。
- Git diff 增量 add/modify/delete/rename。
- source read/search、sync 状态和 commit hook。

### Phase 3：Wiki tool

- 新 action schema 和结构化结果。
- search modes、link/move/delete 约束。
- 删除 memory/doc 专用 action 与短 ID。

### Phase 4：权限与 Prompt

- AgentRecord grants/context。
- Session compile、CallerCtx、授权错误语义。
- 新 Context Compiler、preview 和缓存失效。

### Phase 5：API 与 UI

- 新 REST/IPC/preload。
- path-keyed lazy browser、advanced search、detail tabs。
- Agent Access/Context、Project Sync、Address Admin UI。

### Phase 6：旧实现清理

- 删除 legacy ProjectWikiStore/router、anchor injection 和旧测试。
- 删除运行时对磁盘 Wiki 正文的依赖。
- 文档更新和 explicit legacy cleanup 命令。

阶段间不做旧数据兼容；每一阶段在开发分支上使用新空 Wiki DB。

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

1. Wiki 使用独立 `${ZERO_CORE_DIR}/wiki/wiki.db`，不继续写 `sessions.db.project_wiki`。
2. source-bound Project 节点的结构完全由 Git indexer 管理，普通 Wiki tool 不能 create/move/delete 它们。
3. Agent template 显式提供 grants；系统不在工具内部暗中授予 active project 写权限。
4. Prompt 使用 `standard` profile，Memory 与 Project 均注入比当前一层 anchor 更丰富的 manifest。
5. 旧 Wiki 数据不迁移、不双写；新系统从空 Knowledge/Memory 和重建 Project Wiki 开始。
