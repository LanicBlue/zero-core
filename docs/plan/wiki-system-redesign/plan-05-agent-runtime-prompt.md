# Plan 05：Agent 配置、运行时与 Prompt

## 目标

把新 Wiki 工具正式接入 Agent runtime：AgentRecord 保存 grants/context，Session 编译权限，CallerCtx 注入身份，Prompt 编译丰富 Memory/Project manifest，并原子替换旧 anchor/tool 路径。

## 依赖

- Acceptance 01–04 已通过。

## 实施范围

### 1. AgentRecord 与存储

新增并 round-trip：

```ts
wikiGrants?: WikiGrant[];
wikiContext?: WikiContextEntry[];
wikiPolicyRevision?: number;
```

更新：

- `src/shared/types.ts`
- `src/server/agent-store.ts`
- `src/server/db-migration.ts` 的 agents 列定义/fresh DB 自愈
- `src/renderer/components/agents/agent-editor-types.ts`
- template import/export 类型

这只是 Agent 配置 schema 迁移，不是旧 Wiki 数据迁移。不得把旧 `wikiAnchors` 自动转换为 grants/context；字段可留到 Plan 08 删除，但 runtime 从本阶段起忽略它。

### 2. Template 默认策略

Agent template 显式定义 grants，不在工具内部隐式授予：

- 普通 Agent：own Memory 全数据面；Knowledge read/expand/search。
- Project 研究/只读 Agent：active project read/expand/search。
- Archivist/维护 Agent：active project 增加 update/link/unlink，不授予 source-bound 结构操作。
- Zero/管理 Agent：如确需全树数据权限，在 template 明确 `wiki-root` grant；不得以 `agentId === "zero"` 硬编码。

默认 context：

```text
memory://  standard/system/1800
project:// standard/system/2800（仅 active project session）
```

### 3. Agent/Project 生命周期

Agent create：幂等 ensure `wiki-root/memory/<agent-name>`。
Agent rename：移动同一 Memory root，保留内部 ID、links/content；更新由 `${agent_id}` 编译出的 scope。
Agent delete：归档 Memory root，不硬删除。

Agent name 必须能转换为唯一 Wiki path segment：

- 支持空格和 Unicode。
- 拒绝 `/`、`\`、`.`、`..` 和控制字符。
- 同名 Agent 的 Memory root 冲突必须在管理层明确报错，不能追加随机后缀。

Project create/rename/delete 对 project root 采用同样的 preserve-ID/归档规则，并与 repository binding 一致。

### 4. Grants 编译

`AgentService` 在 session build 时：

1. 读取已发布 Agent config。
2. 展开 `${agent_id}`、`${active_project}`。
3. 解析 logical address/canonical template。
4. validate 并生成 `CompiledWikiAccess`。
5. 放入 SessionConfig 和 `CallerCtx.wikiAccess`。

无 active project 时，含 `${active_project}` 的 grant/context 被标记 inactive，不得解析为 `wiki-root/projects`。

`CallerCtx.wikiAnchorNodeIds` 从新路径删除；`Wiki` tool 不再读取 `callerCtx.scope.projectId` 作为权限捷径。

### 5. 正式 Wiki tool 切换

- ToolRegistry 中用户可见名称仍只有 `Wiki`。
- `Wiki` 指向 Plan 04 的新实现。
- 删除/停止注册旧 action schema。
- 不提供 `WikiLegacy`、`WikiV2` 或自动 fallback。
- Tool prompt 使用逻辑地址/canonical path 和 `search → expand → read`。

旧 UI router 可暂时存在到 Plan 06/08，但 Agent runtime 不得再调用旧 WikiStore。

### 6. WikiContextCompiler

以 `wiki-context-compiler.ts` 替换 `wiki-anchor-injection.ts` 的 runtime 职责。

输入：

- compiled wikiContext entries。
- address/policy revision。
- Agent identity/active project/work context。
- token budgets。

输出一个缓存 system section：

```text
## Wiki Context
Available addresses
Agent Memory manifest
Active Project manifest
Retrieval guidance
```

#### Memory standard profile

- root summary/content 中的稳定规则。
- long_term/permanent preference/procedure/experience。
- 近期且高价值节点。
- 一级导航和必要二级候选。
- 不依赖固定 preferences/lessons 目录名。

#### Project standard profile

- 项目目标、技术栈、branch/indexed revision/sync status。
- 入口与主要模块。
- 关键目录 summaries。
- capabilities、constraints、risks、recent changes。
- 当前 work/requirement 相关候选。

selection 必须确定、可测试；超预算按明确优先级截断，并输出 truncated marker/统计供 preview。

### 7. 缓存与热更新

- `wiki-context` section 使用现有 `SystemPromptAssembler`，`cacheBreak:false`。
- session create、active project change、Agent grants/context publish、显式 refresh 和 memory archive 完成时 invalidate。
- 普通 Wiki write 不在当前 tool call/turn 中改变地址或权限。
- policy/address revision 改变时下一安全边界重编译，不让一次调用前后语义不同。
- preview 与真实 compiler 共用同一函数，禁止复制一套近似渲染。

### 8. Memory archive/compression

更新 `DEFAULT_ARCHIVE_MEMORY_PROMPT` 和 memory ephemeral turn：

- 使用 `search/read/create/update/link` 新 action。
- caller 只获得自己的 Memory 完整权限和必要 Knowledge 只读权限。
- 不再用 `buildGlobalAnchorWikiCallerCtx` 或全局 root 让 Memory turn 写全部 Agent/Project。
- 记忆子树动态组织，写入 attributes（memory_type/durability/confidence/sources/review_after）。

### 9. Enrichment/Archivist prompt

更新内置 Archivist 和 `wiki-operations.ts`：

- 使用 project:// canonical navigation。
- 只 update/link source-bound 节点的语义层。
- 不 create/move/delete repo 结构。
- 不复制源码正文。
- commit sync 后只充实 changed/stale nodes 及必要祖先。

## 测试要求

建议：

```text
tests/unit/wiki-v2-agent-config.test.ts
tests/unit/wiki-v2-runtime-access.test.ts
tests/unit/wiki-v2-context-compiler.test.ts
tests/unit/wiki-v2-memory-turn.test.ts
tests/unit/wiki-v2-template-policy.test.ts
tests/unit/wiki-v2-runtime-tool-wiring.test.ts
```

## 明确不做

- 不改 Wiki Browser/Agent Editor UI（Plan 06–07）。
- 不把 Prompt 注入当授权。
- 不为旧 wikiAnchors 生成兼容权限。
- 不给 zero 或 memory turn 隐式全树权限。

## 完成定义

[Acceptance 05](acceptance-05-agent-runtime-prompt.md) 全部通过并提交 `result-05.md`。
