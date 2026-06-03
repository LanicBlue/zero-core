# 05 · 已知问题与排查指南

> 最近更新：2026-06-03（清理已修复项）

## 未修问题（非阻塞）

### B6. provider-factory 不支持 MiniMax / GLM 原生

走 openai-compatible 路径，缺厂商特有 reasoning 支持。用户已判定不值得做。

### B7. E2E 默认只创建一个 agent

多 agent 场景覆盖不到。未来加多 agent E2E 时扩展 seed 函数。

### B10. E2E 覆盖仍偏窄

已覆盖：多轮对话、error banner、session 切换/删除。
未覆盖：工具调用链路、thinking 流式、recovery、MCP、KB 检索、agent 编辑后续聊。

## 工具系统已知限制

- Bash: Windows CRLF 污染输出（\r 末尾）
- Grep: files_with_matches 模式在 grep fallback 时缺 -l 标志
- Edit: CRLF 文件的诊断上下文显示 \r

## 排查 Cheat Sheet

### 启动崩

1. `out/main/index.cjs` 是否最新（`npm run build`）
2. `ZERO_CORE_DIR` 是否指向预期位置（默认 `~/.zero-core`）
3. SQLite 文件是否存在且列齐全（`.tables` + `.schema <table>`）
4. better-sqlite3 是否针对当前 Electron 版本编译

### IPC 没响应

1. `typedHandle` 的 modules 数组是否完整（`npm run check:handlers`）
2. `moduleReadiness` 是否 resolve 了对应模块
3. preload 是否暴露了对应 channel

### 流式不工作

1. AppLayout dispatcher 是否处理了 event type
2. chat-store action 在 activeSessionId null 时是否 noop
3. session_init 是否在 streaming 开始前到达

### handler 校验

```bash
npm run check:handlers
```
