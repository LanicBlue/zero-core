# acceptance-F2 — 迁移 action + hook 信号 · 测试要求

> 节点 F2 验收。对应 [plan-F2.md](plan-F2.md)。

## 完成判定
Flow 7 个迁移 action 各自做合法状态迁移 + 副作用 + 发对应命名信号;ProjectWorkHookManager 能按命名信号匹配 work.hooks 并 fire。

## 单元测试(vitest)
1. **每迁移 action**:对 pick/ready/plan/startBuild/finishBuild/verify(通过)/verify(打回)各一测——迁移后 status 正确 + 对应命名信号经 emit/hub 发出(spy 断言)。
2. **副作用**:
   - pick:建文档 + docPath 绑定(record.docPath 非空)。
   - plan:feature worktree 创建(spy GitIntegration.createFeatureWorktree 或 LeadService.pickupRequirement)。
3. **状态机校验**:非法迁移(如 found→build 直接跳)→ transitionStatus 抛错 → Flow 返回友好 "Error: ..."。
4. **hook manager 命名信号匹配**:构造一个 work `hooks:[{event:"requirements.ready",...}]`,发 `requirements.ready` 信号 → ProjectWorkHookManager fire 该 work;发 `requirements.buildFinished` → 不 fire(除非也订了)。
5. **created 仍天然**:`create` 仍经 op=create 发 requirements.create(F1 行为不退)。

## 集成 / 回归
- 既有 hook manager 对 create/update/delete 的匹配不破(op 路径与命名信号路径并存)。
- requirement-store / state-machine / lead-service / pm-service 既有用例全绿。

## 静态 / 门禁
- 三层 tsc + build:lib + vitest 全绿。
- diff 不越界(flow-tool + hub + hook-manager + 测试;不碰 verify-tool 删除/旧工具替换)。

## 不在本阶段
- 拆 verify / work 重配 / 替换旧工具(→ F3)。
