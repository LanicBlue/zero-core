# zero-core 自更新 Runbook

> 核对基线：2026-07-16，对应 `scripts/self-update.cjs`、`self-update-helper.cjs` 和 `self-update-restore.cjs`。这是高风险运维流程；不要在普通开发工作区或未确认安装路径时尝试 packaged 替换。

## 1. 入口与完成条件

当前平台自动检测：

```bash
npm run self-update:packaged
```

需要显式参数时：

```bash
npm run self-update:packaged -- --platform=win --install=<安装文件路径> --target=<git-ref>
```

macOS 的安装路径是 `.app`，Windows 是 portable `.exe`，Linux 是 `.AppImage`。`runtime.install-path` 只应由 packaged app 写入；开发模式会清理该文件，避免误把开发 Electron 当成安装产物。

主脚本输出 `DONE` 只表示 detached helper 已启动，不表示更新成功。最终完成条件是对应 run 目录出现：

```json
{ "ok": true }
```

即 `<ZERO_CORE_DIR>/update-runs/<timestamp>/result.json`。

## 2. 阶段

| 阶段 | 动作 | 失败码/结果 |
| --- | --- | --- |
| P0 | 检查 git/npm/node、参数与安装路径 | exit 10 |
| P1 | 创建 git 回退 tag，把当前安装移动到 `previous` | exit 11 |
| P2 | 请求应用退出并快照数据目录（可用 `--no-snapshot` 跳过） | exit 12 |
| P3 | 重编译 native module、构建、打包、提取 staging | exit 13 |
| P4 | staging backend 冒烟；Windows/Linux 当前可能 skip | exit 14 |
| P5 | 写 `swap.json` 并启动 detached helper | 主脚本 exit 0 |
| P6 | helper 替换、重启、health 验证；失败自动恢复 previous | 写 `result.json` |

每个 run 位于 `<ZERO_CORE_DIR>/update-runs/<timestamp>/`，常见证据包括 `preflight.json`、`rollback.json`、`build.log`、`smoke.log`、`swap.json`、`helper.log` 和 `result.json`。

## 3. 诊断顺序

1. 找到最新 run 目录，不要混读不同 run 的日志。
2. 读取最后一个 `{step, phase:"fail"}` 及其 `log`。
3. 先判断是环境、安装占用、构建、native ABI、staging 冒烟还是 P6 health。
4. 只在用户明确授权修复后修改源码或构建配置；诊断本身不授权代码变更。
5. 修复后重新运行完整脚本，依赖它的幂等 run 目录，不要手工伪造阶段成功。

## 4. 常见失败

### P0：环境或安装路径

- `PATH 缺少 git/npm/node`：安装或修正 PATH。
- `无法定位当前安装位置`：确认 packaged app 写入的 `runtime.install-path`，或显式传 `--install`。
- 不要把 `node_modules/electron`、源码目录或普通开发 executable 当 packaged 安装位置。

### P1/P2：文件占用与数据快照

- 移动失败通常说明应用或杀毒软件仍占用安装文件。
- `.quit-requested` 由 helper/脚本触发，Electron main 在退出路径关闭 backend。
- 快照失败时不要删除用户数据目录；先确认进程退出和磁盘空间。

### P3：构建与 native ABI

P3 先执行 `rebuild:native:electron`，再执行 `build:lib`、`build` 和 electron-builder，最后在 `finally` 中执行 `rebuild:native:node` 恢复开发 ABI。

- TypeScript/构建错误：看 `build.log` 的第一处真实错误。
- `better-sqlite3` 编译失败：检查 Python、C/C++ 构建工具链和当前 Node/Electron ABI。
- 找不到 release 产物：确认目标平台和 electron-builder 输出名称。
- 更新失败后开发环境仍报 ABI 不匹配时，可运行 `npm run rebuild:native:node`。

### P4：staging 冒烟

- macOS 会启动 staging backend 并等待 ready/health。
- Windows/Linux 当前可能因 portable/AppImage 内部 backend 路径不可达而 `skip`；skip 不是已验证成功。
- 30 秒未 ready 时读取 `smoke.log`，重点检查 backend 入口、fixture、数据库和 native ABI。

### P6：替换、重启与回退

- `{ok:true}`：新版 health 通过。
- `{ok:false, rolledBack:true}`：新版启动或 health 失败，helper 已尝试恢复 previous 并重启旧版。
- 缺少 `result.json`：helper 可能中断；结合 `helper.pid`、`helper.log`、`swap.json` 和实际安装路径人工判断，不能只看主脚本 exit 0。

## 5. 数据恢复

安装回退不会自动回退数据快照，以避免覆盖失败窗口内的新数据。只有确认数据确实需要恢复、且 zero-core 已完全退出时，才运行：

```bash
npm run self-update:restore -- <runDir>
```

恢复脚本会先把当前数据目录改名为 `.pre-restore-<timestamp>`，再复制 run 中的 `zero-core.snapshot`。如果检测到 `sessions.db-shm`，脚本会拒绝执行。

## 6. 禁止操作

- 不删除 `<ZERO_CORE_DIR>`、`sessions.db`、`wiki/` 或 `attachments/`。
- 不手工修改 `result.json`、跳过 health 或把 P4 skip 描述成验证通过。
- 不在没有用户明确授权时执行 `git reset --hard`、强制覆盖安装或恢复数据。
- 不在同一个 run 目录里手工拼接阶段产物；失败后启动新 run。
- 不推送 tag/branch；自更新脚本创建的本地回退 tag 不等于发布 tag。
