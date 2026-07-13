#!/usr/bin/env node
// 手动数据快照恢复工具
//
// # 文件说明书
//
// ## 核心功能
// 从某次自更新 run 的 <runDir>/zero-core.snapshot 恢复 ZERO_CORE_DIR。
// 自更新流程默认「快照不自动回退」(怕覆盖失败窗口内用户新会话);本脚本提供显式手动恢复。
//
// ## 输入
// argv[2] = runDir(含 zero-core.snapshot/)
// env: ZERO_CORE_DIR(目标数据根,默认 ~/.zero-core)
//
// ## 输出
// 当前数据目录改名为 <zcDir>.pre-restore-<ts>(备份),快照内容复制到 <zcDir>。
//
// ## 定位
// scripts/ 自更新工作流的「保命绳」;仅在确认需要回退用户数据时手动调用。
//
// ## 维护规则
// 调用前必须先完全退出 zero-core(否则 SQLite 被锁,恢复后 DB 不一致)。

const fs = require("fs");
const path = require("path");
const os = require("os");

const runDir = process.argv[2];
if (!runDir) {
	console.error("用法: node scripts/self-update-restore.cjs <runDir>");
	console.error("  <runDir> = update-runs/<ISO_TS>/(含 zero-core.snapshot/)");
	console.error("  请先完全退出 zero-core,再运行本脚本。");
	process.exit(2);
}

const snapshot = path.join(runDir, "zero-core.snapshot");
if (!fs.existsSync(snapshot)) {
	console.error("快照不存在: " + snapshot);
	process.exit(2);
}

const zcDir = process.env.ZERO_CORE_DIR || path.join(os.homedir(), ".zero-core");
if (fs.existsSync(path.join(zcDir, "sessions.db-shm"))) {
	console.error(`警告:检测到 ${zcDir}/sessions.db-shm,zero-core 可能还在运行。`);
	console.error("请先完全退出 zero-core,再运行本脚本。");
	process.exit(2);
}

const backup = `${zcDir}.pre-restore-${Date.now()}`;
console.log(`[restore] 1/3 备份当前数据目录 → ${backup}`);
fs.renameSync(zcDir, backup);

console.log(`[restore] 2/3 从快照恢复 → ${zcDir}`);
fs.cpSync(snapshot, zcDir, { recursive: true });

console.log(`[restore] 3/3 完成。`);
console.log(`  当前数据来自快照:${zcDir}`);
console.log(`  原数据已备份:${backup}(确认无误后可手动删除)`);
