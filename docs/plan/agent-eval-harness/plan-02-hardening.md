# Plan 02：Eval Skill 加固

## 目标

完成 Skill 打包、脚本进程、fixture 隔离、归档增量、敏感信息和自主演进边界的最终验证。

## 依赖

Acceptance 00–01 通过。

## 实施范围

- fresh/existing/migration seed 与 packaged artifact；
- malformed profile/scenario/archive、timeout/cancel/child cleanup；
- deterministic repeat、trial 隔离、secret redaction 和稳定 exit code；
- 大归档 checkpoint/增量 benchmark，避免每次全量扫描；
- unknown/registered Project finding 路由与 duplicate suppression；
- 启动副作用、本地 Project 注册和 bundled source 不回写；
- 验收后更新 Skill 用户文档与活动架构说明。

## 完成定义

[Acceptance 02](acceptance-02-hardening.md) 通过并生成 `result-02.md`，随后执行
[Final Acceptance](acceptance-final.md)。
