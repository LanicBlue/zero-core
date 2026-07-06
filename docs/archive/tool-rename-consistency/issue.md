# Issue:工具改名一致性

- **状态**:✅ 已合并 master(2026-07)→ [design](./tool-rename-consistency.md) · [plan](./)
- **提出**:2026-06
- **类型**:机制加固(非 tech-debt,无缺陷在跑)

## 问题

工具名(如 `Agent` → `Subagent`)在代码库有**多个真相源**,改名时必须全部手动同步。

## 事故

e8128d8 把子代理委派工具 `Agent` → `Subagent` 时,漏改 `ALL_TOOLS` 对象 key,导致:
- `/tools` API 仍返回 `Agent`(注册 key 决定 API 名)。
- Agent Editor TOOLS 面板仍显示 "Agent"。
- 注册 key 与工具内部 `name` 字段不一致。

2026-06 已全量修复(8 处同步 + 957/957),但根因(多真相源 + 手动同步)仍在。

## 真相源清单

| # | 位置 | 文件 | 必须同步? |
|---|------|------|-----------|
| 1 | 工具 def `name:` 字段 | 各工具文件 | 是(源头) |
| 2 | `ALL_TOOLS` 对象 key | `src/runtime/tools/index.ts` | 是(→ API 名) |
| 3 | `CONDITIONAL_TOOLS` key | `src/runtime/tools/index.ts` | 是(⊆ #2) |
| 4 | `RENAMED_TOOLS` 迁移 map | `src/core/tool-registry.ts` | 故意保留旧名 |
| 5 | `TOOL_DISPLAY_NAMES`/`TOOL_SUMMARY_KEY` | `src/renderer/components/chat/message-blocks.tsx` | 可选 |
| 6 | 种子策略 tools keys | `src/server/builtin-role-templates.ts` | 是(或靠 #4) |
| 7 | 源码契约测试 | `tests/unit/p2-agent-runtime.test.ts` | 改名时手动 |
| 8 | `DEFAULT_ENABLED_TOOLS` | `src/runtime/tools/index.ts` | 仅基础工具 |

## 当前状态

- 全仓工具 def 内部 `name:` 已与 `ALL_TOOLS` key 一致,**无其它工具带隐患**。
- `CONDITIONAL_TOOLS` keys 全部 ⊆ `ALL_TOOLS` keys。
- `getToolName(def)` 已存在(`tool-factory.ts`,读 `__name`);`ALL_TOOLS[name]` 仅 2 处动态访问 → 派生 key 结构上可行。

## 下一步

进入 `docs/design/` 细化加固方案(契约测试 / 派生 key / 全量单一来源)。
