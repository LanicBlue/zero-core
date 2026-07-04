# acceptance-F1 — Flow 工具骨架 + 读 · 测试要求

> 节点 F1 验收。对应 [plan-F1.md](plan-F1.md)。

## 完成判定
Flow 工具存在,`create`/`list`/`get` 可用,`create` 建 found 态需求并天然发 `requirements.create`;与旧工具并行不冲突。

## 单元测试(vitest)
1. **create**:`exec({action:"create", projectId, title, ...})` → 返回 record,status==="found";`requirementStore.get(id)` 命中。
2. **list**:`exec({action:"list", projectId})` → 返回该 project 需求列表;带 status/priority 过滤生效。
3. **get**:`exec({action:"get", id})` → 返回单条;不存在 → 友好错误。
4. **门控**:ctx 无 requirementStore → 工具不启用(buildToolsSet 不含 Flow,或 execute 报 "requires requirementStore")。
5. **created 信号**:create 后 data-change-hub 收到 `{collection:"requirements", op:"create"}`(经 spy/onDataChange 断言)——证明 created 天然到位。

## 集成 / 回归
- 既有 CreateRequirement / CreateRequirementWithDoc / verify 工具仍注册可用(并行,F1 不替换)。
- 既有 requirement / agent-service 用例全绿。

## 静态 / 门禁
- 三层 tsc(cli/web/node)+ build:lib + vitest 全绿。
- diff 不越界(只动 flow-tool.ts 新增 + tools/index.ts + agent-service.ts 一行 + 新测试)。

## 不在本阶段
- 迁移 action 与 hook 信号扩展(→ F2)。
- 替换旧工具(→ F3)。
