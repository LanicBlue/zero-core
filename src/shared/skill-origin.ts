// skill 来源标签的 display 映射(sub-10, decision 10)
//
// # 文件说明书
//
// ## 核心功能
// 把 DiscoveredSkill.origin(zero-core/claude/agents/codex)映射成展示用的来源 badge
// / 分组标题文案。供 SkillsSection(sub-10)、SkillsPage(sub-11)与 origin 分组
// (sub-14)共用 —— 避免多处各自写死 label。
//
// ## 输入
// DiscoveredSkill.origin 字面量("zero-core" | "claude" | "agents" | "codex")
//
// ## 输出
// 展示文案("ZERO-CORE" / "CLAUDE" / "AGENTS" / "CODEX"),未知值兜底为大写原值。
//
// ## 定位
// src/shared/ —— 跨 renderer/CLI 共用纯函数,无副作用。
//
// ## 维护规则
// 新增 origin 字面量(例如未来支持 "workspace")时:
//   1. src/server/skill-scanner.ts DiscoveredSkill + types.ts 同步加联合类型
//   2. 本文件的 LABEL 映射加条目
//
// 注意:origin 是 display-only(只渲染 badge / 分组标题);业务判断(app/user 分组、
// sub-6/8 的 source==="app")一律走 DiscoveredSkill.source,不用 origin。

export type SkillOrigin = "zero-core" | "claude" | "agents" | "codex";

const LABEL: Record<SkillOrigin, string> = {
	"zero-core": "ZERO-CORE",
	claude: "CLAUDE",
	agents: "AGENTS",
	codex: "CODEX",
};

/**
 * origin → 展示文案。未知值兜底为大写原值(防御性,正常不会触发)。
 *
 * 用法(SkillsSection / SkillsPage badge):
 *   <span className="skill-origin-badge">{originLabel(skill.origin)}</span>
 */
export function originLabel(origin: string): string {
	if (origin in LABEL) return LABEL[origin as SkillOrigin];
	// 兜底:未知 origin(运行时从 JSON 反序列化得到意外值)→ 大写原值,不抛错。
	return origin.toUpperCase();
}

/**
 * sub-14: origin 分组顺序 —— zero-core 置顶(产品精调优先展示),其余按 originLabel
 * 字母序。供 SkillsPage 左列表 + SkillsSection 按 origin 分组复用。
 *
 * 返回的是排序后的 origin 字面量数组(已去重);调用方按此顺序遍历分组。
 * 入参是所有出现过的 origin 集合(可含重复,内部去重)。
 */
export function originGroupOrder(origins: Iterable<string>): SkillOrigin[] {
	const seen = new Set<SkillOrigin>();
	for (const o of origins) {
		if (o in LABEL) seen.add(o as SkillOrigin);
	}
	// zero-core 置顶;其余按 LABEL 字母序(AGENTS / CLAUDE / CODEX)。
	const rest = Array.from(seen).filter((o) => o !== "zero-core").sort((a, b) =>
		LABEL[a].localeCompare(LABEL[b])
	);
	const out: SkillOrigin[] = [];
	if (seen.has("zero-core")) out.push("zero-core");
	out.push(...rest);
	return out;
}
