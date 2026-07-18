# Plan 02：Eval Skill 加固

## 目标

完成 Skill 打包、脚本进程、fixture 隔离、归档增量、OTel 版本兼容、敏感信息和自主演进
边界的最终验证。

## 依赖

Acceptance 00–01 通过。

## 实施范围

- fresh/existing/migration seed 与 packaged artifact；
- malformed profile/scenario/archive、timeout/cancel/child cleanup；
- deterministic repeat、trial 隔离、secret redaction 和稳定 exit code；
- malformed/truncated OTLP、未知属性、缺失 parent、乱序、span link、混合 convention
  revision 和 adapter migration；
- 大 trace/高基数属性 benchmark、内容默认关闭、显式 export redaction 与离线默认；
- archive-v1/OTLP 语义等价 fixture 的 normalized trajectory 和 grader result 一致性；
- 大归档 checkpoint/增量 benchmark，避免每次全量扫描；
- unknown/registered Project finding 路由与 duplicate suppression；
- 启动副作用、本地 Project 注册、bundled source 不回写和 Core runtime 无 instrumentation；
- 验收后更新 Skill 用户文档与活动架构说明。

## 完成定义

[Acceptance 02](acceptance-02-hardening.md) 通过并生成 `result-02.md`，随后执行
[Final Acceptance](acceptance-final.md)。
