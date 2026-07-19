# Plan 03：Project Git 语义镜像

## 目标

把已注册 Project 的 Git tree 映射成 source-bound Wiki 节点，并支持 commit 后按 diff 原子同步、按索引版本读取源码以及在授权 scope 内搜索源码。完成后 Project Wiki 结构可从仓库完全重建，但尚不依赖正式 Agent tool 或 UI。

## 依赖

- Acceptance 01–02 已通过。

## 实施范围

### 1. 重构扫描服务

将 `WikiSkeletonService` 的新实现重构/更名为：

```text
src/server/wiki/wiki-project-indexer.ts
src/server/wiki/wiki-source-service.ts
src/server/wiki/wiki-source-search.ts
```

不再生成：

```text
header:, intent:, structure:
```

也不再区分 header/intent/structure provenance。每个节点由 Git object 和仓库相对路径决定。

### 2. 仓库绑定

管理服务根据：

- `ProjectRecord.id/name/workspaceDir`
- project root Wiki node
- `source_root/default_branch`

创建 `wiki_repositories` 记录。`workspaceDir` 继续由 `ProjectStore` 管理；Wiki DB 不复制绝对路径。

绑定必须校验：

- workspaceDir 是存在的 Git repository。
- source_root 在 repo 内且不能逃逸。
- project root 位于 `wiki-root/projects/<stable-project-id>`，可读名称在 `attributes.display_name`；Project rename 不移动镜像子树。
- 一个 project 和一个 project root 只能绑定一次。

### 3. 全量索引

针对明确 commit SHA 使用 Git plumbing 命令，例如：

```text
git ls-tree -r -z <revision>
```

要求：

- 索引全部 tracked 文件，而不是只索引代码/文档后缀。
- 从文件路径推导所有非空目录节点。
- 不依赖 Windows `readdir` 枚举仓库作为事实源。
- 不索引 untracked、ignored 和 feature worktree 未提交内容。
- 路径始终使用 Git 的 `/` 与原始大小写。
- `source_root` 被剥离后再挂到 project root 下。

Git mode 处理：

- 普通 blob：按扩展名/位置推导 `source_file/document/test/config/asset`。
- executable blob：保留 executable 属性。
- symlink：kind/attribute 标记为 symlink；读取返回 link blob，不跟随到磁盘目标。
- submodule：创建 `submodule` 节点，不自动遍历；需要单独 repository binding 才展开。

每个节点写 `wiki_source_bindings`：repository、source_path、indexed_revision、blob_oid、source_kind。

### 4. 初始语义内容

索引器拥有 path/kind/source binding，不覆盖已有 `summary/content/links`。

新节点必须有紧凑的确定性初始 summary，至少说明：

- 目录：仓库相对目录和直接/总子项数。
- 文件：source kind、语言/扩展名和仓库相对路径。
- 项目根：Project name、branch、revision、tracked 文件/目录数量。

这只是可导航骨架，不复制文件正文。后续 Archivist 可用 Wiki update 充实职责、symbols 和修改注意事项。

### 5. 增量同步

使用 `indexed_revision → new HEAD` 的 Git diff，必须正确处理：

```text
A add
M modify
D delete
R rename
C copy（按 add 处理）
```

同步事务：

1. 将 repository 状态标记 `indexing`。
2. 在一个 DB transaction 中应用所有结构/source binding 变更。
3. 更新目录统计和受影响节点 stale 属性。
4. 更新 `indexed_revision/last_indexed_at`。
5. 状态改为 `synced`。

失败时 rollback 所有节点变更，`indexed_revision` 保持旧值，并在独立小事务中写 `failed/last_error`。

rename 必须匹配 Git rename 结果并调用内部 move：

- 保留节点内部 ID。
- 保留 summary/content/revision/links。
- 更新 source_path、blob_oid、path 和后代 path。

同一 diff 的 rename swap/cycle 使用两阶段临时路径：先把所有受影响 active path/source binding 改到 transaction 唯一临时名，再写最终路径；禁止依赖不可延迟的 UNIQUE 约束碰运气。直接 rename 的根 revision +1，派生后代 revision 不变。

