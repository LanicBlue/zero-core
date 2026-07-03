# conventions — 实现规约(冷启动必读)

> 本努力的实现/验收 subagent 必读。这些是项目级硬规约,不在 design 正文里,但实现时必须遵守。

## 构建与验证
- **三层 tsc 类型检查**:`tsconfig.cli` / `tsconfig.web` / `tsconfig.node` 全过。`electron-vite build` **不做**类型检查,必须额外跑 `npm run build:lib`(tsc)才算类型验证。
- **单元测试**:`npx vitest run`(全绿 + 新增用例)。
- **e2e**:Playwright + Electron + mock provider,经 `ZERO_CORE_TEST_FIXTURE` 环境变量进入测试模式;e2e 跑**构建产物**(先 build)。MiniMax 是测试专用 provider(生产环境不是 MiniMax)。
- 提交前:`npm run build:codegraph` 重生成 code-graph + 更新 `docs/arch/`(尤其 code-graph.html)。

## SQLite / 数据
- **查 sessions.db 必须只读**;backend 占用时**绝不 checkpoint WAL**,否则未提交 WAL 回滚丢数据。
- **新增 SqliteStore 列**必须同步 `src/server/db-migration.ts` 的 `*_COLUMNS` 数组,否则 fresh DB 缺列。
- **better-sqlite3** 必须用 `node-gyp` 针对 Electron 版本编译(`electron-rebuild` 可能不生效)。

## 代码风格 / 边界
- **英文代码注释**。
- **不动非本任务的他人代码**;不相关文件被越权改动时告知用户,绝不自行 `git checkout` 恢复或删除他人改动。
- **AgentLoop 禁止内联功能代码**:所有功能经 hook 注册(PreLLMCall/PostTurnComplete 等),放 `src/runtime/hooks/`。
- runtime 层(`src/runtime/`)**不反向 import** server 层(`src/server/`)——需要能力走依赖注入或经 agent-service 转发(见 plan-N1 task ping 走 agent:event 的理由)。

## Edit / 文件编辑
- Edit 工具在 **tab/CRLF 文件**上频繁失败:用 `cat -A` 诊断空白字符,fallback 到**整文件 Write**。
- ChatPanel.tsx 等 800+ 行 tab/CRLF 文件,**不大改内联渲染**;新视图走 `message-blocks.tsx` 规范模块。

## 提交
- **Co-Authored-By: Claude <noreply@anthropic.com>** 写在每条 commit 末尾。
- commit message **经 Bash `-F` 文件**(PowerShell here-string `@'..'@` 会注入字面 `@`)。
- 当前分支 `master`(主分支 `main`);只改本任务涉及的文件。

## 流程
- **不走 openprd** 命令/门禁;用工程常规(tsc + docs + vitest)。
- 遇需要产品决策的阻塞点:**停下向用户汇报**,不擅自定夺。

## 本努力的额外约定
- 状态推送:server 层对象走 hub(`emitDataChange`),runtime 层(TaskRegistry)走 `agent:event`(层级)。前端对所有 `runtime:*` 一视同仁 ping→pull。详见 [runtime-push-ui-sync.md §3.1](runtime-push-ui-sync.md)。
- 重连:renderer 驱动(收 `ws:reconnected` → 重拉可见 collection),无后端 resync 协议。
- UI 零轮询:数据路径无 `setInterval`(无 fetch 的本地时钟 timer 是允许的例外)。

## 编排与失败处理(orchestrator 用)
逐节点 N1→N2→N3/N4,每节点:实现者(subagent)→ 验收者(subagent)→ 通过则提交,不通过则回传循环。

- **无限循环(用户许可)**:验收不通过就一直回传循环,直到通过为止,**无轮次上限**。
- **回传要求**:验收者每轮给"具体未达项 + 复现 + 建议修法",实现者针对修;每轮须有实质进展。
- **立即停(问用户)**:仅当**需产品决策**(plan 没覆盖的取舍)或**动了非本任务文件且无法不越界修好**时停。其余(构建/测试/验收/回归失败)一律继续循环。
- **提交门(全过才提交)**:三层 tsc + build:lib + vitest(含新增)+ acceptance 逐条 + diff 不越界 + code-graph 重生成(涉及代码时)。任一未达不提交。
- **节点依赖**:N1 不过不进 N2(N2 依赖 N1);N3/N4 独立可并行。已过节点不回滚。
