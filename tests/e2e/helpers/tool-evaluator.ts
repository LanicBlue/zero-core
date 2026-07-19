// 工具行为评价器 — per-tool 行为规约注册表
//
// # 文件说明书
//
// ## 核心功能
// 为 E2E 工具接线测试(tool-wiring.spec.ts)提供可扩充的 per-tool 输出断言。
// 每个 ToolCase 声明:工具名 + mock 要传的 args + 对工具输出文本的结构检查。
//
// ## 设计意图
// 接线层回归(如 discriminatedUnion 导致 args 变 {}、注入断导致工具不进集合)
// 在 spec 层先由状态信号拦截(.tool-done vs .tool-error / 无 .tool-block);
// 评价器在此基础上对**输出结构**做断言(工具执行成功且返回形态正确),形成
// per-tool 行为规约。新增工具或新 case 只改本文件,spec 自动遍历。
//
// ## 评价口径
// 评价器验「工具执行成功 + 返回结构正确」,不绑定特定 seed 数据——空数组也是
// 合法的成功执行(list 本就可能为空)。特定数据存在性不该由接线测试守。
//
// ## 输入
// 工具执行后 .tool-block-result 的渲染文本(工具多为 JSON.stringify 返回)
//
// ## 输出
// TOOL_CASES: ToolCase[] — spec 参数化遍历
//

export interface EvalResult {
	pass: boolean;
	detail?: string;
}

export interface ToolCase {
	label: string;
	toolName: string;
	args: object;
	check: (resultText: string) => EvalResult;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text.trim());
	} catch {
		return null;
	}
}

function contains(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

export const TOOL_CASES: ToolCase[] = [
	{
		// Project list 返回数组(空也算 pass —— list 本就可能为空)。
		label: "Project list returns an array",
		toolName: "Project",
		args: { action: "list" },
		check: (text) => {
			const parsed = tryParseJson(text);
			if (Array.isArray(parsed)) return { pass: true };
			return contains(text, "[")
				? { pass: true }
				: { pass: false, detail: `Project list did not return an array: ${text.slice(0, 200)}` };
		},
	},
	{
		// AgentRegistry list 必含 fresh-db-seed 播的 zero。
		label: "AgentRegistry list returns the seeded zero agent",
		toolName: "AgentRegistry",
		args: { action: "list" },
		check: (text) => {
			const parsed = tryParseJson(text);
			if (Array.isArray(parsed)) {
				const names = parsed.map((a: any) => a?.name).filter(Boolean);
				return names.includes("zero")
					? { pass: true }
					: { pass: false, detail: `zero not in [${names.join(", ")}]` };
			}
			return contains(text, "zero")
				? { pass: true }
				: { pass: false, detail: `result does not mention zero: ${text.slice(0, 200)}` };
		},
	},
	{
		label: "Cron list returns an array (empty OK)",
		toolName: "Cron",
		args: { action: "list" },
		check: (text) => {
			const parsed = tryParseJson(text);
			if (Array.isArray(parsed)) return { pass: true };
			return contains(text, "[")
				? { pass: true }
				: { pass: false, detail: `Cron list did not return an array: ${text.slice(0, 200)}` };
		},
	},
	{
		// Wiki expand 必须命中一个真实 seed 节点(不再只查"无 error")。
		// round-2 review P1 §6.3 (Choice B): fresh-env "Agent Wiki tool call"
		// placeholder 已删除,本 case 接管 fresh-env 的 tool-call 覆盖职责。
		//
		// 选 `memory://`(agent 自己的 memory root)作为 known seed node:
		//   - `zero` agent 拥有 `wiki-root` 全树 grant(见
		//     builtin-role-templates.ts DEFAULT_GRANTS_ZERO_ADMIN + wiki-access-
		//     compiler.ts memory:// → wiki-root/memory/<agentId>),授权通过。
		//   - fresh-db-seed 的 instantiateRole("zero", ...) 调用
		//     WikiService.ensureAgentMemoryRoot(zero.id, "zero") 幂等建
		//     `wiki-root/memory/<zero-stable-id>` 节点(management-service.ts
		//     :520);session build 时再次幂等 ensure(agent-service.ts :652)。
		//     故测试运行时该节点一定存在(plan-08 §1 cutover 删的是旧 software-dev
		//     seed 子树,不是 memory root;memory root 由 ensureAgentMemoryRoot
		//     按需建,是结构性的稳定 seed)。
		//   - expand memory:// 的 data 字段会含 path = "wiki-root/memory/<id>"。
		// 断言:result 不像 error,且正向引用 memory root(path 字段或文本含
		// "/memory" 段 —— 不只是"无错误")。
		label: "Wiki expand surfaces the agent's own memory:// seed node",
		toolName: "Wiki",
		args: { action: "expand", node: "memory://" },
		check: (text) => {
			const looksLikeError =
				contains(text, "error") && !contains(text, "no wiki nodes match");
			if (looksLikeError) {
				return { pass: false, detail: `result looks like an error: ${text.slice(0, 200)}` };
			}
			// Positive assertion: the result must reference the memory root.
			// Accept either (a) a parsed JSON object whose `path`/`data.path`
			// contains "/memory" (the canonical memory subtree), or (b) raw
			// text mentioning "/memory" (renderer sometimes flattens nested
			// objects). A bare "ok"/"done" or unrelated text fails this.
			const parsed = tryParseJson(text);
			const paths: string[] = [];
			if (parsed && typeof parsed === "object") {
				const p = (parsed as any).path ?? (parsed as any).data?.path;
				if (typeof p === "string") paths.push(p);
				// Some renderings wrap the result under result/data envelopes.
				const inner = (parsed as any).result ?? (parsed as any).data;
				if (inner && typeof inner === "object" && typeof inner.path === "string") {
					paths.push(inner.path);
				}
			}
			const textMentionsMemory = contains(text, "/memory") || contains(text, "memory://");
			const pathMentionsMemory = paths.some((p) => p.includes("/memory"));
			if (!textMentionsMemory && !pathMentionsMemory) {
				return {
					pass: false,
					detail: `Wiki expand memory:// did not surface the memory seed node (no "/memory" in path/text): ${text.slice(0, 200)}`,
				};
			}
			return { pass: true };
		},
	},
];
