// GitHub 模板工具函数
//
// # 文件说明书
//
// ## 核心功能
// 解析模板文件的 frontmatter 元数据和标签提取
//
// ## 输入
// 模板文件内容（Markdown 文本）
//
// ## 输出
// Frontmatter 键值对、标签列表、跳过判断
//
// ## 定位
// src/shared/ — 共享层，为主进程和渲染器提供模板解析工具
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// frontmatter 格式变更需同步更新解析逻辑
//
export function parseFrontmatter(content: string): Record<string, string> | null {
	const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!fmMatch) return null;
	const fm: Record<string, string> = {};
	for (const line of fmMatch[1].split("\n")) {
		const ci = line.indexOf(":");
		if (ci === -1) continue;
		let val = line.slice(ci + 1).trim();
		val = val.replace(/\\U([0-9A-Fa-f]{4,8})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
		val = val.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
		fm[line.slice(0, ci).trim()] = val;
	}
	return fm;
}

export function extractTag(fpath: string): string {
	const parts = fpath.split("/");
	let tag = parts[0].replace(/-/g, " ");
	if (parts.length > 2) tag = parts[0].replace(/-/g, " ") + "/" + parts[1].replace(/-/g, " ");
	return tag;
}

export function shouldSkipMd(fpath: string): boolean {
	const parts = fpath.split("/");
	if (parts.length === 1) return true;
	if (parts[0] === ".github" || parts[0] === "scripts") return true;
	if (parts[parts.length - 1] === "README.md") return true;
	return false;
}
