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

提供内部 API：

```text
expand, read, searchScopePreparation,
create, update, archive, hardDelete,
link, unlink, move
```

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

地址注册管理 API 尚不接 UI，但 service 必须支持 create/update/delete/validate，检测：

- address 唯一性。
- target 存在。
- alias/resolver 循环。
- scope 合法。
- 静态地址 target 使用内部 ID，节点 move 后仍有效。

普通数据面 service 不能注册地址。

### 3. Compiled grants

定义：

```ts
interface CompiledWikiGrant {
  canonicalScope: string;
  actions: WikiAction[];
}

interface CompiledWikiAccess {
  agentId: string;
  activeProjectId?: string;
  grants: CompiledWikiGrant[];
  policyRevision: number;
}
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
- archive 是普通 delete 的默认行为。
- hard delete 检查 child、incoming link、address、source binding。
- move 更新节点和全部后代 materialized path；links/address target 不变。
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

Markdown section 以 heading 结构解析，不能用不受限 regex 猜边界。第一版仍整体读写单个 TEXT，不建 sections 表。

### 6. Memory 生命周期 helper

实现幂等：

```text
ensureAgentMemoryRoot(agentName)
archiveAgentMemoryRoot(agentName)
```

只固定 root，不能自动生成 preferences/lessons 等子树。

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

