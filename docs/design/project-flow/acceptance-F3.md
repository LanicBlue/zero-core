# acceptance-F3 — 拆 verify + work 重配 + 替换旧工具 · 测试要求

> 节点 F3 验收。对应 [plan-F3.md](plan-F3.md)。

## 完成判定
verify 工具复合逻辑消失;交付链全 hook 驱动(ready→交付 work、buildFinished→PM work、verified→合并 work、rejected→回灌);旧三工具被 Flow 取代;返工回路通。

## 单元测试(vitest)
1. **verify 复合逻辑已删**:verify-tool 不再 delegate/merge(grep 或结构断言);Flow.verify(通过)只迁态 closed + 发 verified,Flow.verify(打回)发 rejected。
2. **默认 work 重配**:
   - 需求管理 work 的 hook === `requirements.ready`(不是 create)。
   - PM 判断 work 存在,订阅 `requirements.buildFinished`。
   - 合并 work 存在,订阅 `requirements.verified`。
3. **hook 链端到端**(模拟):发 `requirements.ready` → 交付 work 被 fire;发 `requirements.buildFinished` → PM work 被 fire;发 `requirements.verified` → 合并 work 被 fire;发 `requirements.rejected` → 回灌路径命中。
4. **旧工具已替**:tools/index.ts 不再注册 CreateRequirement/CreateRequirementWithDoc/verify;Flow 是唯一需求流转工具。
5. **back-compat**:RENAMED_TOOLS 把 CreateRequirement/CreateRequirementWithDoc/verify → Flow;buildToolsSet 用旧名 policy 仍启用 Flow。
6. **返工**:Flow.verify(打回)→ requirement message 写入意见 + 发 rejected;交付 work contextPolicy.injectRequirementDetail 能读到意见。

## 集成 / e2e / 手动
- 端到端 delivery:create(Found)→ pick(Discuss)→ ready(Ready,fire 交付)→ plan→ startBuild→ finishBuild(fire PM)→ PM work 判断 → verify(fire 合并)→ 合并 work merge→closed。整条通。
- 返工:PM 打回 → 意见回灌 → 交付 work 重提 finishBuild。
- 既有 project 补 seed PM/合并 work(否则断链)。

## 静态 / 门禁
- 三层 tsc + build:lib + vitest 全绿。
- diff 不越界(verify-tool 废逻辑、builtin-work-templates、tools/index、agent-service、tool-registry、测试)。

## 不在本阶段
- UI 看板/modal 接入(→ F4)。
- 删旧文件 + 注释(→ F5)。
