# Wiki System Redesign 实施复审建议（Round 3）

> 复审日期：2026-07-19  
> 复审 HEAD：`9db8627`  
> 复审范围：round-2 Choice B 修复、关键 Wiki E2E 替代覆盖、最终门禁证据  
> **结论：CHANGES REQUIRED**

## 1. 结论摘要

Choice B 的总体测试分层是合理的：

- G4/G5 的 StepEnd 时序不变量由真实 `AgentLoop` runtime integration 测试负责；
- REST/UI publish、项目绑定和 preview 接线由 Playwright 负责；
- fresh-env 的 Wiki tool call 与 Git rename + sync 分别由 tool-wiring 和
  wiki-management 接管。

本轮定向复验确认这些 Wiki 关键路径通过。但是，当前 HEAD 的完整 E2E 套件并未
闭环：`error-handling.spec.ts` 有 3 个可稳定复现的失败，而 `result-final.md`
却将完整 E2E 记录为通过，并错误标注了唯一 skip 的来源。因此当前不能维持最终
PASS。

## 2. 实际复验结果

### 2.1 Wiki 关键 Playwright 路径

执行：

```text
npx playwright test tests/e2e/tool-wiring.spec.ts tests/e2e/wiki-management.spec.ts --grep "Wiki expand|§G\.1|§G\.5" --reporter=list
```

结果：

```text
3 passed
exit 0
```

通过项：

- Wiki tool 通过 `expand memory://` 命中 Agent 自身 memory root；
- §G.1 Git rename 后新 canonical path 可读，旧 path 返回 `NOT_FOUND`；
- §G.5 multi-project binding 与 active/inactive project grant preview 正常。

### 2.2 G4/G5 runtime boundary

执行：

```text
npx vitest run tests/unit/wiki-v2-runtime-session-boundary.test.ts --pool=forks --maxWorkers=1
```

结果：

```text
1 file passed
12 tests passed
exit 0
```

这组测试使用真实 `AgentLoop` 和 latch-blocked tool fixture，能够覆盖 Playwright
难以稳定到达的 mid-tool-call / StepEnd revision boundary。Choice B 在这一部分
符合批准后的测试契约。

### 2.3 E2E skip 与 error-handling 复验

执行：

```text
npx playwright test tests/e2e/context-usage-real-api.spec.ts tests/e2e/error-handling.spec.ts --reporter=list
```

结果：

```text
3 failed
1 skipped
exit 1
```

三个失败均来自：

```text
tests/e2e/error-handling.spec.ts
```

失败原因相同：选择器

```css
.chat-input-bar button:not(.btn-abort)
```

同时命中 `.btn-attach` 和 Send，Playwright strict mode 报错。

唯一 skip 实际来自：

```text
tests/e2e/context-usage-real-api.spec.ts
```

它由 `ZERO_CORE_E2E_REAL_API` 环境变量控制，默认跳过。`error-handling.spec.ts`
不存在 `test.skip`。

### 2.4 静态状态

```text
git status --short  -> clean
git diff --check    -> exit 0
```

## 3. 必须修复的问题

### P1-1：修复 error-handling 的 Send 选择器

位置：

```text
tests/e2e/error-handling.spec.ts:49
tests/e2e/error-handling.spec.ts:63
tests/e2e/error-handling.spec.ts:80
```

当前：

```ts
window.locator(".chat-input-bar button:not(.btn-abort)")
```

应改为不会命中附件按钮的稳定选择器。可采用：

```ts
window.getByRole("button", { name: "Send" })
```

或者统一复用已经排除 `.btn-attach` 的共享 helper。三处必须一起修复，并增加
防止新输入按钮再次造成歧义的稳定定位约定。

### P1-2：重新生成真实的最终门禁证据

`result-final.md` 当前存在以下事实错误：

1. 声称完整 `npm run test:e2e` 为 `87 passed / 1 skipped`；
2. 将唯一 skip 错写为 `error-handling.spec.ts`；
3. §2 仍保留“跑后填”；
4. §3 仍保留“跑完后补”；
5. 门禁基线是 `b022e52`，但其后的 `9db8627` 又修改了测试文件，因此最终测试树
   没有被所记录的完整门禁覆盖。

必须先完成所有代码和测试修复并提交，再在该确定 SHA 上执行完整门禁。随后允许
只增加结果文档 commit；结果文档必须明确：

- 被测试的精确 SHA；
- 从该 SHA 到结果文档 commit 之间只有文档变化；
- 每条命令的 exit code 和真实计数；
- 每个 skip 的文件、case、触发条件和非阻塞理由；
- 不得保留“跑后填”“跑完后补”等占位文本。

### P2-1：G1 reindex wait 必须只在 `synced` 时成功

位置：

```text
tests/e2e/wiki-management.spec.ts:259
```

当前：

```ts
if (entry?.syncStatus !== "indexing") break;
```

该逻辑会把以下状态都当成“可以继续”：

- `pending`；
- `failed`；
- 项目记录尚未出现在列表；
- 未来新增的其他非 `indexing` 状态。

应与同文件 `bindAndIndex` 的契约一致：

```text
syncStatus === synced  -> 成功返回
syncStatus === failed  -> 立即抛错并附 lastError
其他状态               -> 继续轮询
超时                   -> 抛 projectId/status/indexedRevision 诊断
```

后续 NEW/OLD path 读取重试不能替代同步状态检查；它们验证的是索引结果，不负责
准确判定同步任务的生命周期。

### P3-1：修正文档中残留的 search 描述

以下说明仍称 NEW path 通过 search 验证：

```text
tests/e2e/wiki-fresh-env.spec.ts:404
docs/plan/wiki-system-redesign/acceptance-recommendations-r2.md:558
```

实际实现已经使用 `/api/wiki/read`。应同步改成 read，以免后续 agent 错误恢复
FTS/search 断言。

## 4. 修复顺序

建议按以下顺序执行：

1. 修复 `error-handling.spec.ts` 三处 Send 选择器；
2. 修复 §G.1 reindex 状态轮询；
3. 修正两处 search/read 文档残留；
4. 提交代码和测试，记录待验收 SHA；
5. 在该 SHA 上执行完整门禁；
6. 按实际输出重写 `result-final.md`；
7. 结果文档单独提交，确认门禁 SHA 之后没有新的源码或测试变化。

## 5. Round 3 通过条件

以下条件全部满足后，才可将本轮改判为 PASS：

- `error-handling.spec.ts` 三项全部通过；
- Wiki 定向五文件 E2E 无关键 skip，计数以真实运行结果为准；
- G4/G5 runtime integration 全部通过；
- 完整 `npm run test:e2e` exit 0；
- 唯一或其余 skip 均按实际文件和 case 逐项说明；
- `npm run typecheck` 通过；
- `npm run build:lib` 通过；
- `npm run check:links` 通过；
- 完整 `npm run test:unit` 按既定串行门禁通过；
- `git diff --check` 通过；
- `result-final.md` 与被测试 SHA、命令输出和 skip 事实一致；
- 最终工作树只包含预期变更且保持干净。

在这些条件满足之前，统一状态保持：

```text
CHANGES REQUIRED
```
