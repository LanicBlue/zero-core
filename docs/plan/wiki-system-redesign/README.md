# Wiki System Redesign：实施路线图

> 设计基线：[`./design.md`](./design.md)
> 状态：✅ 独立 re-review PASS(见 [`plan-review-r2.md`](./plan-review-r2.md))—— 6 blocker 全 RESOLVED、跨文档一致;可进入实施(sub-00 watch-item 见 r2 §2)
> 数据策略：clean cutover，不迁移旧 Wiki 数据。

## 1. 使用方式

本目录用于把 Wiki 重构交接给多个实施与验收 Agent。每个阶段包含一对文档：

```text
plan-XX-*.md        实施范围、步骤、文件、边界和测试要求
acceptance-XX-*.md  可判定的验收清单与证据要求
```

执行者必须依次阅读：

1. 总设计文档。
2. 本 README。
3. 当前阶段的 plan。
4. 当前阶段的 acceptance。
5. 所有已完成阶段的验收结果和偏差记录。

不得只按 plan 的任务列表机械改代码而忽略总设计中的不变量。

## 2. 阶段与依赖

| 阶段 | 实施文档 | 验收文档 | 依赖 | 主要产物 |
|---|---|---|---|---|
| 00 | [Database Foundation](plan-00-database-foundation.md) | [Acceptance 00](acceptance-00-database-foundation.md) | 无 | `db/core.db`、统一生命周期、删除退役 `knowledge.db` |
| 01 | [Database & Contracts](plan-01-database-contracts.md) | [Acceptance 01](acceptance-01-database-contracts.md) | 00 | 独立 `db/wiki.db`、schema、path、repositories |
| 02 | [Core Service, Address & Auth](plan-02-core-service-address-auth.md) | [Acceptance 02](acceptance-02-core-service-address-auth.md) | 01 | CRUD、revision、links、逻辑地址、授权 |
| 03 | [Project Git Mirror](plan-03-project-git-mirror.md) | [Acceptance 03](acceptance-03-project-git-mirror.md) | 01–02 | Git tree/diff 索引、source read/search |
| 04 | [Wiki Tool & Search](plan-04-wiki-tool-search.md) | [Acceptance 04](acceptance-04-wiki-tool-search.md) | 01–03 | 新 Wiki action tool、结构化结果、统一搜索 |
| 05 | [Agent Runtime & Prompt](plan-05-agent-runtime-prompt.md) | [Acceptance 05](acceptance-05-agent-runtime-prompt.md) | 01–04 | grants/context、CallerCtx、Prompt compiler、运行时切换 |
| 06 | [Data API & Browser UI](plan-06-data-api-browser-ui.md) | [Acceptance 06](acceptance-06-data-api-browser-ui.md) | 01–05 | REST/IPC、Wiki Browser、搜索/详情 UI |
| 07 | [Management UI](plan-07-management-ui.md) | [Acceptance 07](acceptance-07-management-ui.md) | 01–06 | Agent access/context、地址与项目同步管理 |
| 08 | [Cutover & Hardening](plan-08-cutover-hardening.md) | [Acceptance 08](acceptance-08-cutover-hardening.md) | 01–07 | 删除旧实现、备份、性能、架构文档、发布门禁 |

所有阶段完成后必须执行 [最终端到端验收](acceptance-final.md)。单阶段通过不等于整个重构完成。

```text
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → FINAL
```

## 3. 全程不可违反的不变量

### 3.1 数据与身份

- 应用核心状态事实源是 `${ZERO_CORE_DIR}/db/core.db`；新 Wiki 事实源是 `${ZERO_CORE_DIR}/db/wiki.db`。
- `knowledge.db` 已退役并由 Plan 00 精确删除，不保留运行时或兼容读取。
- 新 Wiki 不使用旧 `core.db.project_wiki`（原 `sessions.db.project_wiki`）。
- 不迁移、双读或双写旧 `project_wiki` 与旧磁盘正文。
- Agent 只能看到规范路径、逻辑地址和稳定业务 ID 路径段，不能看到 Wiki 数据库整数 ID、`wiki-root:*` 合成 ID 或 8 字符短 ID。
- 所有 canonical path 以 `wiki-root` 开头，路径规范化只能由共享 path 模块完成。
- links 和静态地址使用内部 ID，因此节点移动后无需改写关系端点。
- Agent/Project 根使用稳定业务 ID 作为路径段；改显示名称不移动子树。

### 3.2 权限与管理边界

- Wiki grants 位于 Agent 配置；普通 Wiki 节点不存 ACL。
- 权限与 Prompt 注入分离：`wikiGrants` 只授权，`wikiContext` 只注入。
- 身份、active project 和 compiled grants 由 host 注入，不能出现在 LLM 可控参数中。
- 没有 grant 覆盖路径时返回 `NOT_FOUND`；路径已覆盖但 action 缺失时返回 `ACCESS_DENIED`。
- 搜索必须先限定授权 scope，再查询、排名和生成 snippet。
- 地址注册、仓库绑定、grants 和 Prompt 发布属于管理面，不得加入普通 Wiki tool action。

### 3.3 Project Wiki

- 每个 Git tracked 文件与推导目录都有 source-bound Wiki 节点。
- Project Wiki 不复制源码或仓库文档正文。
- source-bound 节点的结构由 Git indexer 管理；普通 Wiki tool 不能 create/move/delete。
- commit rename 必须保留内部 ID、summary/content 和 links。
- sync 失败不能推进 `indexed_revision`，也不能留下半提交状态。

### 3.4 工程质量

- 每个阶段结束时仓库必须 typecheck 和 unit tests 全绿，不能把编译失败留给下一阶段；Plan 05/06/07/08 还必须运行相关 E2E。
- 临时 adapter 必须在对应 plan 中明确标注删除阶段；第 08 阶段后不得残留。
- 不得通过放宽权限、吞掉错误、跳过 foreign key、禁用测试或保留双实现来“通过验收”。
- 新行为必须有自动化测试；仅人工观察不能替代核心权限、事务和搜索测试。

## 4. 阶段执行协议

实施 Agent 在开始前：

1. 确认依赖阶段已通过 acceptance。
2. 从最新已验收 commit 建新分支。
3. 运行 baseline：`npm run typecheck`、`npm run test:unit`。
4. 记录 baseline 中已有失败；不能把新失败误归为旧问题。

实施完成后：

1. 逐项执行对应 acceptance。
2. 在本目录新增 `result-XX.md`，记录：
   - commit SHA；
   - 修改文件；
   - 实际命令和结果；
   - acceptance 证据；
   - 与 plan 的偏差及理由；
   - 留给下一阶段的已知限制。
3. 不得自行勾选无法提供证据的验收项。

推荐由不同 Agent 执行实现与验收。验收 Agent只依据代码、测试和运行证据判断，不接受“实现者说明已完成”作为证据。

## 5. 通用验证命令

每阶段至少执行：

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run check:links
```

涉及 Electron UI 的阶段还需：

```bash
npm run build
npm run test:e2e
```

最终阶段必须从空 Wiki DB、至少一个 Agent 和至少一个 Git 项目开始完成端到端验收。

## 6. 变更控制

若实施中发现设计必须改变：

1. 停止扩大改动。
2. 在 result 文档写明冲突、证据和候选方案。
3. 先更新总设计与所有受影响的后续 plan/acceptance。
4. 获得用户确认后再继续。

禁止某个阶段静默改变 canonical path、权限错误语义、Project 镜像所有权或工具 action 集。
