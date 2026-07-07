# sub-11:vitest 主 cwd forks-pool bug 修复(独立工具问题)

> 独立工具问题,非 agent-recovery 功能,但阻塞主 cwd 可靠跑测,用户要求一并解决。无功能依赖。

## 背景(诊断已有)

主仓库 cwd(项目根)跑 `npm run test:unit` 全 FAIL:`Cannot read properties of undefined (reading 'config')`(vitest 内部错)。已独立证实**非代码回归**:
- 主 cwd 把改动全 revert 仍 FAIL。
- 干净 worktree / sibling 目录(`vitest --root=<主cwd>`)同代码 PASS(~875-937)。
- 根因:**vitest 4 / Windows forks-pool 的 process-cwd 绑定 bug** —— 进程 cwd 恰为项目根(VS Code watch 此目录)时,fork-worker IPC 通道初始化失败,runtime config 注入不进,每个 `describe(...)` 炸 `.config`。

已知约束:`vitest.config.ts` 用 `pool: "forks"`;改 `vmThreads` 会触发 `@exodus/bytes` CJS-interop 问题(当初切 forks 的原因,配置注释有记录)。

## 任务

修主 cwd 跑测(让 `npm run test:unit` 在项目根绿),不 reintroduce `@exodus/bytes` 问题。可能方向(实现者调研择优):
1. **pool 配置**:找一个既避开 forks-cwd bug、又不踩 @exodus/bytes 的 pool/执行模式(如 `threads` + 适当 isolate、或 `forks` 加 `execArgv`/`env` 绕 cwd 绑定)。
2. **vitest 版本**:升级/锁定一个修了该 cwd bug 的 vitest 4.x patch(查 changelog)。
3. **环境隔离**:vitest config 里强制 worker 的 cwd(若 vitest 支持 `--cwd` 或 poolOptions),不让 worker 继承项目根。
4. **@exodus/bytes 链路**:若换 pool 触发它,顺带修 CJS-interop(加 loader / esbuild 配置)。

## 范围

- 只改测试基建(vitest.config.ts / package.json 脚本 / 可能 node_modules 锁版本),**不碰 src/**。
- 验证:主 cwd 绿 + sibling 仍绿 + @exodus/bytes 不复发。

## 风险

- vitest/Windows pool 问题常无干净修法,可能需取舍(如接受特定 pool 的局限)。
- 不要为修测试基建引入新的运行时风险(只动测试配置)。

## 验收

见 `acceptance-11.md`。
