# Plan 07：管理 API 与配置 UI

## 目标

为管理员提供 Agent Wiki grants/context、逻辑地址、仓库绑定、同步和 Prompt preview 的完整管理面。管理配置发布后由 Plan 05 runtime 消费；普通 Agent Wiki tool 保持纯数据面。

## 依赖

- Acceptance 01–06 已通过。

## 实施范围

### 1. 管理 API

建立独立 `/api/wiki-admin` router：

```text
addresses: list/create/update/delete/validate/impact
repositories: bind/update/unbind/validate/status/reindex
grants: validate/preview/publish
context: validate/preview/publish
```

要求：

- authority 由 server host 注入，不能由 body 声明。
- 所有 mutation 记录管理审计和 revision。
- validate/preview 无副作用。
- publish 使用 expected policy revision，冲突返回管理级 `WRITE_CONFLICT`。
- 普通 Wiki data router/tool 不代理这些 action。

### 2. 任意逻辑地址管理

管理员可把任意 Wiki 节点注册为静态逻辑地址，例如：

```text
runtime:// → wiki-root/projects/zero-core/src/runtime
```

支持在地址后追加相对路径。UI/API 必须显示：

- address/kind/scope。
- current target canonical path。
- target archived/missing 状态。
- prompt policy 与 revision。
- 哪些 Agent wikiContext/grants 引用它。

动态 resolver 只允许 `memory://`、`project://` 等系统白名单，管理员不能上传可执行 resolver 代码。

地址变更时先 preview：

- 受影响 Agent。
- 受影响 Prompt sections/token。
- active sessions 是否需要 refresh。
- scope 是否扩大或缩小。

### 3. Agent Editor：Wiki Access

删除旧 `WikiAnchorsSection` 的实际 UI 和 form wiring，新增：

```text
WikiAccessSection
```

每条 grant 编辑：

- canonical scope 或逻辑地址/template。
- action chips。
- 编译预览（当前 Agent + 可选 project）。
- valid/inactive/error 状态。

提供保护：

- `wiki-root` 全树写权限二次确认。
- 重复/重叠 grant 提示并展示 action union。
- `${active_project}` 无示例项目时显示 inactive，不错误扩根。
- 删除最后一条 grant 必须以 `[]` 持久化，不能因 undefined 保留旧值。

### 4. Agent Editor：Wiki Context

新增：

```text
WikiContextSection
```

每条 context 编辑：

- address。
- compact/standard/deep。
- system/off。
- token budget。

Preview 必须调用真实 `WikiContextCompiler`，展示：

- 完整文本。
- 各段 token/截断统计。
- address/policy revision。
- 所需 read scope 是否被 grants 覆盖。

Context 不自动授予权限；若 context address 无 read grant，UI 显示配置错误并阻止 publish。

### 5. Project Wiki 管理

Project 页面增加索引卡片：

- Wiki project root。
- repository/project binding。
- workspaceDir（ProjectStore，只读）。
- source_root/default branch。
- indexed revision/current HEAD。
- pending/indexing/synced/stale/failed。
- last indexed time/error。
- Validate、Full reindex、Open Wiki。

bind/reindex 必须显示进度；任务可重试，不能因页面关闭丢失 server 状态。

unbind 默认只解除 binding/停止同步，不硬删除 project Wiki；归档/删除是单独管理动作并显示影响。

### 6. Session publish 行为

grants/context/address publish：

- revision +1。
- 通知 AgentService。
- running session 在安全边界 refresh compiled policy/context。
- UI 显示哪些 session 已应用/待应用。
- 不改变正在执行中的 tool call snapshot。

### 7. Preload 与状态

管理 API 类型独立于 data API。renderer 不接触内部 ID；target 选择器使用 canonical path/address。

管理状态发生变化时使用专用 `wiki_admin/wiki_sync` change event，避免误刷新整棵 data tree。

## 测试要求

建议：

```text
tests/unit/wiki-v2-admin-router.test.ts
tests/unit/wiki-v2-address-management.test.ts
tests/unit/wiki-v2-grant-editor-state.test.ts
tests/unit/wiki-v2-context-preview.test.ts
tests/unit/wiki-v2-project-admin.test.ts
tests/e2e/wiki-management.spec.ts
```

## 明确不做

- 不把管理 action 加入 `Wiki` tool。
- 不允许 UI 自报 admin。
- 不允许 context 隐式 grant。
- 不提供任意 resolver script/plugin。
- 不在本阶段清旧实现（Plan 08）。

## 完成定义

[Acceptance 07](acceptance-07-management-ui.md) 全部通过并提交 `result-07.md`。

