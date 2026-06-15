# tests/unit — 单元测试套件

## 核心功能
Vitest 单元测试，运行在 Node 环境（`vitest.config.ts` 中 `environment: "node"`、`include: ["tests/unit/**/*.test.ts"]`）。验证 `src/` 下各模块的纯函数逻辑、router HTTP 契约与 IPC 代理映射一致性，不启动 Electron。

## 输入
- 被测源码：`../../src/runtime/*`、`../../src/server/*`、`../../src/core/*`
- preload / ipc-proxy 源码（rest-routers.test.ts 读取做契约校验）
- 内存 MockStore（复刻 better-sqlite3 的 SQL 行为）

## 输出
- Vitest 测试报告（通过/失败 + 断言明细）
- 纯函数逻辑正确性与 HTTP/IPC 契约一致性的验证结果

## 文件清单

- `agent-utils.test.ts` — agent 工具函数
- `chat-store.test.ts` — chat 存储
- `compression-engine.test.ts` — `CompressionEngine.identifyTurns`（turn 切分）与 `shouldCompress`（阈值判断）
- `context-message.test.ts` — `buildContextMessage` 的 section 顺序与 `<context>` 包裹
- `default-prompt.test.ts` — 默认 prompt 构造
- `memory-node-store.test.ts` — `MemoryNodeStore` 内存 MockStore 复刻的 node/subject/edge 行为（better-sqlite3 为 Electron ABI 无法在 Node 直接加载）
- `memory-recall.test.ts` — `MemoryRecall.recall`（去重 / 过滤 null subject）与 `formatForContext`（markdown 格式化）
- `model-registry.test.ts` — `findMatch` 模型匹配（精确 / 日期后缀剥离 / 子串阈值 / multimodal 检测）
- `provider-factory.test.ts` — provider 工厂
- `rest-routers.test.ts` — chat/session/file/log/tool-execution/mcp/memory router 端点 + IPC 代理通道完整性 + backend 协议
- `session-metrics.test.ts` — `RunningStats` 在线统计与 `SessionMetricsHolder` 累积/快照

## 运行方式

```bash
npm run test:unit           # vitest run（单次）
npm run test:unit:watch     # vitest（watch 模式）
```

## 依赖

- `vitest`（`describe` / `test` / `expect` / `vi`）
- `express` + `node:http`（rest-routers.test.ts 启动临时 server）
- `node:fs`（rest-routers.test.ts 读取 preload / ipc-proxy 源码做契约校验）
- 被测源码：`../../src/runtime/*`、`../../src/server/*`、`../../src/core/*`

## 定位

测试金字塔中层：覆盖纯函数逻辑与 HTTP/IPC 契约，速度快、无 Electron 依赖。与 `tests/e2e/`（端到端真实进程集成）互补。涉及 SQLite 的模块（如 `memory-node-store`）因 better-sqlite3 ABI 限制，用内存 MockStore 复刻 SQL 行为进行测试，真正的 SQL 集成由 e2e 覆盖。

## 维护规则

- 新增 `src/` 下的纯函数或 router 必须补充对应 `*.test.ts`
- 新增 IPC 通道需在 `rest-routers.test.ts` 的 `ROUTE_MAP` 中登记，否则通道映射测试失败
- 新增 router 端点需在 `rest-routers.test.ts` 补充 request 测试（含参数校验与路径穿越）
- 内存 MockStore（memory-node-store.test.ts）行为必须与 `MemoryNodeStore` 的 SQL 实现保持一致，SQL 行为变更需先同步 MockStore
- `vitest.config.ts` 的 `include` 模式变更需评估是否漏跑新增测试
