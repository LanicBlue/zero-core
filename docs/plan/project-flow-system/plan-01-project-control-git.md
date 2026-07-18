# Plan 01：Project 控制目录与内层 Git

## 目标

为每个注册 Project 建立稳定的 `<projectRoot>/.zero-core` 控制面、所有权 manifest、
外层 Git exclude 和内层轻量 Git。完成后还没有业务 Flow，但控制目录可安全初始化、
提交、回滚、诊断和恢复。

## 依赖

Acceptance 00 通过。

## 实施范围

### 1. 路径与 manifest

新增单一 ProjectControl 路径/服务模块：

```text
projectControlDir(projectRoot) = resolve(projectRoot, ".zero-core")
```

manifest v1 至少包含：

```text
owner = zero-core
formatVersion = 1
projectId
createdAt
```

必须 realpath 校验 Project 根、拒绝 symlink/junction 控制根逃逸，并区分：

- ready：合法 manifest 和内层仓库；
- uninitialized：不存在或空目录；
- conflict：未知非空目录、其他 Project manifest、外层 tracked 冲突；
- unavailable：根不存在、不可写或 Git 不可执行。

### 2. 外层 exclude

对外层 Git 项目使用 Git 命令解析真实 Git dir，幂等写入精确 `/.zero-core/`。不得修改
目标项目 `.gitignore`，也不能假定 `.git` 是目录。

### 3. 内层 Git

初始化 `.zero-core/.git`，创建稳定初始结构与 `.gitignore`：

```gitignore
worktrees/
runs/
cache/
tmp/
```

commit 使用命令级 zero-core author，不修改用户 global/local Git config。新增
ProjectControlGit 接口：

- `status/ensure/commit/restoreHead/readRevision`；
- per-project 串行锁；
- 无变化 no-op；
- commit 失败保留结构化错误。

### 4. 既有 Project bootstrap

- 新注册 Project：控制面初始化失败则注册失败或事务回滚。
- 升级前已注册 Project：启动逐项 ensure；某个 Project conflict/unavailable 时记录
  `controlStatus` 并禁用其新 Flow/Work，不阻止其他 Project 和应用整体启动。
- 不删除未知文件，不自动修复 owner/projectId 冲突。

### 5. Core DB 查询状态

按 Plan 00 后的真实 Core DB 增加 Project control status/error/revision 查询投影。物理
manifest 和内层 Git 是事实源，DB 字段是 UI/路由索引，可重建。

### 6. 创建即隐藏的最小 Guard

控制目录一旦存在，必须立即对普通 Read/Write/Edit/Glob/Grep、Project 文件树/文件 API
和 context scanner 隐藏或拒绝物理 `.zero-core`。优先复用合并后的 Wiki 物理数据 guard
框架；本阶段只处理 anchored Project control root，不实现 `skill://` / `flow://`。

若为避免 Agent Work Runtime Plan 03 前置而加入临时 provider adapter，必须明确标注由
该阶段删除并有
测试防止双 guard 分歧。不能让 Plan 01–04 的中间 commit 暴露控制面。

## 测试

覆盖非 Git Project、主 checkout、registered root 为 linked worktree、未知目录、
manifest 冲突、不可写、symlink/junction、重复启动、commit 失败、多 Project 隔离和
创建后普通文件工具/文件 API 不可见。

临时 Git 实验必须自动化验证：

- 外层 status 不显示控制面；
- 外层 `git clean -ndx` 不删除嵌套仓库；
- `git clean -ndffx` 会报告删除，文档明确该边界；
- 内层 status 忽略 worktrees/runs/cache/tmp。

## 明确不做

- 不初始化目标源码的外层 Git。
- 不建立远端或全局备份。
- 不创建 FlowDefinition/WorkDefinition。
- 不实现虚拟 URI；Agent Work Runtime Plan 03 将本阶段最小物理 guard 收敛到统一 VFS。

## 完成定义

[Acceptance 01](acceptance-01-project-control-git.md) 全部通过并生成 `result-01.md`。
