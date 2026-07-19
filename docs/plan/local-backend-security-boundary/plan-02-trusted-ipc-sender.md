# Plan 02：Trusted IPC Sender Boundary

## 目标

让所有 Renderer → Electron main privileged IPC 在任何副作用前验证调用来自当前主窗口
main frame；不改变 Renderer API 形状，不把 backend token 下发 Renderer。

## 依赖

Acceptance 01 通过。

## 实施范围

### 1. sender guard

建立单一 helper，例如：

```ts
assertTrustedIpcSender(event, getMainWindow)
```

必须验证：

- main window 当前存在且未销毁；
- `event.sender` 精确等于该 window `webContents`；
- `event.senderFrame` 非空、未销毁，精确等于 `webContents.mainFrame`。

失败使用稳定错误码/异常，不包含外部 frame URL、用户数据或 backend 信息。

### 2. proxied handlers

`registerProxyHandlers` 注册的每个 channel，包括 `app:ready`，都在：

```text
sender check → build request → backend fetch
```

顺序执行。forged sender 不得触发 fetch。

### 3. local handlers

覆盖：

- `window:minimize/maximize/close`；
- `dialog:openDirectory`；
- `webfetch:login`。

校验发生在窗口操作、dialog 打开、URL parse、新 login BrowserWindow 或 cookie import 前。

### 4. window lifecycle

- guard 动态读取 current main window，不永久捕获已销毁的 window/frame。
- 主窗口隐藏/显示仍授权；销毁后旧 frame 立即失效。
- 新建主窗口后只允许新 main frame。
- login window、webview、iframe、DevTools 和其他 BrowserWindow 不授权。

### 5. 测试

建立 handler 矩阵：

| sender | proxy | window | dialog | login |
|---|---:|---:|---:|---:|
| current main frame | allow | allow | allow | allow |
| same webContents child frame | deny | deny | deny | deny |
| other BrowserWindow | deny | deny | deny | deny |
| null/destroyed frame | deny | deny | deny | deny |
| old main frame after recreation | deny | deny | deny | deny |

断言 deny 路径对 fetch、window、dialog、login、cookie 全部零调用。

## 边界

- 不在本阶段增加 backend auth。
- 不实现 CSP/navigation/permission/webview sandbox。
- 不按 dev/package URL allowlist 代替对象身份。

## 完成定义

[Acceptance 02](acceptance-02-trusted-ipc-sender.md) 通过并创建 `result-02.md`。
