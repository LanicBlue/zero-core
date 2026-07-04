# Hook 重做 · 编排索引

> 18:00 定时执行的入口。权威 spec:[hook-step-redesign.md](../hook-step-redesign.md)(背景/命名/恢复设计)。本文档是**执行编排索引**。

## 执行模型(编排者 = Claude,不亲自编码)
- **第一 commit = 文档保护**(已做):所有 design doc(spec + 本索引 + steps/)入库,作为初始状态保护点。
- 之后**逐 unit**:sub1(实现,Agent general-purpose,读该 unit 的 `impl.md`)→ sub2(验收,Agent general-purpose,读 `accept.md`)→ 全绿才 **commit 该 unit** → 下一个;红 → SendMessage 错误回 sub1 改 → 复验;卡死 → 停 + PushNotification。
- 每 unit 独立 green(typecheck 三层 + build:lib + vitest)+ 一次 commit。注释英文,带 `Co-Authored-By: Claude <noreply@anthropic.com>`。不 push。

## Unit 执行顺序(严格)
| # | Unit | 类型 | 备注 |
|---|---|---|---|
| 1 | [1A registry-infra](steps/1A-registry-infra/) | green | registry 实例化 + concat |
| 2 | [1B per-loop-registry-wiring](steps/1B-per-loop-registry-wiring/) | green | 接线 + registerHooksForLoop + 去 requirement(事件名不改) |
| 3 | [1C atomic-rename-ownership](steps/1C-atomic-rename-ownership/) | green | 14 hook 改名 + session 级移 agent-service(Phase 1 出口) |
| 4 | [2A spike-ai-sdk](steps/2A-spike-ai-sdk/) | **GATE** | GO → 继续;NO-GO → Phase 2 回退 + 通知,不硬干 |
| 5 | [2B per-tool-persist](steps/2B-per-tool-persist/) | green | 前置 2A GO |
| 6 | [2C step-loop-externalize](steps/2C-step-loop-externalize/) | green | 外置循环 + OnLLMError + step 重试(最高风险) |
| 7 | [2D step-resume](steps/2D-step-resume/) | green | step 级 resume + durable step 检查点 |
| 8 | [2E deferred-dangling-tasklink](steps/2E-deferred-dangling-tasklink/) | green | 延迟消费 + dangling 兜底 + task 链接(Phase 2 出口) |
| 9 | [3A compression-extraction-stepend](steps/3A-compression-extraction-stepend/) | green | 搬 StepEnd |
| 10 | [3B todo-metrics-turnend-postturncomplete-removal](steps/3B-todo-metrics-turnend-postturncomplete-removal/) | green | todo+metrics+TurnEnd 闭合+删 PostTurnComplete(Phase 3 出口) |
| 11 | [4A drop-turns-table](steps/4A-drop-turns-table/) | green | 退役 legacy turn API + 迁移(Phase 4 出口) |
| 12 | [5A arch-docs](steps/5A-arch-docs/) | green | 文档同步 |
| 13 | [5B codegraph-final-verify](steps/5B-codegraph-final-verify/) | green | code-graph + 总验证(总出口) |

## 全程约束
- typecheck 三层(tsconfig.cli/web/node)+ `npm run build:lib`(tsc)每 unit 绿;phase 出口加 vitest 全套。
- 不碰 `BUILTIN_WORKFLOW_ROLES` / `docs/rfc/*` / 他人代码;不 push。
- code-graph 提交前再生成;sessions.db readonly,backend 占用时不 checkpoint。
- DB 新列 5 处同步;Edit 失败用 Write 全文 fallback;commit 用 Bash `-F`。
- 相关 memory:project-hook-step-redesign、feedback-agent-loop-hooks-only、feedback-fresh-db-migrations、feedback-build-verification、feedback-edit-tool-whitespace、feedback-powershell-heredoc-commit、feedback-sessions-db-readonly。
