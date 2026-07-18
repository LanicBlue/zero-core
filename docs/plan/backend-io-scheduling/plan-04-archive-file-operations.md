# Plan 04：Archive 与重文件操作隔离

## 目标

把 Session archive export/recovery/sweep、备份 manifest/hash/verify/rotation 等随数据量增长
的序列化和文件操作迁到 worker/cooperative lane，保留 export-before-delete、崩溃恢复和
Session 生命周期语义。

## 实施范围

### 1. Archive job 接线

在现有 archive pipeline 的 export 边界创建/dedupe `archive_export` job：

- Memory turn、mark archived、Session replacement 等业务顺序不变；
- job descriptor 只含 session/agent identity、expected archive state 和受信 artifact root；
- agent/model、消息、step、summary 正文不写入 job 元数据；
- 每 Session 同时一个 archive job；
- fire-and-forget `.catch(log)` 不再是唯一状态。

若 Session Lifecycle 已合并，沿用其 Turn/background 语义；MaintenanceJob 不伪装
SessionTaskEvent。

### 2. Worker export

worker：

- 以独立 readonly Core connection 读取稳定 archived Session；
- 使用 cursor/chunk 或 worker-local同步读取，绝不把完整 payload 回主线程；
- 流式生成 temp JSON/artifact并增量计算 size/hash；
- 完成 schema/parse/hash 验证后 atomic rename；
- 返回小 manifest，而非完整 JSON；
- progress 按 rows/bytes 限频；
- cancel 在 artifact promote 前 safe point 生效。

主线程收到 success 后用短 transaction 重新验证 session/archive state/manifest，再删除 DB
数据并封存 job。删除失败保留已验证 artifact，retry 不重复写不同内容。

### 3. Recovery 与 retry

替换启动时在主线程直接导出的全量 recovery/sweep：

- startup 只分页发现候选并 enqueue/dedupe；
- 发现循环使用 cooperative lane 和 durable cursor；
- 每个 Session 独立 archive job，一个失败不阻塞其他候选；
- retry inspector 区分未写、tmp、final 已验证未删、DB 已删已完成、冲突 artifact；
- 冲突/未知 hash 进入 recovery_required，不覆盖现有文件；
- orphan sweep 的 active session exclusion 在每次提交前重新验证。

### 4. Backup/file operations

根据 Plan 00 inventory：

- async native snapshot 保留并纳入 disk lease/job；
- manifest JSON、hash、verify、rotation、旧 backup/artifact cleanup 进入 disk worker 或
  cooperative lane；
- restore 为独占 job，先关闭相关 DB handle，再复制/验证/重开；
- 普通 HTTP handler 不同步 `readdir/stat/readFile/hash/copy/rm` 大集合；
- 文件边界继续服从 ZERO_CORE_DIR/protected path/symlink guard。

### 5. 状态 API

Archive/backup endpoint 返回 job snapshot/reference，失败可通过统一 retry API恢复。字段至少
让后续 archive-observability UI 区分 queued/running/succeeded/failed/interrupted 和 phase，
但本阶段不实现前端。

### 6. 旧路径删除

- 删除大 payload `JSON.stringify → writeFileSync → readFileSync → JSON.parse` 主线程路径；
- 删除主线程全量 archive recovery/sweep；
- 删除只有 stderr log 的失败真相源；
- 保留小、固定大小 marker/rename 的 sync 使用时必须进入 allowlist 并有 bound 说明。

## 测试

- 大 Session（messages/steps/summaries/tool output）真实 export；
- 多 orphan、active exclusion、per-session failure isolation；
- cancel、worker crash、disk full、permission、corrupt tmp/final、hash conflict；
- final artifact 已写但 DB 未删、DB delete retry、幂等重启；
- backup snapshot/hash/verify/rotate/restore；
- 并发 HTTP/WS/Agent timer heartbeat；
- archive 既有 correctness/cascade tests。

## 完成定义

[Acceptance 04](acceptance-04-archive-file-operations.md) 通过并创建 `result-04.md`。
