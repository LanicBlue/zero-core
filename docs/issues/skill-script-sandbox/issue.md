# Issue:skill-script-sandbox

- **状态**:① issues(问题记录)
- **提出**:2026-07-08
- **类型**:改进(安全 / 架构)
- **依赖**:[`../../archive/skill-system/`](../../archive/skill-system/)(`[skills]/` 虚拟路径是前置——它标识 skill 发起的执行,给沙盒一个干净拦截点)

## 问题

skill 可带可执行脚本(`scripts/`),agent 经 `[skills]/<id>/scripts/...` 用 Shell 跑(skill-system sub-2)。协议承认风险:"只装可信来源、用前审计"。但当前框架**无沙盒**:skill 脚本以 agent 进程同等权限运行,能读写 agent 能访问的一切、能联网。一个不可信外部 skill 的脚本是**任意代码执行面**。需要:把 skill 脚本放进受限沙盒跑(文件系统/网络/进程隔离),把爆炸半径限在 skill 目录 + 必要工作区。

## 现状 / 真相源 / 影响面

### skill 脚本执行现状(待 skill-system 落地后)
- skill-system sub-2:Shell 识别 `[skills]/<id>/<rel>` 前缀 → 解析真实路径 → 替换进命令 → 执行。
- **执行时无隔离**:与普通 Shell 命令同等权限(经现有 autoApprove/scope,但那是"是否允许跑",不是"跑起来后关笼子里")。

### 沙盒难度(平台)
- 仓库 **Windows 优先(win32)**:轻量沙箱原语弱;Linux 有 namespace/bubblewrap、macOS 有 sandbox-exec,Windows 几乎只能上容器(Docker/WSL)→ 重依赖。
- **真沙盒三要素**:文件系统隔离(脚本可见 fs 限 skill 目录 + workspace 子集)+ 网络隔离(对子进程禁网)+ 进程隔离;跨平台统一难。

### 已有前置(skill-system 铺的地基)
- `[skills]/` 虚拟路径**天然标识 skill 发起的执行**——沙盒拦截点清晰;`<rel>` 路径沙箱已限定在 skill baseDir 内。
- 但虚拟路径**只解决"识别 + 路径限定"**,不解决"进程隔离"。

### 影响面
- 不可信外部 skill(`~/.claude/skills`)脚本 = 任意代码执行(读写、联网、子进程)。
- 现阶段靠"协议指引 + 用户审计"软约束,无技术隔离。

## 下一步

进② design 细化方案(`/effort design`)。**前置:skill-system 落地**(虚拟通道先有)。design 要定:
- 沙盒档位:轻量(cwd+env 限制,非真隔离)/ 标记+审批增强 / **真沙盒**(fs+net+进程隔离)——权衡平台成本(尤其 Windows)。
- 平台策略:是否 Linux/macOS 用原生原语(namespace/sandbox-exec)、Windows 用容器或降级;还是统一容器(Docker)依赖。
- 信任模型:本软件 skill(`~/.zero-core`,用户自建)是否免沙盒;外部 skill(`~/.claude`)强制沙盒?
- 与 Shell 现有 autoApprove/scope 的关系(沙盒是执行时隔离,approval 是执行前许可,两层正交)。
