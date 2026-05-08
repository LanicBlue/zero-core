# Zero-Core 深度定制 — 整体路线图

## 原则

- 逐个模块规划 → 确认 → 实现 → 验证 → 下一个
- 每个模块深入到：函数签名、数据结构、调用链、边界条件
- 已完成的模块为后续模块提供实际代码基础

## 模块依赖关系

```
config.ts (基础)
  ├── persona.ts (依赖 config)
  ├── project-context.ts (独立)
  ├── system-prompt.ts (依赖 config + persona + project-context)
  ├── context-manager.ts (依赖 config)
  ├── tool-policy.ts (依赖 config)
  ├── compaction.ts (依赖 config)
  ├── provider-adapter.ts (依赖 config)
  ├── input-handler.ts (依赖 config)
  ├── custom-tools.ts (依赖 config)
  └── extension/index.ts (依赖所有 core 模块，最后实现)
```

## 实施顺序

| 序号 | 模块 | 定制点 | 说明 |
|------|------|--------|------|
| 1 | config.ts | 基础 | 扩展配置项，所有模块的基础 |
| 2 | persona.ts | 定制点 1 | Agent 人设定义 |
| 3 | project-context.ts | 定制点 1 | 项目上下文自动发现 |
| 4 | system-prompt.ts | 定制点 1 | System Prompt 分层组装 |
| 5 | context-manager.ts | 定制点 2 | Smart 上下文裁剪 |
| 6 | tool-policy.ts | 定制点 3+4 | 工具拦截 + 结果转换 |
| 7 | compaction.ts | 定制点 5 | 自定义压缩指令 |
| 8 | provider-adapter.ts | 定制点 6 | Provider 请求适配 |
| 9 | input-handler.ts | 定制点 9 | 用户输入预处理 |
| 10 | custom-tools.ts | 定制点 7 | 自定义工具 |
| 11 | extension/index.ts | 定制点 8+统合 | 自定义命令 + 注册全部钩子 |
| 12 | cli.ts | 收尾 | 默认配置文件生成 |

## 执行进度

| 序号 | 模块 | 状态 | 完成日期 |
|------|------|------|----------|
| 1 | config.ts | 完成 | 2026-05-07 |
| 2 | persona.ts | 完成 | 2026-05-08 |
| 3 | project-context.ts | 完成 | 2026-05-08 |
| 4 | system-prompt.ts | 完成 | 2026-05-08 |
| 5 | context-manager.ts | 完成 | 2026-05-08 |
| 6 | tool-policy.ts | 完成 | 2026-05-08 |
| 7 | compaction.ts | 完成 | 2026-05-08 |
| 8 | provider-adapter.ts | 完成 | 2026-05-08 |
| 9 | input-handler.ts | 完成 | 2026-05-08 |
| 10 | custom-tools.ts | 完成 | 2026-05-08 |
| 11 | extension/index.ts | 完成 | 2026-05-08 |
| 12 | cli.ts | 待规划 | - |
