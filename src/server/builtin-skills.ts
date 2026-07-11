// 内置 skill 启动 seed —— "开箱即有"
//
// # 文件说明书
//
// ## 核心功能
// 后端启动时把随包内置的 skill(目前仅 skill-creator)落进 app skills 根
// (`~/.zero-core/skills/<id>`),scanner 经现有 app root 自然扫到。这样新机器/
// 新克隆无需手动放置即开箱可用。scanner **零改动**(避开 getSkillRoots 的 5-root
// 测试硬契约),内置 skill 就是普通 app skill(source=app,可在 Skills 页编辑)。
//
// ## 输入
// 无参。bundled 资产位置 = 本模块旁的 `bundled-skills/`(运行时 = dist/server/
// bundled-skills,由 scripts/copy-bundled-skills.cjs 在 build:lib 阶段镜像)。
//
// ## 输出
// `~/.zero-core/skills/<id>/{SKILL.md, ...}` 落地。幂等。
//
// ## 幂等语义(关键)
// 仅当目标 `SKILL.md` **不存在**才 seed:
//   - 用户编辑过 → 保留(不覆盖);
//   - 用户整体删除 → 下次启动重 seed("开箱即有"契约,可接受)。
//
// ## 定位
// src/server/ —— 启动期一次性副作用;由 server/index.ts startServer() 调用,
// **不在 module-load / 单测路径**(单测不调 startServer,故不污染注入 home)。
//
// ## 依赖
// - node:fs(cpSync/existsSync/mkdirSync)、node:path、node:url
// - ./skill-router.js(appSkillDir —— 与 scanner app root 同源,seed 落点必被扫到)
// - ../core/logger.js(失败告警,warn 始终显示)
//
// ## 维护规则
// - 新增内置 skill:把目录放进 src/server/bundled-skills/<id>/ + 加进
//   BUILTIN_SKILL_IDS,copy 脚本与 seed 自动带上。
// - seed 永不抛(startServer 不应因 seed 失败而崩);异常 → log.warn 跳过该项。
//

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appSkillDir } from "./skill-router.js";
import { log } from "../core/logger.js";

/**
 * bundled 资产根:本模块旁的 `bundled-skills/`。
 *
 * 运行时本模块编译在 `dist/server/builtin-skills.js`,故解析到 `dist/server/
 * bundled-skills`(dev + 打包态一致 —— 后端总从 dist/ 跑,见 backend-spawn.ts +
 * dev.js)。源在 `src/server/bundled-skills/`,由 scripts/copy-bundled-skills.cjs
 * 在 build:lib 阶段镜像到 dist/。
 */
const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "bundled-skills");

/** 随包内置的 skill id 清单(目录名)。新增内置 skill 在此追加。 */
const BUILTIN_SKILL_IDS = ["skill-creator"];

/**
 * 启动期 seed:把每个内置 skill 落进 app skills 根(仅当缺失)。
 *
 * 幂等 + best-effort:任何异常都 log.warn 后继续,不抛(startServer 不受影响)。
 * 仅当 `~/.zero-core/skills/<id>/SKILL.md` 不存在且 bundled 源存在时才复制。
 */
export function ensureBuiltinSkills(): void {
	for (const id of BUILTIN_SKILL_IDS) {
		const destSkillMd = join(appSkillDir(id), "SKILL.md");
		if (existsSync(destSkillMd)) continue; // 用户已有(自建/编辑过)→ 保留

		const src = join(BUNDLED_DIR, id);
		if (!existsSync(src)) {
			// bundled 资产未镜像(构建未跑 copy)→ 安静跳过,不崩启动。
			continue;
		}

		try {
			const dest = appSkillDir(id);
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true, force: true });
			log.warn("skills", `seeded built-in skill '${id}' -> ${dest}`);
		} catch (e) {
			log.warn("skills", `failed to seed built-in skill '${id}': ${(e as Error).message}`);
		}
	}
}
