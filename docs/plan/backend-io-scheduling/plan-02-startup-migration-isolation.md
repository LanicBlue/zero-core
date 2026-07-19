# Plan 02：启动迁移隔离

## 目标

把数据库布局 bootstrap 和无边界 schema migration 从 backend 主线程移到固定 maintenance
child process；父进程保持 lifecycle heartbeat，并只在验证完成后打开业务 connection 和
进入 ready。

## 实施范围

### 1. Bootstrap journal 与 lock

- 复用 Wiki Final 的 layout marker/backup/integrity 契约；
- 增加带 version、phase、source/target digest、child generation、heartbeat 和结果的
  bootstrap journal；
- 使用 exclusive lock 防止两个 backend/maintenance child 同时迁移同一数据目录；
- journal 写入采用 temp + fsync/close + atomic rename；
- journal 不包含 credential 或用户正文。

Core DB 尚不可用时不得伪造 `maintenance_jobs` 行；数据库 ready 后把最终 bootstrap
snapshot 投影到只读 job history/诊断。

### 2. 固定 maintenance child

- parent 只 spawn 固定 entry 和结构化参数，不拼 shell；
- child 在任何 parent Core/Wiki handle 打开前独占数据库；
- layout checkpoint/copy/hash/integrity/foreign key/promote/backup 和大 schema migration
  全部在 child；
- child 定期通过 IPC 报 phase/progress/heartbeat；
- 所有 handle 关闭后才发送 success；
- parent 验证 exit code、journal、marker、目标文件和 schema version。

### 3. Startup composition

将同步 `DatabaseManager.open(): void`/`runMigrations()` composition 改成明确 async bootstrap：

```text
process live → bootstrap/migrating → databases opening → ready
                                     ↘ failed/recovery_required
```

- normal HTTP/WS/business services 只能在 ready 后构造/监听；
- Electron main/CLI 能区分 migrating、failed 和 process dead；
- 如果 Security effort 已合并，复用 authenticated generation/lifecycle channel；
- 不新增 unauthenticated migration endpoint 或固定端口；
- readiness timeout 不能短于仍有 heartbeat 的合法迁移。

### 4. Crash 与取消

故障注入：

- checkpoint 前、copy/hash 中、tmp verify 中、promote 前后、旧库 backup 中；
- child 无 heartbeat、非零退出、被 kill、parent crash；
- 磁盘满、权限拒绝、损坏 DB、未知 journal version；
- fresh create 与已经 complete 的幂等重启。

commit/promote 临界段拒绝 cancel；其他 safe phase 可请求 abort。任何未知结果都进入
recovery_required，不能同时打开 source/target 猜测继续。

### 5. 删除旧同步路径

- parent 不再直接运行大 migration/copy/hash/integrity；
- 不保留旧同步 fallback；
- 小且有版本、经 Plan 00 证明满足 D1 的 open-time PRAGMA/schema check 可保留，但必须
  进入 sync inventory。

## 完成定义

[Acceptance 02](acceptance-02-startup-migration-isolation.md) 通过并创建 `result-02.md`。
