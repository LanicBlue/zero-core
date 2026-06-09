# Zero-Core 文档

> 最近更新：2026-06-09

## 文档索引

| 文档 | 主题 | 适合谁看 |
|------|------|----------|
| [01-project-structure.md](01-project-structure.md) | 目录布局、构建管线、产出物 | 新人入门 |
| [02-architecture.md](02-architecture.md) | 进程模型、IPC、状态管理、runtime/server 内部 | 架构调整、跨层修改 |
| [03-tech-debt.md](03-tech-debt.md) | 剩余技术债（中/低优先级 + 长期项） | 规划清理 |
| [05-known-bugs.md](05-known-bugs.md) | 未修问题 + 排查 cheat sheet | 排障   |
| [tool-guide.md](tool-guide.md) | 15+ 工具的参数、配置、输出示例（57 测试） | 理解工具行为 |

## 可视化

| 文件 | 说明 |
|------|------|
| [tool-playground.html](visualization/tool-playground.html) | 交互式工具演练台（双击打开即用，内置虚拟文件系统） |
| [code-graph.html](visualization/code-graph.html) | 代码大纲 + 调用关系（`npm run build:codegraph` 生成） |

## 项目状态

- **244 文件 / ~29,500 行** TypeScript + React + Electron
- **85 单元测试 + 8 E2E 路径** — vitest + Playwright
- **57 工具配置测试** — `npx tsx scripts/test-tool-output.ts`
- 止血/补完/架构阶段全部完成，剩余为中/低优先级技术债
