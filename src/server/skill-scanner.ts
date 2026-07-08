// 扫描本机已安装的 skill 目录,合并 user / app 来源并解析 SKILL.md
//
// # 文件说明书
//
// ## 核心功能
// 枚举 app/bundled(~/.zero-core/skills)与 personal(~/.claude/skills、~/.agents/skills)三类来源目录,读取每个子目录的 SKILL.md,优先使用 .skills-manifest.json、回退到 SKILL.md frontmatter 解析 name/description,产出 DiscoveredSkill 列表(按名称排序,同名时高优先级来源覆盖低优先级)。
//
// ## 输入
// - 无显式入参;来源目录在 getSkillRoots() 中硬编码
// - 间接依赖文件系统中的 SKILL.md / .skills-manifest.json
//
// ## 输出
// - scanSkills 返回 DiscoveredSkill[]: { id, name, description, source, filePath, baseDir }
//
// ## 定位
// src/server/ 数据层,被 skill-router 调用;本身不持有状态。
//
// ## 依赖
// - node:fs、node:path、node:os
//
// ## 维护规则
// - SKILL.md frontmatter 解析只做轻量 YAML(key: value),复杂结构应通过 manifest 提供。
// - 跳过以 . 开头的目录与 node_modules;单文件 > 256KB 视为非法并跳过。
// - 新增来源目录时调 getSkillRoots() 的顺序:app 在前(低)、personal 在后(高),personal 覆盖 app。
//

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredSkill {
	// identity = 目录名(id);display name 见 `name` 字段(frontmatter name || 目录名)。
	// scanner 不读 body —— body 由 agent 经 `[skills]/` 虚拟通道按需 Read(progressive disclosure)。
	id: string;
	name: string;
	description: string;
	source: "user" | "app";
	filePath: string;
	baseDir: string;
}

/**
 * Skill 来源目录(含优先级顺序)。
 *
 * 优先级:数组中 **靠后 = 高优先级**(personal 覆盖 app/bundled)。
 * 协议:personal(`~/.claude/skills`、`~/.agents/skills`)> app/bundled(`~/.zero-core/skills`)。
 * 这与 `scanSkills()` 的"后写入覆盖前写入"合并方向保持一致。
 */
export interface SkillRoot {
	dir: string;
	source: "user" | "app";
}

/**
 * 返回 skill 来源目录列表(含优先级顺序)。
 * 顺序:app/bundled 在前(低)、personal 在后(高)——personal 覆盖 app。
 * 供 sub-2 虚拟路径解析器与 sub-3 prompt 组装复用。
 *
 * @param home 可选 home 目录;省略时用 `os.homedir()`。**仅测试注入 tmp 目录**,
 *           生产调用一律不传。注入后三条 source 根都基于该 home 解析。
 */
export function getSkillRoots(home: string = homedir()): SkillRoot[] {
	return [
		{ dir: join(home, ".zero-core", "skills"), source: "app" as const },
		{ dir: join(home, ".claude", "skills"), source: "user" as const },
		{ dir: join(home, ".agents", "skills"), source: "user" as const },
	];
}

interface ManifestSkill {
	name: string;
	description: string;
	category?: string;
}

function loadManifest(dir: string): Map<string, ManifestSkill> | null {
	const manifestPath = join(dir, ".skills-manifest.json");
	if (!existsSync(manifestPath)) return null;

	try {
		const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const skills = raw?.skills;
		if (!skills || typeof skills !== "object") return null;

		const map = new Map<string, ManifestSkill>();
		for (const [key, val] of Object.entries(skills as Record<string, ManifestSkill>)) {
			if (val.name && val.description) {
				map.set(key, val);
			}
		}
		return map;
	} catch {
		return null;
	}
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return {};

	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) return {};

	const block = normalized.slice(4, endIdx);

	let name: string | undefined;
	let description: string | undefined;

	// Simple YAML key:value parsing (good enough for SKILL.md frontmatter)
	for (const line of block.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;

		const key = match[1];
		let value = match[2].trim();

		// Strip quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key === "name" && value) name = value;
		if (key === "description" && value) description = value;
	}

	return { name, description };
}

function scanDir(dir: string, source: "user" | "app"): DiscoveredSkill[] {
	if (!existsSync(dir)) return [];

	const manifest = loadManifest(dir);
	const skills: DiscoveredSkill[] = [];

	let entries: string[];
	try {
		entries = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
			.map((e) => e.name);
	} catch {
		return [];
	}

	for (const entryName of entries) {
		const skillDir = resolve(dir, entryName);
		const skillMdPath = join(skillDir, "SKILL.md");

		if (!existsSync(skillMdPath)) continue;

		try {
			const stat = statSync(skillMdPath);
			if (stat.size > 256_000) continue;
		} catch {
			continue;
		}

		const content = readFileSync(skillMdPath, "utf-8");
		const parsed = parseSkillFrontmatter(content);

		// Use manifest data if available, otherwise fall back to frontmatter
		const manifestEntry = manifest?.get(entryName);
		const name = parsed.name || manifestEntry?.name || entryName;
		const description = parsed.description || manifestEntry?.description;

		if (!description) continue;

		skills.push({
			id: entryName,
			name,
			description,
			source,
			filePath: resolve(skillMdPath),
			baseDir: skillDir,
		});
	}

	return skills;
}

/**
 * 扫描所有来源,合并去重。
 *
 * 优先级:按 `getSkillRoots()` 顺序遍历,**后写入覆盖前写入** → personal 覆盖 app。
 * 合并主键 = skill.id(目录名);同 id 跨来源只保留最高优先级那个。
 */
export function scanSkills(home?: string): DiscoveredSkill[] {
	const sources = getSkillRoots(home ?? homedir());
	const merged = new Map<string, DiscoveredSkill>();

	for (const { dir, source } of sources) {
		const skills = scanDir(dir, source);
		for (const skill of skills) {
			// 数组中靠后 = 高优先级(personal),覆盖前(app)
			merged.set(skill.id, skill);
		}
	}

	return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 构建 id(目录名)→ DiscoveredSkill 的解析索引。
 * 只是 `scanSkills()` 结果的 Map 化,无新 IO。优先级语义同 `scanSkills()`(personal 胜)。
 * 供 sub-2 `[skills]/<id>/` 虚拟路径前缀解析用。
 */
export function getSkillIndex(home?: string): Map<string, DiscoveredSkill> {
	return new Map(scanSkills(home).map((s) => [s.id, s]));
}

/**
 * 按目录名(id)解析单个 skill。
 * 不存在 → undefined。优先级语义同 `scanSkills()`(personal 胜,app 被 personal 同名覆盖时不可见)。
 * 供 sub-2 `[skills]/<id>/` 虚拟路径解析用。
 */
export function resolveSkillByName(id: string, home?: string): DiscoveredSkill | undefined {
	return getSkillIndex(home).get(id);
}
