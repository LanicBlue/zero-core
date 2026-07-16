# Acceptance 07：管理 API 与配置 UI

对应 [Plan 07](plan-07-management-ui.md)。

## A. 管理边界

- [ ] 所有管理 endpoint 只接受 server 注入 authority；普通/UI 伪造字段无效。
- [ ] 普通 Wiki tool schema/data router 中不存在 address/repository/grant/context/publish action。
- [ ] validate/preview 无数据库 mutation/audit revision 增长。
- [ ] publish 使用 expected revision，冲突不覆盖他人修改。
- [ ] 每项管理 mutation 有 actor、revision、时间和影响摘要。

## B. 地址管理

- [ ] 可将任意 active Wiki node 注册为静态逻辑地址并解析相对子路径。
- [ ] node move 后地址仍指向同一节点并显示新 canonical path。
- [ ] duplicate/cycle/missing/archived/invalid scheme 被正确处理。
- [ ] 动态 resolver 只能从白名单选择，不能输入代码。
- [ ] 更新/删除地址前显示受影响 Agent/context/session。
- [ ] 地址 publish 后 runtime/preview 使用同一 revision。

## C. Agent Access UI

- [ ] 旧 Wiki anchors UI 不再出现，保存 payload 不再依赖 anchors。
- [ ] grant 的 scope/actions/compiled preview 正确 round-trip。
- [ ] 删除最后一项保存 `[]` 并实际撤销权限。
- [ ] `wiki-root` 全树写 grant 有明确高风险确认。
- [ ] overlapping grants 显示 union，不产生随机优先级。
- [ ] `${active_project}` 无项目时 inactive，不解析为 projects root。
- [ ] publish 后真实 Agent tool 权限与 preview 一致。

## D. Agent Context UI

- [ ] profile/channel/budget 可编辑和 round-trip。
- [ ] preview 与 runtime 文本/统计一致。
- [ ] context 无 read grant 时阻止 publish，且不会自动新增 grant。
- [ ] Prompt preview 不显示不可读节点内容。
- [ ] address/policy revision 与应用 session 状态可见。

## E. Project 管理

- [ ] repository binding 使用 ProjectStore.workspaceDir 且 Wiki DB 不存绝对 checkout path。
- [ ] status/HEAD/indexed revision/last error 正确显示。
- [ ] full reindex 有进度、失败可重试、页面关闭不取消 server job。
- [ ] unbind 不隐式硬删除 Wiki。
- [ ] Open Wiki 定位项目 canonical root。

## F. 命令与人工验收

```bash
npm run typecheck
npm run build:lib
npm run test:unit
npm run build
npm run test:e2e
npm run check:links
```

人工流程：创建 Agent → 配 own Memory/Knowledge/project grants → 预览 context → publish → 注册 runtime:// → 改 target → project bind/reindex → 观察 running session 应用状态。

## G. 必备证据

`result-07.md` 包含：

- Access/Context/Address/Project 四类 UI 截图或 E2E trace。
- publish 前后 policy/address revision。
- 删除最后 grant 后实际 tool denial。
- address move 后 target identity 证据。
- project reindex failure/retry 证据。

## H. 拒绝条件

- context checkbox 同时授予 read/write。
- renderer body 可以设置 admin/actor。
- 删除最后 grant 因 undefined 未生效。
- 地址注册出现在 Agent Wiki tool 中。
- repository 本地绝对路径复制进共享 Wiki DB。