delete 默认归档 source-bound 节点；若同一 sync 中检测到 rename，不得先归档再新建。

### 6. Commit/merge 触发

必须修改并测试以下正式接入点，而不是只新增未调用 service：

- `src/server/wiki-skeleton-service.ts`：由 `WikiProjectIndexer` 取代结构扫描职责；commit/merge 成功后调用新 sync。
- `src/server/archivist-git.ts`：只执行 Git 操作并返回最终 SHA，不直接写 Wiki。
- `src/server/index.ts`：替换 `WikiSkeletonService` 构造、`/api/archivist/:projectId/scan|rescan-full|rebuild-subtree` 路由和启动期 stale rebuild。
- `src/server/project-work-hook-manager.ts` 及调用 commit/merge 的 workflow：统一消费同一 indexer result/status。
- `src/server/wiki-scan-cursor-store.ts`：游标迁入 `wiki_repositories` 后删除。

成功 commit、feature→main merge 和显式 reindex 统一执行：

```text
Git 操作成功
→ 获取最终 SHA
→ 请求 Wiki sync
→ 返回/记录 sync 结果
```

Git commit 本身成功但 Wiki sync 失败时不得回滚 Git；项目必须明确显示 Wiki `stale/failed`，并可重试到同一 SHA。

固定 roots 在启动时 eager bootstrap；Project full index 不在每次应用启动同步阻塞。注册/显式 reindex 进入 server background job 并报告进度；启动只做有界 `rev-parse`/状态核对，发现 HEAD 变化即标 stale 并排队，不等待全量扫描后才提供服务。

### 7. Source read

提供：

```text
readIndexedSource(node, lineStart?, lineEnd?)
readWorkspaceSource(node, workingDir, lineStart?, lineEnd?)
```

- indexed 默认使用 `git show <indexed_revision>:<source_path>`，与 Wiki 版本一致。
- workspace 模式限定在绑定 checkout/当前合法 worktree 内，执行 realpath、relative 和 symlink 逃逸检查。
- 二进制返回 metadata/拒绝正文，不把 bytes 当 UTF-8。
- 返回 revision、blob_oid、source_path、dirty/stale 状态。
- line range 有上限并返回 total lines/truncated。

### 8. Source search

封装 ripgrep：

- cwd 由 repository binding 和 host 决定，不能由模型提供绝对路径。
- scope 转换为允许的 source relative root。
- 支持 exact/substring/glob/regex、case sensitivity、limit/cursor 或稳定截断。
- regex pattern 最多 2,048 UTF-8 bytes；ripgrep 子进程默认 timeout 2 s、输出 2 MiB、结果 200，超限/超时映射共享 `REGEX_LIMIT_EXCEEDED/REGEX_TIMEOUT`。
- 结果映射回 source-bound Wiki canonical path。
- 若搜索 workspace 而非 indexed revision，结果标记 workspace/dirty。

## 测试仓库 fixture

建立临时 Git repo，至少包含：

- 多层目录、源码、README、配置、无扩展名文件。
- rename、modify、delete、copy commit。
- 文件名含空格、Unicode、大小写。
- symlink：Git mode `120000` 的 ls-tree/blob fixture 必须跨平台运行；真实工作区 symlink escape 仅在 Windows 未启用 Developer Mode/管理员能力时条件跳过并记录。
- submodule：至少提供不依赖网络的 ls-tree mode `160000` fixture；可选再建本地 submodule repo。

fixture/bootstrap 脚本必须在 Windows PowerShell 环境可运行，不依赖 Bash-only symlink 命令。

## 明确不做

- 不把源码/README 正文写入 Wiki content。
- 不索引未提交 feature WIP。
- 不实现 symbol/call graph。
- 不依赖 LLM 才能完成结构同步。
- 不创建第二套 features/flows/docs 平行树。

## 完成定义

[Acceptance 03](acceptance-03-project-git-mirror.md) 全部通过并提交 `result-03.md`。
