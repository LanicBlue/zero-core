# Plan 03：Wiki 重数据库操作隔离

## 目标

把 Wiki full index、大 incremental diff、FTS rebuild/optimize、integrity/foreign key check
从 backend 主线程迁到持有独立 `wiki.db` connection 的 worker，同时保持 Wiki Final 的原子
revision、stable identity、curated content、授权和审计语义。

## 实施范围

### 1. Worker-compatible Wiki operation

从现有 service 中提取固定、可测试的 operation module：

- `wiki_full_index`
- `wiki_incremental_index`
- `wiki_fts_rebuild`
- `wiki_integrity_check`
- 经 Plan 00 证明超预算的 optimize/analyze/backup verify 操作

module 不依赖 Express、AgentService 或不可序列化 Store instance。worker 接收小 descriptor，
自己打开 connection、构造局部 repository/statement、运行并关闭。

### 2. Git 输入

- host 验证 Project、repository binding、root、target revision 和 expected binding revision；
- worker 自己执行固定 Git plumbing 或读取受控 spool；
- 不从主线程发送整个 Git tree/diff；
- Git 参数使用 argv，不拼 shell；
- symlink/protected path 继续服从 Wiki Final；
- progress 按 tracked entries/ops 限频上报。

### 3. Writer lease 与普通请求

- heavy operation 开始前获取 `wiki_writer_worker` + disk-heavy lease；
- 主线程 Wiki connection 不使用长 busy timeout；
- WAL bounded reads 继续服务；
- 普通短写进入有界 FIFO，保留原 caller、authorization、expected revision 和 AbortSignal；
- heavy transaction 完成后重新验证并 drain，不能按排队时的过期权限/revision直接写；
- caller cancel 只移除其尚未执行的短写，不取消 heavy job；
- 未知外部 SQLite lock 走 stable busy + async retry，不同步睡眠。

### 4. 原子索引

full/diff worker 继续满足：

- 失败/取消不推进 `indexed_revision`；
- 读者只看到上一个 committed snapshot；
- rename 保留 stable node identity、curated summary/content、links；
- FTS、source binding、directory/project summary 与 revision 同事务；
- audit 不重复、不在 rollback 后伪留；
- worker connection close 后主线程才失效 cache/发布 domain event；
- 一个成功 job 最多发布一次索引 committed event。

循环内使用 shared cancel flag safe point；commit phase 后设置 `cancellable=false`。不得在事务中
加入 `await` 或改成分批半可见。

### 5. Maintenance API cutover

现有 sync handler 改为：

- 创建/dedupe job并返回 `202 + job snapshot`，或读取已存在 terminal result；
- status/cancel/retry 使用 Plan 01 API；
- integrity/FTS/optimize endpoint 不直接执行重 statement；
- 小 readonly metadata endpoint 仍可同步，但有 cap。

调用方需要同步等待结果时使用 supervisor waiter；waiter 可取消且不占主线程。不得保持一个
无 timeout 的 HTTP request 作为唯一状态来源。

### 6. Cache 与事件

- job progress 不触发 Wiki content cache invalidation；
- 只有经过 revision verification 的 successful commit 触发一次 invalidation；
- failure/cancel 保留旧 cache/revision；
- WS/data-change progress 与 Wiki content change 使用不同 event kind。

## 测试

- 100k full index + 并发 Wiki read、status HTTP、WS heartbeat；
- large diff、rename/swap、curated content、links、FTS；
- 并发短写 queue/revalidate/cancel/queue full；
- worker crash、transaction rollback、late terminal、commit phase cancel；
- FTS/integrity/optimize job API；
- DB busy/unknown external lock；
- cache/event exactly-once。

## 明确不做

- 不改变 Wiki schema/address/grant/tool 业务设计。
- 不引入 staging/generation 双真相源，除非 Plan 00 证据证明 worker 单事务无法满足硬门禁并
  先由用户更新设计。
- 不把 full tree structured-clone 给 worker。
- 不用长 busy timeout 或半提交换取表面成功。

## 完成定义

[Acceptance 03](acceptance-03-wiki-heavy-operations.md) 通过并创建 `result-03.md`。
