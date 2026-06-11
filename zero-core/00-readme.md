# Zero-Core 架构文档

> 从架构师视角，基于代码（而非历史 docs）重新梳理的项目架构分析。

---

## 文档地图

```
zero-core/
├── 01-overview/             # 总览：定位、形态、关键指标
│   ├── 01-product-overview.md      # 产品定位、用户场景、运行形态
│   ├── 02-tech-stack.md            # 技术栈选型
│   └── 03-metrics.md               # 代码规模、模块体量数据
│
├── 02-architecture/          # 架构：宏观结构与核心机制
│   ├── 01-topology.md              # 三进程拓扑、模块划分
│   ├── 02-process-model.md         # 进程生命周期与交互
│   ├── 03-layering.md              # 分层与依赖方向
│   ├── 04-typed-contracts.md       # 跨进程类型契约
│   └── 05-bootstrap.md             # 启动编排
│
├── 03-process-flows/         # 关键流程
│   ├── 01-agent-run-loop.md        # Agent 主循环
│   ├── 02-stream-event-pipeline.md # 流式事件分发
│   ├── 03-tool-execution.md        # 工具调用
│   ├── 04-subagent-delegation.md   # 子 Agent 委派
│   ├── 05-context-management.md    # 上下文/压缩/记忆
│   └── 06-data-flow.md             # 数据生命周期
│
├── 04-modules/               # 模块级深度解读
│   ├── 01-core.md                  # core/ 基础设施
│   ├── 02-runtime.md               # runtime/ 运行时
│   ├── 03-server.md                 # server/ 服务层
│   ├── 04-main.md                   # main/ Electron 主进程
│   ├── 05-preload-renderer.md      # preload + renderer
│   └── 06-shared.md                 # shared/ 契约
│
├── 05-data/                  # 数据架构
│   ├── 01-sqlite-schemas.md        # 表结构
│   ├── 02-migration-strategy.md    # 迁移策略
│   └── 03-data-flow-diagrams.md    # 数据流图
│
├── 06-decisions/             # 架构决策记录 (ADR)
│   ├── 01-electron-architecture.md # 为什么 Electron + 子进程后端
│   ├── 02-hook-driven-extension.md # 为什么 Hook 驱动扩展
│   ├── 03-runtime-as-source-of-truth.md # 运行时即真相
│   ├── 04-storage-strategy.md      # SQLite + JSON 混合存储
│   ├── 05-streaming-events-design.md # 流式事件契约
│   └── 06-provider-abstraction.md  # Provider 抽象
│
└── 07-evolution/             # 演进视角
    ├── 01-extension-points.md      # 扩展点
    ├── 02-known-issues.md          # 已观察到的设计权衡
    ├── 03-recommended-improvements.md # 演进建议
    └── 04-testing-strategy.md      # 测试策略与不足
```

---

## 阅读建议

| 你是谁 | 先看 |
|--------|------|
| **新加入的工程师** | `01-overview/` → `02-architecture/01-topology.md` → `03-process-flows/01-agent-run-loop.md` |
| **需要做功能** | `04-modules/` 对应模块 → `07-evolution/01-extension-points.md` |
| **排查 Bug** | `03-process-flows/` 找相关流程 → `06-decisions/` 理解为何这样设计 |
| **评估代码质量** | `01-overview/03-metrics.md` → `07-evolution/02-known-issues.md` |
| **重构 / 演进** | `06-decisions/` → `07-evolution/03-recommended-improvements.md` |

---

## 一句话架构总结

Zero-Core 是一个 **三进程、双边契约、运行时为真相** 的 AI Agent 桌面应用：

- **主进程**（Electron）只负责窗口与少量原生能力（登录、文件选择）
- **后端子进程**（Node.js）承担全部业务逻辑：Agent 循环、工具调用、持久化、HTTP/WS API
- **渲染进程**（React）是纯展示层，通过 `window.api` 拿到的是一份**完全类型化**的 IPC 契约
- **可执行真相** 在 `runtime/AgentLoop` 内存里，DB 是它的 checkpoint 仓库；**不是**反过来。
