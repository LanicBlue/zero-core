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

Agent create：幂等 ensure `wiki-root/memory/<stable-agent-id>`，写确定性 summary 与 `attributes.display_name`。
Agent rename：只更新 AgentRecord name 与 Memory root display_name/summary；canonical path 和整棵子树不移动。
Agent delete：归档 Memory root，不硬删除。

Agent/Project 显示名不参与 canonical path，支持空格和 Unicode；稳定业务 ID 必须通过 path segment validator。Project create/rename/delete 对 `wiki-root/projects/<stable-project-id>` 采用同样的 display-only rename/归档规则，并与 repository binding 一致。

Core DB 与 Wiki DB 不做跨库事务。Agent/Project 管理 service 先做全量 preflight，再执行幂等 ensure/update/archive；失败记录可重试状态。session build 额外调用轻量 ensure 以修复 Core 对象存在但 Wiki root 缺失的中断状态。

### 4. Grants 编译

`AgentService` 在 session build 时：

1. 读取已发布 Agent config。
2. 使用稳定 `agentId/activeProjectId` 解析 `memory://`、`project://`。
3. 解析 logical address/canonical template。
4. validate 并生成 `CompiledWikiAccess`。
5. 放入 SessionConfig 和 `CallerCtx.wikiAccess`。

无 active project 时，`project://` grant/context 被标记 inactive，不得解析为 `wiki-root/projects`。

`CallerCtx.wikiAnchorNodeIds` 从新路径删除；`Wiki` tool 不再读取 `callerCtx.scope.projectId` 作为权限捷径。

### 5. 正式 Wiki tool 切换

- ToolRegistry 中用户可见名称仍只有 `Wiki`。
- `Wiki` 指向 Plan 04 的新实现。
- 删除/停止注册旧 action schema。
- 不提供 `WikiLegacy`、`WikiV2` 或自动 fallback。
- Tool prompt 使用逻辑地址/canonical path 和 `search → expand → read`。

切换必须覆盖旧 10 个 action 的所有生产 caller：memory archive/compression、Archivist、enrichment、router/dispatcher 和测试。`createMemory/updateMemory/docRead/docWrite/docEdit` 不得残留 Force-memory 或隐藏 fallback。

旧 UI router 可暂时存在到 Plan 06/08，但 Agent runtime 不得再调用旧 WikiStore。

### 6. WikiContextCompiler

在 `src/server/wiki/wiki-context-compiler.ts` 实现 compiler，删除 `wiki-anchor-injection.ts` 的 runtime 职责。compiler 不位于 AgentLoop。

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

优先级固定为：地址/检索指引 → 根稳定规则 → permanent/long_term preference/procedure → Project 目标/约束/sync → 当前 work 相关 → 近期高价值 → 导航补充。类内排序固定使用 priority/durability/confidence/updated_at/canonical path。

### 7. 缓存与热更新

新增通用 runtime contract，而不是 Wiki 专用 AgentLoop 分支：

```ts
interface DynamicSystemSection {
  name: string;
  compute: () => string;
  cacheBreak: boolean;
}

interface SessionConfig {
  dynamicSystemSections?: DynamicSystemSection[];
  wikiAccess?: CompiledWikiAccess;
}
```

AgentService 维护每个 session 的 pending generic config patch。新增/扩展通用 `config-sync` StepEnd hook：busy loop 在 StepEnd 调用 host 注入的 `flushPendingConfigUpdate`；idle loop 可由 AgentService 立即调用通用 `applyConfigUpdate`。`AgentLoop.applyConfigUpdate` 只按 section name 通用替换/失效，不包含 Wiki 判断。

- AgentService 把 Wiki section 作为通用 `{name,compute,cacheBreak:false}` dynamic system section 放入 SessionConfig；AgentLoop 只消费通用 section 数组，不 import Wiki compiler/store，不出现 `'wiki-context'/'wiki-system-anchors'` 字面量或 Wiki 专用 invalidate。
- session create、active project change、Agent grants/context publish、显式 refresh 和 memory archive 完成时由 AgentService config-sync 排队。
- 普通 Wiki write 不在当前 tool call/turn 中改变地址或权限。
- idle session 立即应用；busy session 只在 `StepEnd` hook 后安全边界交换 compiled access/section。不得引用已删除的 `PostTurnComplete`。
- preview 与真实 compiler 共用同一函数，禁止复制一套近似渲染。

### 8. Memory archive/compression

更新 `DEFAULT_ARCHIVE_MEMORY_PROMPT` 和 memory ephemeral turn：

- 使用 `search/read/create/update/link` 新 action。
- caller 只获得自己的 Memory 完整权限和必要 Knowledge 只读权限。
- 不再用 `buildGlobalAnchorWikiCallerCtx` 或全局 root 让 Memory turn 写全部 Agent/Project。
- 记忆子树动态组织，写入 attributes（memory_type/durability/confidence/sources/review_after）。
- TTL cleanup、compression archive、Agent delete 和普通 Wiki delete 共用 WikiService archive primitive；归档完成事件只从该 service 发出一次。

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
tests/e2e/wiki-v2-runtime-context.spec.ts
```

## 明确不做

- 不改 Wiki Browser/Agent Editor UI（Plan 06–07）。
- 不把 Prompt 注入当授权。
- 不为旧 wikiAnchors 生成兼容权限。
- 不给 zero 或 memory turn 隐式全树权限。

## 完成定义

[Acceptance 05](acceptance-05-agent-runtime-prompt.md) 全部通过并提交 `result-05.md`。
