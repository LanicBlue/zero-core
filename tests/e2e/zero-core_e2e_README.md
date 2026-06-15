# tests/e2e — E2E 测试套件

## 核心功能
Playwright + Electron 端到端测试。通过 `ZERO_CORE_TEST_FIXTURE` 环境变量将 mock provider 的响应 fixture 注入主进程，使应用进入测试模式（不依赖真实 LLM provider），再驱动真实渲染窗口验证 UI 与 IPC 行为。

## 输入
- `ZERO_CORE_TEST_FIXTURE` 环境变量（mock provider 响应 JSON 绝对路径）
- `./out/main/index.cjs` 构建产物（由 `npm run build` 生成）
- `./fixtures/*.json` mock 响应数据

## 输出
- Playwright 测试报告（通过/失败 + 截图/trace）
- 渲染层 UI、IPC 通道、主进程启动与后端子进程协议的端到端契约验证结果

## 文件清单

- `chat.spec.ts` — 基础聊天：发送单条消息后渲染用户气泡 + 助手气泡
- `context-usage.spec.ts` — 上下文使用量指示器（文本 + 进度条 + 128K 窗口 + 绿色低占用）
- `error-handling.spec.ts` — 错误响应 fixture 下的 UI 反馈
- `fetch-models.spec.ts` — Fetch from API：IPC 代理使用 GET 拉取模型、设置页不崩溃
- `memory-ui.spec.ts` — Settings Memory 面板与 Knowledge Base Memory 标签页
- `model-info.spec.ts` — Agent 编辑器模型下拉框「ModelName — ContextK」格式
- `multi-turn.spec.ts` — 多轮对话渲染
- `page-restore.spec.ts` — 切页后消息恢复（含流式进行中切页）
- `session-delete.spec.ts` — session 删除
- `session-streaming-restore.spec.ts` — 流式中切换 session 后切回的内容恢复
- `session-switch.spec.ts` — session 切换
- `skills-page.spec.ts` — Skills 页面入口与渲染
- `helpers/` — 共享启动器与辅助函数（见 `helpers/zero-core_helpers_README.md`）
- `fixtures/` — mock provider 响应 JSON（simple-response / multi-turn-response / error-response / model-info-response / slow-response / multi-chunk-slow）

## 运行方式

```bash
npm run test:e2e      # = npm run build && playwright test
npx playwright test tests/e2e/chat.spec.ts   # 单文件
```

`playwright.config.ts` 配置：`testDir: ./tests/e2e`、`timeout: 60s`、`workers: 1`（Electron 持有状态，不可并行）、`fullyParallel: false`。

## 依赖

- `@playwright/test`（含 `_electron` 启动器）
- `./out/main/index.cjs`（构建产物，由 `npm run build` 生成）
- `./helpers/test-app.ts`（launchApp / waitForAppReady / selectTestAgent / sendChatMessage）
- `./fixtures/*.json`（mock 响应）

## 定位

测试金字塔的顶端：覆盖渲染层 UI、IPC 通道、主进程启动与后端子进程协议的端到端契约。与 `tests/unit/`（纯函数 / router 契约）互补——unit 验证逻辑正确性，e2e 验证真实 Electron 进程内的集成行为。

## 维护规则

- 新增 spec 必须复用 `helpers/test-app.ts` 的 `launchApp`，禁止自行 `electron.launch`
- 新增 mock 响应形态需新增对应 fixture JSON，并在 spec 中通过 `resolve(__dirname, "fixtures/xxx.json")` 引用
- fixture 文本变更需同步更新引用该 fixture 的 spec 中的文本断言
- 应用启动参数 / 主进程 test-setup（`src/main/test-setup.ts`）变更需同步检查 `helpers/test-app.ts`
- 侧边栏按钮 title、CSS class 名变更需批量更新相关 spec 的选择器
