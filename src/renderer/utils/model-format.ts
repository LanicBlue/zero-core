// 模型展示格式化工具(model-tag-polish 抽公共)
//
// # 文件说明书
//
// ## 核心功能
// 把 ProviderModel 的 contextWindow / multimodal 格式化成展示用字符串,供
// provider 配置页的标签 + 各处模型下拉选项复用。一处定义,全局生效。
//
// ## 导出
// - formatContextWindow(n):"205K" / "1M" / "1.5M" / ""(无值)
// - modelOptionSuffix(contextWindow, multimodal):下拉 option 文本后缀,
//   " · 128K" / " · 1M · image" / ""(用 " · " 分隔,匹配标签视觉顺序 window·image)
//
// ## 定位
// src/renderer/utils/ —— renderer 层中性工具,被 components/agents/ 与
// components/settings/ 共用。
//

/**
 * 格式化 context window 数值为展示字符串。
 * - undefined / 0 / 负数 → ""(不显示)
 * - ≥ 1M(1048576)→ "1M" / "1.5M"(整数不带小数)
 * - ≥ 1K → "205K"
 * - 其它 → 原始数字字符串
 */
export function formatContextWindow(n?: number): string {
	if (!n || n <= 0) return "";
	if (n >= 1048576) return (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + "M";
	if (n >= 1000) return Math.round(n / 1000) + "K";
	return String(n);
}

/**
 * 构造 <select> option 里模型名后的后缀。下拉只能渲染字符串,故把 context-window
 * + image 信息折叠成一行:" · 128K" / " · 1M · image" / ""(都无则空)。分隔符 " · "
 * 与 ProviderEditor 模型行的标签视觉顺序(window · image)一致。
 */
export function modelOptionSuffix(contextWindow?: number, multimodal?: boolean): string {
	const parts: string[] = [];
	const ctx = formatContextWindow(contextWindow);
	if (ctx) parts.push(ctx);
	if (multimodal === true) parts.push("image");
	return parts.length > 0 ? " · " + parts.join(" · ") : "";
}
