# skills 目录说明书

## 核心功能

Skill 发现与浏览页面（SkillsPage）：通过 `window.api.skillsList` 拉取本地已发现的 Skill，按 user / app 来源分组展示名称、来源标签与描述，支持手动刷新。

## 输入

- `window.api.skillsList`：返回 `DiscoveredSkill[]`
- 用户手动触发刷新

## 输出

- 渲染的 Skill 列表 DOM（User Skills / App Skills 分组卡片）

## 定位

渲染进程功能模块，被 AppLayout 路由到 skills 页面时加载。

## 依赖

- react
- `../../../shared/types`（DiscoveredSkill）
- `window.api`（skillsList）

## 维护规则

- DiscoveredSkill 字段或来源类别变化时同步分组与卡片渲染。
- 新增 Skill 安装路径提示需要更新空状态文案。
