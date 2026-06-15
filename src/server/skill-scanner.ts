// 扫描本机已安装的 skill 目录,合并 user / app 来源并解析 SKILL.md
//
// # 文件说明书
//
// ## 核心功能
// 枚举 user(~/.claude/skills、~/.agents/skills)与 app(~/.zero-core/skills)三类来源目录,读取每个子目录的 SKILL.md,优先使用 .skills-manifest.json、回退到 SKILL.md frontmatter 解析 name/description,产出 DiscoveredSkill 列表(按名称排序,同名时高优先级来源覆盖低优先级)。
//
// ## 输入
// - 无显式入参;来源目录在 getSkillSources 中硬编码
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
// - 新增来源目录时优先调高优先级顺序,保证用户目录覆盖 app 目录。
//

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredSkill {
	id: string;
	name: string;
	description: string;
	source: "user" | "app";
	filePath: string;
	baseDir: string;
}

interface SkillSource {
	dir: string;
	source: "user" | "app";
}

function getSkillSources(): SkillSource[] {
	const home = homedir();
	return [
		{ dir: join(home, ".claude", "skills"), source: "user" as const },
		{ dir: join(home, ".agents", "skills"), source: "user" as const },
		{ dir: join(home, ".zero-core", "skills"), source: "app" as const },
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

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
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

export function scanSkills(): DiscoveredSkill[] {
	const sources = getSkillSources();
	const merged = new Map<string, DiscoveredSkill>();

	for (const { dir, source } of sources) {
		const skills = scanDir(dir, source);
		for (const skill of skills) {
			// Higher priority sources overwrite lower
			merged.set(skill.id, skill);
		}
	}

	return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}
