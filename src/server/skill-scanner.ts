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
// - **优先级(sub-12 反转)**:数组靠后 = 高优先级;`~/.zero-core/skills` 放最后(app 胜)。
//   zero-core 产品选择:自己的 skill 视为权威/精调,覆盖外部同名 skill。**偏离协议默认**
//   (协议默认 personal>app)——记录理由:zero-core 自带 skill 是产品精调,优先级高于
//   用户从 ~/.claude 装的通用 skill。新增来源目录时保持 .zero-core 在数组末尾。
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
	// 逻辑分类(管 app/user 分组、sub-6/8 的 source==="app" 判断)— 不动。
	source: "user" | "app";
	// sub-10 (decision 10): display-only 来源标签。
	// 细分到具体 root:zero-core(~/.zero-core/skills)/claude(~/.claude/skills)/
	// agents(~/.agents/skills)/codex(~/.codex/skills 顶层 + .system,sub-14)。
	// 仅展示用,不参与任何业务判断(后者仍走 `source`)。
	origin: "zero-core" | "claude" | "agents" | "codex";
	filePath: string;
	baseDir: string;
}

/**
 * Skill 来源目录(含优先级顺序)。
 *
 * 优先级:数组中 **靠后 = 高优先级**(`scanSkills()` 后写入覆盖前写入)。
 *
 * **sub-12 反转(产品决策,记录于 design 决策 2)**:zero-core 自带 skill 视为
 * 权威/精调,**覆盖外部同名 skill**。故 `~/.zero-core/skills` 放数组**最后**。
 * 这**偏离协议默认**(协议:personal > app),但更符合产品定位——zero-core 精调
 * skill 优先级高于用户从 ~/.claude 装的通用 skill。`source` 字段仍按真实来源
 * 标记(app/user),不因此反转。
 */
export interface SkillRoot {
	dir: string;
	source: "user" | "app";
	// sub-10 (decision 10): display-only 来源标签,与 dir 一一对应。
	origin: "zero-core" | "claude" | "agents" | "codex";
}

/**
 * 返回 skill 来源目录列表(含优先级顺序)。
 *
 * **sub-12 反转**:数组靠后 = 高优先级。顺序 `~/.claude`(user/claude)→
 * `~/.agents`(user/agents)→ `~/.codex/skills`(user/codex 顶层)→
 * `~/.codex/skills/.system`(user/codex 自带,sub-14)→
 * `~/.zero-core`(app/zero-core,最后=最高优先级)。
 * zero-core skill 覆盖外部同名 skill(产品决策,详见 design 决策 2)。
 * 供 sub-2 虚拟路径解析器与 sub-3 prompt 组装复用。
 *
 * sub-14 新增 codex 两条来源:扫 `~/.codex/skills` 顶层 + `~/.codex/skills/.system`
 * (codex 自带 skill 如 skill-creator 也在后者)。注:scanDir 跳点目录,故扫顶层时
 * `.system` 自动跳过(不当 skill);扫 `.system` 时其子目录(skill-creator 等)正常扫到。
 *
 * @param home 可选 home 目录;省略时用 `os.homedir()`。**仅测试注入 tmp 目录**,
 *           生产调用一律不传。注入后所有 source 根都基于该 home 解析。
 */
