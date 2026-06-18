# Plan P1 — wiki 存储分离 + 多锚点

> **依赖**:P0(wiki_nodes.links 列、AgentRecord.wikiAnchors 已就位)。
> **对应规范**:§10。**验收**:`acceptance-P1.md`。
> **文件**:`src/server/wiki-node-store.ts`、`src/server/db-migration.ts`、`src/runtime/context-message.ts`、`src/runtime/prompt-sections.ts`、`src/runtime/agent-loop.ts`、`src/server/session-context-router.ts`、agent 工具层(FS 工具拦截)。

**为什么在 P0 后**:多锚点权限 + 注入都建在 wiki 节点结构上;正文移磁盘要先有 links 列(P0)。这层立了,P2 的 memory 合并、P3 的 Wiki 工具才有地方落。

## 设计细节要求

### 存储:结构/内容分离(§10.1)

1. wiki 正文从 DB `detail` 列迁到磁盘 `~/.zero-core/wiki/<path>.md`。WikiStore 读写正文改走文件(读 = 读 .md;写 = 写 .md)。DB 行只存结构:`id/parentId/path/title/summary/docPointer/links/flags/timestamps`。
2. `docPointer` 语义 = **节点自己的正文文件路径**(代码内部定位用),**不向 agent 暴露**(agent 不感知)。
3. **去 `detail` 列 + 去 `type` 列**(P0 留的):migration 把现有 `detail` 内容导出到对应 .md 文件后删列;`type` 列删除,位置即类型(§10.4)。
4. migration 按原 `type` 决定节点归位:`header/intent/structure/project` → `projects/<projectId>/` 下;`memory` → `memory/<agentId>/`(legacy memory 节点需映射到某 agent,无主的归全局或弃)。
5. 磁盘镜像:`~/.zero-core/wiki/{knowledge,projects,memory}/...`,按 node.path 组织目录。

### FS 隔离(§10.1)

6. agent 工具层(Shell/Read/Grep/Glob/Write/Edit)禁止访问 `~/.zero-core/wiki/`:在工具执行前拦截,路径匹配 wiki 根则 reject。wiki 正文只走 wiki 工具。
7. 路径不向 agent 暴露(wiki 工具用 nodeId,不用文件路径)。

### 多锚点权限(§10.3)

8. 废 `assertNodeInsideProjectScope`(type-based 守卫)。session 锚点 = 自动(memory/<agentId> + project=wiki-root:<projectId>) ∪ 自由(AgentRecord.wikiAnchors)。
9. store 层读+写守卫统一改为「目标节点在 caller 任一锚点子树内」——复用 `listVisibleFromRoot`/`getVisible` 的子树可见性逻辑,扩展为多锚点并集。
10. zero 特殊:无 project 锚点 → 靠 memory 锚点 + 自由锚点(全局根 wiki-root:global)。

### 锚点注入(§10.6 / §10.3.1)

11. 每锚点按 `inject`(system/context/off)走对应通道:
    - system → `SystemPromptAssembler`(`prompt-sections.ts`)的 section,可缓存,子树变再刷新。
    - context → PreLLMCall hook(`context-message.ts` `buildContextMessage`),每轮重算,不入 message history。
12. **注入内容按锚点类型**:
    - project 锚点 → 子树前 2 层 title+summary(不带正文);`depth` 可配默认 2。
    - memory 锚点 → **索引**(MEMORY.md 式:每条 title + nodeId 链接,不展开内容)。
13. 自动锚点运行时派生:memory 锚点 nodeId = `memory/<agentId>`;project 锚点 nodeId = `wiki-root:<projectId>`(从 session context.projectId)。

## 风险

- **detail 迁移到磁盘**:现有 dev 库 wiki 节点有 detail 内容,删列前必须导出成文件,否则数据丢。migration 要「先导出后删列」。
- **type 去除后的归位**:legacy memory 节点没有 agentId 归属(旧 schema 按 role),映射可能丢;非空库告警留人工(契约 1.2)。
- **FS 隔离误伤**:wiki 根路径判定要准,别把项目 workspaceDir 误拦(workspaceDir 不在 ~/.zero-core/wiki 下,正常不冲突,但要测)。
- **多锚点并集性能**:每次注入算多锚点子树展开,大项目可能慢;2 层截断 + 缓存(system 类)缓解。

## 不在本阶段

- subagents 委派、agent-as-tool 废除、memory 合并逻辑(提取者写 wiki)→ **P2**。
- Wiki action 工具(expand/read/upsert/search)→ **P3**。
- knowledge/software-dev seed 节点 → **P6**(本阶段树结构就绪即可)。
