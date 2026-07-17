# 11 · 质量属性与验证基线

> 核对基线：2026-07-16。仓库没有可复现的性能 benchmark，因此本文不把历史估算写成“当前实测”或 SLO。目标值必须在建立测量方法后再承诺。

## 1. 当前优先级

从代码和测试体现出的实际取舍是：

1. **本地可控与功能可演进**：本地数据、可替换 Provider、工具与 MCP 扩展。
2. **会话可恢复性**：step 级持久化、归档恢复和 delegated task 状态。
3. **桌面交互响应**：业务后端与 Renderer 分进程，模型流增量推送。
4. **一致性与安全**：已有局部护栏，但还没有统一威胁模型和 crash-consistency 协议。

安全不能因为排序靠后就被视为可忽略；Shell、文件、Skill 和本地 HTTP API 都能产生真实系统副作用。

## 2. 可验证的工程基线

| 维度 | 当前证据 | 仍缺什么 |
| --- | --- | --- |
| 类型正确性 | `npm run typecheck` 覆盖 CLI/Web/Node 三套配置 | 没有 CI 自动执行 |
| 单元/契约 | Vitest，覆盖 runtime、Store、router、迁移和 IPC 契约 | 大量测试依赖源码文本断言，重构时可能假阳性/假阴性 |
| 桌面链路 | Playwright Electron E2E | 平台与打包产物矩阵没有自动门禁 |
| 链接完整性 | `npm run check:links` | 只检查 `docs/` 内相对 `.md` 文件链接，不检查目录、anchor、源码或 HTML |
| 运行时指标 | provider usage、session metrics、tool telemetry 等分散记录 | 没有统一 trace id、导出和保留策略 |
| 行为质量 | mock language model 可做确定性场景 | 没有 trajectory/outcome eval suite |

当前仓库没有 `.github/workflows`；“本地测试存在”不等于“每个变更都被自动验证”。

## 3. 延迟

### 3.1 关键路径

```text
Renderer
  → preload invoke
  → Electron IPC proxy
  → backend HTTP router
  → AgentLoop / Provider queue
  → Provider stream
  → backend WebSocket
  → Electron IPC event
  → Renderer store/render
```

首 token 延迟主要受 Provider 排队、网络和模型影响；应用自身还增加两次跨进程桥接。工具延迟取决于 Shell、文件系统、网页或 MCP server，不能用一个统一数字描述。

### 3.2 已知延迟风险

- `better-sqlite3`、同步日志和部分同步文件操作会阻塞 backend event loop。
- Provider semaphore 是分层 FIFO；低优先级后台任务可能饥饿。
- Wiki 搜索是内存/SQLite 元数据读取后的线性子串匹配，不是 FTS 或向量索引。
- Renderer 用推送更新聊天，但数据域仍可能在切页或重连时重新拉取。

### 3.3 建议测量项

- 用户提交到首个 `text_delta` 的 P50/P95/P99。
- Provider queue wait 与 provider first-token 分开统计。
- 每类工具的 queue wait、执行时间和失败率。
- backend 启动、ready、Renderer 首次可交互时间。
- Wiki search 随节点数增长的曲线。

## 4. 吞吐与背压

- 每个 Provider 的最大并发由配置和 `ProviderConcurrencyManager` 控制。
- 优先级为用户交互高于 work/cron，高于 background。
- AgentLoop 对同一 session 使用 busy 状态和输入队列串行化。
- ToolRateLimiter 提供工具级限流。
- SQLite 与 backend event loop 仍是共享瓶颈。

当前不能声称“支持 N 个并发 session”；需要用固定硬件、固定 mock/Provider、固定工具负载做压力测试。特别要测中止后排队任务是否仍执行，以及 P3 background 在持续用户流量下的等待上界。

## 5. 数据完整性

### 当前保证

- `steps` 持久化模型与工具结果，可重建会话历史。
- 大工具输出使用内容哈希文件和受限虚拟路径。
- archive 使用锁、临时文件/rename 和 SQLite transaction 降低半成品风险。
- 数据库生产模式启用 WAL；测试使用内存 journal。
- 启动恢复会扫描未完成 session、workflow、archive 和孤儿工作区。