export function getSkillRoots(home: string = homedir()): SkillRoot[] {
	return [
		{ dir: join(home, ".claude", "skills"), source: "user" as const, origin: "claude" as const },
		{ dir: join(home, ".agents", "skills"), source: "user" as const, origin: "agents" as const },
		// sub-14: codex 来源(顶层 + .system 自带)。zero-core 仍在最后(最高优先级)。
		{ dir: join(home, ".codex", "skills"), source: "user" as const, origin: "codex" as const },
		{ dir: join(home, ".codex", "skills", ".system"), source: "user" as const, origin: "codex" as const },
		{ dir: join(home, ".zero-core", "skills"), source: "app" as const, origin: "zero-core" as const },
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
	const full = parseSkillFrontmatterFull(content);
	return { name: full.name, description: full.description };
}

/**
 * sub-11: 解析 SKILL.md frontmatter 的 **全部** key-value(供详情页展示触发词/元数据)。
 *
 * 与 parseSkillFrontmatter 同源(轻量 YAML key:value + sub-14 块标量),但返回所有
 * 顶层标量字段 —— 用作详情页的 Metadata 段(category、allowed-tools 等)。name/description
 * 仍在返回里(详情页可在 frontmatter 段一并展示或单独去重)。
 *
 * sub-14: 支持 YAML 块标量(value 为 `|`/`|-`/`|+`/`>`/`>-`/`>+` 及裸 `|`/`>`)。
 * 修复 claude-api `description: |-` 这类多行 description 被抓成字面 `|-` 的 parser bug。
 *
 * 边界:
 *   - 仅处理 `---\n...\n---` 包裹的 frontmatter 块;无 frontmatter → 返回 {}。
 *   - 顶层 `key: value` 标量行;缩进的嵌套/列表项仍跳过(简单启发式,够用)。
 *   - value 去首尾配对引号("..." 或 '...')。
 *   - 块标量:读后续缩进行为块内容,`|` 保留换行 / `>` 折成空格;chomping `-`/`+`/无。
 *
 * @returns 键序按文件中出现顺序(插入顺序)。
 */
export function parseSkillFrontmatterFull(content: string): Record<string, string> {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return {};

	const endIdx = normalized.indexOf("\n---", 3);
	if (endIdx === -1) return {};

	const block = normalized.slice(4, endIdx);
	const lines = block.split("\n");
	const out: Record<string, string> = {};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		i++;

		// 跳过空行 / 缩进行(嵌套/列表)—— 仅顶层标量 key 行进入。
		if (line === "" || /^\s/.test(line)) continue;
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;

		const key = match[1];
		let raw = match[2].trim();

		// ── 块标量(sub-14):value 为 `|`/`|-`/`|+`/`>`/`>-`/`>+`/`|- ` 形式 ──
		// 匹配 block scalar indicator(+ 可选 comment)。后面紧跟缩进行构成块。
		const blockMatch = raw.match(/^([|>])([-+]?)\s*(?:#.*)?$/);
		if (blockMatch) {
			const indicator = blockMatch[1] as "|" | ">"; // "|" literal 或 ">" folded
			const chomp = blockMatch[2] as "" | "-" | "+"; // "" | "-" | "+"
			const blockLines: string[] = [];
			// 收集后续缩进行(至少一个空格缩进)。空行也算块的一部分(只要还在缩进段内),
			// 直到遇到顶格行(frontmatter 下一个 key 或 closing ---)或耗尽行。
			while (i < lines.length) {
				const next = lines[i];
				// 顶格非空行 → 块结束。
				if (next !== "" && !/^\s/.test(next)) break;
				// 空行保留(用于 chomping 判定);缩进行去一层公共缩进。
				blockLines.push(next);
				i++;
			}
			raw = joinBlockScalar(blockLines, indicator, chomp);
		} else if (
			(raw.startsWith('"') && raw.endsWith('"')) ||
			(raw.startsWith("'") && raw.endsWith("'"))
		) {
			raw = raw.slice(1, -1);
		}

		// 空字符串也保留(展示真实 frontmatter 状态);重复 key 后者覆盖(罕见)。
		if (key) out[key] = raw;
	}

	return out;
}

/**
 * sub-14: 把块标量的缩进行集合按 indicator(`|` literal / `>` folded)+ chomping
 * (`-` strip / `+` keep / 无 = clip)规则合成一个字符串。
 *
 * 对 description 等展示用途,产出一个合理字符串:
 *   - literal(`|`):保留换行,块内容用 `\n` join。
 *   - folded(`>`):换行折成空格(连续空行保留为一个换行,与 YAML 折叠近似)。
 *   - chomping:strip 去尾部所有换行;keep 保留全部尾部换行;clip 单个尾部换行。
 * 剥首尾空白后返回(展示用,非完整 YAML 语义)。
 *
 * 仅用于 SKILL.md frontmatter 展示(够用,不做完整 YAML 解析)。
 */
function joinBlockScalar(
	blockLines: string[],
	indicator: "|" | ">",
	chomp: "" | "-" | "+",
): string {
	// 找最小缩进(忽略空行)以剥离一层缩进。空行的缩进不计入最小值。
	let minIndent = Infinity;
	for (const ln of blockLines) {
		if (ln === "") continue;
		const m = ln.match(/^(\s*)/);
		const indent = m ? m[1].length : 0;
		if (indent < minIndent) minIndent = indent;
	}
	if (minIndent === Infinity) minIndent = 0;

	// 去每行前 minIndent 个空格(空行保持空)。
	const stripped = blockLines.map((ln) =>
		ln === "" ? "" : ln.slice(minIndent),
	);

	// 先按 indicator 决定内部换行处理。
	let joined: string;
	if (indicator === ">") {
		// folded:连续非空行折成空格;空行保留为换行(YAML 折叠近似)。
		const out: string[] = [];
		let buf: string[] = [];
		const flush = () => {
			if (buf.length > 0) {
				out.push(buf.join(" "));
				buf = [];
			}
		};
		for (const ln of stripped) {
			if (ln === "") {
				flush();
				out.push(""); // 空行 → 一个换行边界
			} else {
				buf.push(ln);
			}
		}
		flush();
		joined = out.join("\n");
	} else {
		// literal:保留原始换行。
		joined = stripped.join("\n");
	}

	// chomping:处理尾部换行。
	// 先统计尾部连续空行数(trailing newlines)。
	joined = joined.replace(/\n+$/, (m) => m); // 标记尾部换行(非破坏性,便于 chomp)
	const trailingNL = (joined.match(/\n*$/)?.[0] ?? "").length;

	if (chomp === "-") {
		// strip:去所有尾部换行。
		joined = joined.replace(/\n+$/, "");
	} else if (chomp === "+") {
		// keep:保留全部尾部换行(YAML 里是物理换行;展示用保留即可)。
		// 不动。
	} else {
		// clip(默认):保留单个尾部换行。
		joined = joined.replace(/\n+$/, "\n");
	}

	// 剥首尾空白(展示用途;description 不需要精确到换行结尾)。
	return joined.replace(/^\n+/, "").replace(/\n+$/, "");
}

function scanDir(
	dir: string,
	source: "user" | "app",
	origin: "zero-core" | "claude" | "agents" | "codex",
): DiscoveredSkill[] {
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
			origin,
			filePath: resolve(skillMdPath),
			baseDir: skillDir,
		});
	}

	return skills;
}

