# tests/e2e/helpers — E2E 测试辅助层

## 核心功能
E2E 测试共享基础设施。封装 Playwright Electron 启动、测试模式环境注入、窗口就绪等待、Agent 选择与消息发送，使所有 `*.spec.ts` 文件无需重复处理启动细节。

## 输入
- fixture JSON 绝对路径（`launchApp(fixtureAbsPath)` 参数）
- 构建产物 `./out/main/index.cjs`
- 环境变量约定：`ZERO_CORE_DIR`、`ZERO_CORE_TEST_FIXTURE`、`NODE_ENV=test`

## 输出
- `TestApp`（`{ app, window, zeroDir, cleanup }`）
- 导出函数：`launchApp` / `waitForAppReady` / `selectTestAgent` / `sendChatMessage`

## 文件清单

- `test-app.ts` — 导出 `launchApp(fixtureAbsPath)`、`waitForAppReady(window)`、`selectTestAgent(window)`、`sendChatMessage(window, text)` 与 `TestApp` 接口

## 运行方式

不在命令行单独运行，由 `tests/e2e/*.spec.ts` 在 `beforeEach` 中通过 `import { launchApp, ... } from "./helpers/test-app.js"` 引用。`launchApp` 内部：

1. `mkdtempSync` 创建临时 `ZERO_CORE_DIR`
2. 剥离继承的 `ELECTRON_RUN_AS_NODE`（Claude Code / VS Code 会设置，导致 Electron 以纯 Node 启动无窗口）
3. `electron.launch({ args: ["./out/main/index.cjs"], env: { ZERO_CORE_DIR, ZERO_CORE_TEST_FIXTURE, NODE_ENV: "test" } })`
4. 转发 main 进程 stdout/stderr 与渲染层 console/pageerror 到测试输出
5. 返回 `{ app, window, zeroDir, cleanup }`，cleanup 关闭 app 并删除临时目录

## 依赖

- `@playwright/test`（`_electron`、`ElectronApplication`、`Page`）
- `node:fs`（`mkdtempSync`、`rmSync`）、`node:path`（`join`）、`node:os`（`tmpdir`）
- `./out/main/index.cjs`（构建产物）
- 主进程 `src/main/test-setup.ts`（消费 `ZERO_CORE_TEST_FIXTURE` 完成 test seed）

## 定位

E2E 测试栈的最底层共享模块。所有 spec 的唯一启动入口；与 `tests/e2e/fixtures/`（mock 数据）共同构成 e2e 测试基础设施。better-sqlite3 编译为 Electron ABI，因此 test seed 在后端子进程内完成（`startServer` 处理 `ZERO_CORE_TEST_FIXTURE` 分支），避免在 Electron 主进程直接操作 SQLite 造成的 ABI 不匹配。

## 维护规则

- 应用启动参数、`ZERO_CORE_DIR` / `ZERO_CORE_TEST_FIXTURE` 环境变量名变更必须在此文件同步
- 主进程 test seed 入口（`src/main/test-setup.ts`、`src/server/index.ts` 的 `startServer`）变更需检查 `selectTestAgent` 中 `data-session-id` 等待逻辑
- 新增常用的页面交互（如切换到某页面、打开某面板）应抽成此处的导出函数，避免在各 spec 中复制
- 修改后需跑一遍 `chat.spec.ts` 验证启动链路未被破坏
