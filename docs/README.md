# Zero-Core 代码审查文档

> 最近审查：2026-06-02
> 文档最近重写：2026-06（清理 + 重分析）
> 审查范围：src/ 全量（212 文件）+ 构建配置 + 测试套件
> 输出形式：5 份 markdown + 1 份代码大纲 + 调用关系可视化

## 文档索引

| 文档 | 主题 | 适合谁看 |
|------|------|----------|
| [01-project-structure.md](01-project-structure.md) | 目录布局、构建管线、产出物 | 新人入门、构建相关问题 |
| [02-architecture.md](02-architecture.md) | 进程模型、IPC、状态管理、runtime/server 内部 | 架构调整、跨层修改 |
| [03-tech-debt.md](03-tech-debt.md) | 技术债清单（按严重程度分级） | 决定优先级、规划清理 |
| [04-recommendations.md](04-recommendations.md) | 建议的修复顺序与具体步骤 | 周末开搞 |
| [05-known-bugs.md](05-known-bugs.md) | 已暴露但未完全修复的问题 | 临时排障 |
| [visualization/code-graph.html](visualization/code-graph.html) | 代码大纲 + 调用关系（Outline + Calls） | 浏览函数 / 追踪调用链 |

生成命令：`npm run build:codegraph`

## TL;DR — 项目当前状态（2026-06 重分析）

**功能层面**：核心特性（agent runtime、单源真理 store、SQLite 持久化、MCP、知识库、工具系统、recovery）都已实现且能工作。E2E 覆盖 8 条路径（单轮、多轮、error banner、session 切换/删除/活跃删除），85 个单元测试覆盖纯逻辑模块。

**质量层面**：止血阶段（R1-R8）和补完阶段（todos 渲染、search-provider 配置、god 文件拆分、硬编码抽常量、IpcContext 类型化）全部完成。剩余的"中等优先级" bug（B3/B4/B8）也已清掉。

**当前剩余的债**：
1. **`any` 仍有 348 处**（195 `: any` + 153 `as any`）— IpcContext 已修复，剩余主要在 agent-loop.ts (28)、main/ipc/core.ts (22)、mcp-handlers.ts (18)
2. **测试覆盖仍偏窄**：85 单测 + 2 E2E，runtime/agent-loop、recovery、MCP、KB 仍依赖 E2E 兜底（因 better-sqlite3 native 模块版本限制，单测无法直接覆盖 SQL 模块）
3. **agent-loop.ts 784 行**：仍是单文件最大模块（retry + streaming + tool 调度都在里面），但拆分 ROI 低
4. **R7 MiniMax/GLM preset**：用户判定不值得做（体验问题，不影响正确性）
5. **R13/R14/R15 长期项**：双构建整合 / preload capability 分级 / schema 单源 — 都属于"可做可不做"

**已知未修 bug**：见 [05-known-bugs.md](05-known-bugs.md)，全部是非阻塞的（E2E 覆盖窄、error banner UI 等）。

## 2026-06 已完成清单

详见 [04-recommendations.md](04-recommendations.md)。简版：

- ✅ **R1** SqliteStore self-heal（[sqlite-store.ts](../src/server/sqlite-store.ts)）
- ✅ **R2** handler modules AST 校验脚本（[scripts/check-handler-modules.ts](../scripts/check-handler-modules.ts)）
- ✅ **R3** 真·静默 catch 加 log（5 处）
- ✅ **R4** env-dump.txt 删除 + .gitignore 完善
- ✅ **R5** chat-store 单源化（移除双状态 + selector）
- ✅ **R6** IpcContext 类型化（15 字段 any → 真类型，顺带修 3 个被 any 掩盖的 bug）
- ✅ **R8** AppLayout dispatcher map 重构
- ✅ **R9** vitest 基础设施 + 85 单测
- ✅ **R10** provider-factory + session-metrics 单测（32 个）
- ✅ **R12** god 文件拆分（SettingsPage 667→119、AgentEditor 688→337、template-handlers 188→47）
- ✅ **#6** public API 的 `any` 替换（parseThinkingTags、files:tree）
- ✅ **#12** 硬编码 URL/magic number 抽到 [src/core/constants.ts](../src/core/constants.ts)
- ✅ **todos 渲染补完**（AppLayout dispatcher + ChatPanel render）
- ✅ **search-provider 配置**（IPC + UI + 启动初始化）
- ✅ **B3** stuck pending turn 自动清理（24h cutoff）
- ✅ **B4** MCP reconnect 错误 log
- ✅ **B8** KV migration 单个失败不阻断后续

## 阅读顺序建议

- **第一次接触项目**：01 → 02 → 打开 code-graph.html 看代码大纲
- **要修 bug**：05 → 02 对应章节
- **要重构 / 还技术债**：03 → 04
- **要加新功能**：02 → 用 code-graph.html 搜函数名找参考路径
