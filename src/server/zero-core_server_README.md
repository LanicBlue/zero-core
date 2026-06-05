# server

## 核心功能
服务层，提供 HTTP/WS 服务器、数据持久化（SQLite）、Agent/会话/MCP/知识库/模板等所有业务实体的 Store 和 Router，以及会话生命周期管理、指标采集和恢复机制。

## 输入
IPC/REST API 请求、SQLite 数据库、运行时事件

## 输出
HTTP/WS 服务、SQLite 持久化、REST API 路由、会话管理

## 定位
src/server/ — 服务层，连接 runtime 运行时与 main IPC 层

## 依赖
../core（配置、常量）；../runtime（AgentLoop、Session）；better-sqlite3（SQLite）；express、ws（HTTP/WS 服务）

## 维护规则
- 新增数据库表需在 db-migration.ts 中添加迁移
- 新增 REST API 需创建对应 router 并在 index.ts 中注册
- Store 的列定义需与 db-migration.ts 的 *_COLUMNS 数组同步
- SQLite 操作需注意异步与事务处理
