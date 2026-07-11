// 复制内置 skill 资产到 dist/(后端从 dist/ 跑,tsc 不复制非 TS 文件)
//
// # 文件说明书
//
// ## 核心功能
// 把 src/server/bundled-skills/** 递归复制到 dist/server/bundled-skills/**。
// 非 TS 资产(SKILL.md / *.mjs)tsc 不复制,而后端子进程总从 dist/backend.js 启动
// (见 src/main/backend-spawn.ts + scripts/dev.js 先 build dist),故必须落进 dist/
// 才能在 dev + 打包态都被 ensureBuiltinSkills() 读到。electron-builder.yml 已 ship
// dist/**/*,prod 覆盖。
//
// ## 输入
// 无参。源/目标相对本脚本位置硬编码(repo 根下 src/server/bundled-skills → dist/...)。
//
// ## 输出
// dist/server/bundled-skills/** 镜像。幂等:每次覆盖(recursive, force)。
//
// ## 定位
// scripts/ —— 构建辅助;由 package.json build:lib 在 tsc 后调用。
//
// ## 维护规则
// - 用 fs.cpSync(Node ≥16.7,engines 要求 ≥20.6),纯 node 跨平台,不依赖 shell cp。
// - 源不存在时安静跳过(允许尚未引入 bundle 时 build 不崩)。
// - 新增内置 skill 只需在 src/server/bundled-skills/ 下加目录,本脚本自动带上。

const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { resolve, dirname } = require("node:path");

const here = __dirname;
const src = resolve(here, "../src/server/bundled-skills");
const dest = resolve(here, "../dist/server/bundled-skills");

if (!existsSync(src)) {
	// 尚无 bundle 源 —— 不是错误,安静退出(允许早期 build)。
	process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true, force: true });
console.log(`[copy-bundled-skills] ${src} -> ${dest}`);