### 当前不保证

- SQLite 与文件 payload 的跨介质原子提交。
- 输入队列、AskUser 等交互等待的持久恢复。
- delegated task 自动续跑；启动时主要标记为 interrupted。
- WebSocket 断线期间事件重放。
- `messages` 摘要跨重启可靠保存；当前存在启动删表问题。

任何涉及用户数据的变更应先写 crash-point/reopen 测试，而不只测单进程 happy path。

## 6. 可用性与恢复

| 故障 | 当前行为 | 风险 |
| --- | --- | --- |
| backend 启动失败 | main 监听 ready/退出并有重启逻辑 | 缺少统一退避与用户可见诊断 |
| 运行中 backend 断开 | WebSocket 重连，部分 Store 重新拉取 | 重连期间事件丢失，部分 Store 不完整刷新 |
| Agent turn 中断 | session phase + steps 支持恢复 | 内存队列和外部副作用未必可重放 |
| delegated task 中断 | 持久状态改为 interrupted | 不自动恢复，需要显式操作 |
| archive 中断 | 启动恢复扫描 | 没有完整进度/结果 UI |
| uncaught exception | 记录日志 | 进程可能继续运行在未知状态 |

建议先定义每个域的 RPO/RTO，再实现统一 supervisor 策略；目前没有数据支持具体秒数承诺。

## 7. 安全

### 已有边界

- Electron 使用 context isolation，Renderer 不直接获得 Node API。
- 文件、附件、Skill 和大工具输出路径有不同程度的 containment 校验。
- 工具 policy 控制 Agent 可见工具；部分工具区分只读与外部 host 暴露。
- Wiki 外部调用可携带 scope/readOnly。

### 主要缺口

- backend HTTP/WS 的认证和监听边界不够明确。
- Shell 与 Skill 脚本没有操作系统级沙箱。
- Provider key、Cookie 和部分配置以本地明文保存。
- 日志没有统一 secret redaction。
- Electron webview、CSP、导航与权限策略没有形成可测试契约。
- 工具 rate limit 不是权限边界，abort 也未贯穿所有等待路径。

安全验证至少应包含路径穿越、符号链接、loopback API 越权、恶意 Skill、日志泄密和 Renderer 导航测试。

## 8. 可演进性

### 优势

- `buildTool`、ToolRegistry、MCP adapter 和 per-loop Hook 提供显式扩展缝。
- Shared IPC 类型与 router 契约测试能发现多数跨层遗漏。
- Store 层大多使用统一列定义和 CRUD 基类。
- mock Provider 让复杂 turn/step 场景可确定性测试。

### 限制

- 核心编排文件体积大，依赖注入和生命周期边界不清晰。
- schema 与迁移有多处真相源。
- preload、proxy、router、Renderer 仍需人工同步。
- 一些“能力”只有类型、订阅或 dormant service，没有生产接线。

评估可演进性时，应看“新增能力需要改几个事实源、能否由测试发现漏接”，不要用文件数量作为唯一指标。

## 9. 建议建立的质量门禁

### 每次变更

```bash
npm run typecheck
npm run test:unit
npm run check:links
```

涉及桌面交互、IPC、附件、Skill 或打包时追加：

```bash
npm run test:e2e
```

### 发布前

- 在目标平台执行安装包构建与启动冒烟。
- 用旧 profile 做数据库 reopen/upgrade 测试。
- 做 backend 重启、WebSocket 断线、Provider 超时和中止测试。
- 检查日志、归档和诊断包是否含密钥或不必要的绝对路径。

### 建议新增

- CI：Node 基线、typecheck、unit、link check。
- 持久化：同一 DB reopen、迁移矩阵和 crash-point 测试。
- 性能：Provider queue、首 token、Wiki search、启动时间 benchmark。
- Agent eval：工具轨迹 + 最终 DB/文件副作用的确定性评分。