/**
 * 扫描所有来源,合并去重。
 *
 * 优先级(sub-12 反转):按 `getSkillRoots()` 顺序遍历,**后写入覆盖前写入** →
 * `~/.zero-core/skills`(app,数组末尾)覆盖 `~/.claude`/`~/.agents`(user)。
 * 合并主键 = skill.id(目录名);同 id 跨来源只保留最高优先级那条(app)。
 */
export function scanSkills(home?: string): DiscoveredSkill[] {
	const sources = getSkillRoots(home ?? homedir());
	const merged = new Map<string, DiscoveredSkill>();

	for (const { dir, source, origin } of sources) {
		const skills = scanDir(dir, source, origin);
		for (const skill of skills) {
			// 数组中靠后 = 高优先级(sub-12 反转:app/zero-core 胜,覆盖外部 user)
			merged.set(skill.id, skill);
		}
	}

	return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 构建 id(目录名)→ DiscoveredSkill 的解析索引。
 * 只是 `scanSkills()` 结果的 Map 化,无新 IO。优先级语义同 `scanSkills()`(sub-12:app 胜)。
 * 供 sub-2 `[skills]/<id>/` 虚拟路径前缀解析用。
 */
export function getSkillIndex(home?: string): Map<string, DiscoveredSkill> {
	return new Map(scanSkills(home).map((s) => [s.id, s]));
}

/**
 * 按目录名(id)解析单个 skill。
 * 不存在 → undefined。优先级语义同 `scanSkills()`(sub-12:app 胜,user 被 app 同名覆盖时不可见)。
 * 供 sub-2 `[skills]/<id>/` 虚拟路径解析用。
 */
export function resolveSkillByName(id: string, home?: string): DiscoveredSkill | undefined {
	return getSkillIndex(home).get(id);
}
