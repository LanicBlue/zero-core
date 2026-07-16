# Plan 02：核心服务、逻辑地址与授权

## 目标

在 Plan 01 的 repository 之上实现事务化 Wiki 业务服务、局部正文编辑、逻辑地址解析和纯 allowlist 授权。完成后，测试可用模拟 CallerCtx 对规范路径/逻辑地址执行完整数据面操作，但尚不接入正式 Agent loop。

## 依赖

- Acceptance 01 已通过。

## 实施范围

### 1. WikiService

建议新增：

```text
wiki-service.ts
wiki-address-service.ts
wiki-authorization-service.ts
wiki-edit-service.ts
wiki-errors.ts
```

公共数据面 API 固定为：

```ts
interface WikiService {
  expand(req: WikiExpandRequest, ctx: WikiRequestContext): Promise<WikiExpandResult>;
  read(req: WikiReadRequest, ctx: WikiRequestContext): Promise<WikiReadResult>;
  create(req: WikiCreateRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
  update(req: WikiUpdateRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
  archive(req: WikiArchiveRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
  hardDelete(req: WikiHardDeleteRequest, ctx: WikiAdminRequestContext): Promise<WikiMutationResult>;
  restore(req: WikiRestoreRequest, ctx: WikiAdminRequestContext): Promise<WikiMutationResult>;
  link(req: WikiLinkRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
  unlink(req: WikiUnlinkRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
  move(req: WikiMoveRequest, ctx: WikiRequestContext): Promise<WikiMutationResult>;
}
```

`prepareSearchScopes(access, requestedScope?)` 是 WikiAuthorizationService 的 internal helper，不是 Agent/UI public API。所有 request/result/context 类型来自 Plan 01 shared contract；后续阶段不得重新定义形状。

所有写操作必须：

1. 解析地址但尚不读取正文。
2. 授权 action。
3. 查询/校验目标。
4. 在 transaction 内更新 node/link/FTS/audit。
5. 返回无内部 ID 的 view。

### 2. 地址解析

解析顺序：

```text
canonical wiki-root path
→ dynamic address (memory://, project://)
→ registered static address
→ address 后续相对路径
→ canonical path
```

动态 resolver 只允许白名单：

```text
current_agent_memory_root
current_project_root
```

`memory://` 与 `project://` 是内建地址，不插入 `wiki_addresses`。它们分别使用 `agentId/activeProjectId` 构造 `wiki-root/memory/<stable-agent-id>` 与 `wiki-root/projects/<stable-project-id>`。管理员注册的静态 alias 才进入 `wiki_addresses`，其 target 使用内部 ID，所以 move 后仍稳定。

地址注册管理 API 尚不接 UI，但 service 必须支持 create/update/delete/validate，检测：

- address 唯一性。
- target 存在。
- alias/resolver 循环。
- scope 合法。
- 静态地址 target 使用内部 ID，节点 move 后仍有效。

地址**注册**校验错误码映射:address 重复 → `ALREADY_EXISTS`;target 不存在 → `NOT_FOUND`;alias/resolver 循环、scope 非法、相对路径越界 → `INVALID_ADDRESS`。

地址**解析**错误语义:非法 scheme/语法为 `INVALID_ADDRESS`;内建动态地址缺 agent/project context 为 `ADDRESS_UNRESOLVED`;有效 alias/规范路径目标不存在为 `NOT_FOUND`。resolver 字段是 closed declarative enum,禁止函数名或脚本。

普通数据面 service 不能注册地址。

### 3. Compiled grants

定义：

```ts
// 形状由 Plan 01 shared types 定义；本阶段只实现编译和判定。
```

授权必须先于节点存在性或正文查询：

- 无 scope 覆盖：`NOT_FOUND`。
- scope 覆盖但无 action：`ACCESS_DENIED`。
- action 存在但节点不存在：`NOT_FOUND`。

deep grant 不自动允许读祖先。links 只返回对端处于任意可见 grant 下的记录。

### 4. CRUD、revision 与 source ownership

- create 校验 parent create 权限、同级名称和 path。
- update 必须提供 `expected_revision`。
- summary/content/attributes 修改使 revision +1。
- attributes 使用字段级 patch；`null` 删除该 key，不能用整对象覆盖绕过并发。
- archive 是普通 delete 的默认行为并级联整棵子树；归档保留 path/name/links 供审计，active partial unique 允许同路径重建。
- hard delete 检查 child、incoming link、address、source binding。
- restore(reactivate 归档节点)是管理操作(`WikiAdminRequestContext`),不在 Agent 数据面 tool 暴露;执行前检查 active path/sibling 冲突,撞 active partial unique 则失败(供 Acceptance 01「restore 冲突被拒」测试);source-bound 节点 restore 仍返回 `SOURCE_MANAGED`(由 indexer 负责)。
- move 更新节点和全部后代 materialized path；links/address target 不变。仅被移动根 revision +1，后代 revision/updated_at 不变；事件返回 old/new subtree path。
- Agent 数据面 move 上限 10,000 节点，超限 `MOVE_TOO_LARGE`；管理/indexer 批量入口单独授权和审计。
- source-bound 节点的 create/move/delete 结构操作返回 `SOURCE_MANAGED`。

### 5. 局部正文编辑

实现：

```text
replace_text, insert_before, insert_after,
append, prepend, replace_section,
append_to_section, delete_section
```

必须区分：

```text
EDIT_TARGET_NOT_FOUND
EDIT_TARGET_AMBIGUOUS
WRITE_CONFLICT
```

Markdown section 使用显式 direct dependency 的 CommonMark AST parser（推荐 `unified + remark-parse`），同时支持 ATX/Setext。section 从目标 heading 到下一个同级或更高级 heading 前；fenced code 内 heading 不参与。同名用 `level/occurrence` 消歧，否则 `EDIT_TARGET_AMBIGUOUS`。第一版仍整体读写单个 TEXT，不建 sections 表。

### 6. Memory 生命周期 helper

实现幂等：

```text
ensureAgentMemoryRoot(agentId, displayName)
archiveAgentMemoryRoot(agentId)
```

只固定 root，不能自动生成 preferences/lessons 等子树。root name 使用稳定 agentId，summary/display_name 使用可变名称。Plan 02 只提供幂等 helper 和 fixture 测试，真实 caller 归 Plan 05 Agent lifecycle/session repair。

## 测试要求

建议新增：

```text
tests/unit/wiki-v2-service.test.ts
tests/unit/wiki-v2-address.test.ts
tests/unit/wiki-v2-auth.test.ts
tests/unit/wiki-v2-edit.test.ts
tests/unit/wiki-v2-move-link.test.ts
```

权限测试必须使用真实临时 DB，不能只 mock authorization 返回值。

## 明确不做

- 不把 grants 写到 Wiki DB 或 node attributes。
- 不接 AgentRecord/session。
- 不把地址管理加入普通 Wiki action。
- 不实现 Project Git 扫描。
- 不注册正式 Wiki tool。

## 完成定义

[Acceptance 02](acceptance-02-core-service-address-auth.md) 全部通过并提交 `result-02.md`。
