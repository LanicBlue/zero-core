# Zero-Core 代码审查文档

> 审查日期：2026-06-02
> 审查范围：src/ 全量 + 构建配置
> 输出形式：5 份 markdown + 2 份 HTML 可视化

## 文档索引

| 文档 | 主题 | 适合谁看 |
|------|------|----------|
| [01-project-structure.md](01-project-structure.md) | 目录布局、构建管线、产出物 | 新人入门、构建相关问题 |
| [02-architecture.md](02-architecture.md) | 进程模型、IPC、状态管理、runtime/server 内部 | 架构调整、跨层修改 |
| [03-tech-debt.md](03-tech-debt.md) | 技术债清单（按严重程度分级） | 决定优先级、规划清理 |
| [04-recommendations.md](04-recommendations.md) | 建议的修复顺序与具体步骤 | 周末开搞 |
| [05-known-bugs.md](05-known-bugs.md) | 已暴露但未完全修复的问题 | 临时排障 |
| [visualization/overview.html](visualization/overview.html) | 模块依赖图（HTML） | 全局把握 |
| [visualization/call-graph.html](visualization/call-graph.html) | IPC 调用链（HTML） | 追踪具体路径 |

## TL;DR — 项目当前状态

**功能层面**：核心特性（agent runtime、单源真理 store、SQLite 持久化、MCP、知识库、工具系统、recovery）都已实现且能工作，不是空架子。E2E 烟测已经能跑通 chat + session 切换。

**结构层面**：分层是清晰的（main / preload / renderer / runtime / server / core / shared），但分层之间的边界**靠人治不靠类型**——[IpcContext 的 15 个字段全是 `any`](../src/main/ipc/types.ts)，[`typedHandle` 提供的类型安全是假象](../src/main/ipc/typed-ipc.ts)。

**主要风险**：
1. **fresh-DB 类 bug 容易复发**：刚修了 `AgentToolStore` 列同步和 `activeSessionId`，但模式问题（migration 列定义和 store 列定义两套）没根除
2. **`any` 类型泛滥**：378 处，public API 也有
3. **错误吞噬**：91 个 catch 块，大量 `catch {}`
4. **测试覆盖几乎为零**：仅 2 个 E2E 烟测，runtime/agent-loop、recovery、MCP、KB、tool 调用全部没有自动化测试
5. **god 文件**：[AgentEditor.tsx (688 行)](../src/renderer/components/agents/AgentEditor.tsx)、[SettingsPage.tsx (667 行)](../src/renderer/components/settings/SettingsPage.tsx)、[session-handlers.ts (9 个独立操作)](../src/main/ipc/session-handlers.ts)

**已经潜伏的 bug**：见 [05-known-bugs.md](05-known-bugs.md)。

## 阅读顺序建议

- **第一次接触项目**：01 → 02 → 打开 overview.html
- **要修 bug**：05 → 02 对应章节
- **要重构 / 还技术债**：03 → 04
- **要加新功能**：02 → 看 visualization/call-graph.html 找参考路径
