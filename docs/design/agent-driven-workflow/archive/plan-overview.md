# Plan Overview: Agent 驱动的工作流 — 实现里程碑

> **Status**: Draft v0.8 — 对应 RFC `agent-driven-workflow.md`
> **Level**: 实现计划(非 RFC 决策层;RFC 已定 54 条决策,本组文件把它们拆成可交付的 milestone)
> **配套 RFC**: `../agent-driven-workflow.md`

---

## 文件索引

| 文件 | 内容 |
|------|------|
| `plan-overview.md`(本文) | 拆分原则 / 依赖图 / 全局实现约束 / A0 通用前置 |
| `plan-M0.md` / `acceptance-M0.md` | 身份/上下文分离地基 + coding 场景全角色预设 |
| `plan-M1.md` / `acceptance-M1.md` | cron 一等公民 |
| `plan-M2.md` / `acceptance-M2.md` | 全局 wiki 记忆树 + archivist |
| `plan-M3.md` / `acceptance-M3.md` | Orchestrate 引擎 + lead 交付管线 |
| `plan-M4.md` / `acceptance-M4.md` | PM 产品管线 + discuss + 覆盖判断 |
| `plan-M5.md` / `acceptance-M5.md` | 归档提取者 + 记忆恢复(D-C) |

每个 milestone:plan 带「设计细节要求」(给实现者的硬约束),acceptance 带验收检查表(供审核)。

---

## 1. 拆分原则

1. **按严格依赖序,不按子系统切**。后一个 M 真正依赖前一个 M 的接口,而非只是「相关」。
2. **每个 M 是可独立验收的增量**。落完一个 M,系统比之前多一件确定能跑通的事。
3. **M0 是 v0.8 的根** —— 身份/上下文分离。没有它,cron/routing/wiki/orchestrate 全无落点。M0 同时纵向交付 coding 场景全角色预设(先有这帮人),机制在 M1-M5 陆续让它们「能干」。
4. **前端按耦合度分散进各 M**,不单列 M。
5. **每个 milestone 附「设计细节要求」** —— 给实现者的硬约束(字段名/签名/不变量/踩坑提醒),不是建议。

## 2. 依赖图

```
M0(身份/上下文分离 + 全角色预设)
 ├─ M1(cron 一等公民)          ──────────────┐
 ├─ M2(全局 wiki 树 + archivist) ─┼─ M3(Orchestrate + lead) ─ M4(PM + discuss + 覆盖判断)
 │                                 └─ M5(提取者 A/B + D-C)
 └─ M5 也依赖 M2(全局 memory 节点)
```

- M1 ∥ M2 可并行(都只依赖 M0)。
- M3 需 M0(delegateTask 扩展)+ M2(lead 读 wiki)。
- M4 需 M1(PM cron 驱动)+ M3(verify manifest)。
- M5 需 M0(session 存储)+ M2(全局 wiki memory 节点);逻辑放最后(对现有压缩链路理解最深)。

## 3. 全局实现约束(每个 M 都适用)

> 这些是已踩过的坑,实现期别破。

- **SQLite migration**:新增/删除 store 列时,**同步更新 `db-migration.ts` 的 `*_COLUMNS` 数组**(尤其 `AGENT_COLUMNS`),否则 fresh DB 缺列。
- **Build 验证必须跑 tsc**:`electron-vite build` 不做 TS 类型检查,改完跑 `npm run build:lib`。
- **不碰非自己的代码**:只改当前 milestone 涉及的文件,不相关文件被越权改动时告知用户,绝不自行 `git checkout`。
- **AgentLoop 禁止内联功能代码**:所有功能通过 hook 注册(PreLLMCall/PostTurnComplete),放在 `src/runtime/hooks/`。
- **Edit 工具在 Windows tab/CRLF 文件上频繁失败**:用 `cat -A` 诊断,Write 全文件作 fallback;优先 chunked Edit 而非整文件 Write。
- **better-sqlite3 必须按 Electron ABI 编译**(node-gyp 针对 Electron 版本,electron-rebuild 可能不生效)。
- **M1-M5 旧代码破坏性重构**:无真实数据,不写迁移脚本(RFC 决策 23)。旧 `analyst-service.ts` 等可重命名,但删/改前先确认是不是本 milestone 的范围。

## 4. A0 通用前置(每个 milestone 验收都查)

> 每个 `acceptance-M{N}.md` 的检查表前置,不重复列,统一在此核对。

- [ ] 本 M touched 的代码文件跑过类型检查 + 相关 lint
- [ ] `npm run build:lib`(tsc)无类型错误
- [ ] 相关 `tests/unit/**/*.test.ts` 与 `tests/e2e/**/*.spec.ts` 绿;新增 store/router/IPC 通道补了对应测试
- [ ] 新增/删除 store 列时,`db-migration.ts` 的 `*_COLUMNS` 已同步
- [ ] 未碰非本 M 范围的文件;若有越权改动已告知用户、未自行 `git checkout`
- [ ] AgentLoop 新功能通过 hook 注册(`src/runtime/hooks/`),未内联进 loop

## 5. 交付顺序建议

1. M0(必须先做,且包含全角色预设)。
2. M1 ∥ M2 并行。
3. M3。
4. M4。
5. M5(逻辑放最后)。

每个 M 落完跑对应 `acceptance-M{N}.md` + A0 通用前置 + `npm run build:lib`(tsc)+ 相关 unit/e2e。
