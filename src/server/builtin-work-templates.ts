// project-work 默认工位种子
//
// # 文件说明书
//
// ## 核心功能
// DEFAULT_PROJECT_WORKS —— 新 project 创建时自动 seed 的默认工位(全空岗,
// agentId=null)。命名按具体职责(不用抽象角色头衔)。覆盖软件开发常见工作:
// 需求管理(hook 触发)/技术调研(手动)/文档充实/文档重建/git 同步(cron)。
//
// ## 背景
// 取代工作流角色:身份在 agent,行为在 work。默认 work 把"做什么"落成 actionPrompt,
// 用户分配 agent(校验 requiredTools)+ 配触发源即可。dev/reviewer/qa 不进此集
// (它们是 lead 运行时拉起的 subagent,画廊已有 Coder/Reviewer 模板)。
//
// ## 维护规则
// - 需求管理/技术调研的 actionPrompt 在阶段 2(lead/analyst 去 role)精调,
//   现为合理默认。
// - 文档三操作的 prompt 与 wiki-operations WIKI_OPERATIONS 保持一致。
//

import { WIKI_OPERATIONS } from "./wiki-operations.js";
import type { ProjectWorkRecord } from "../shared/types.js";

type WorkSeed = Omit<ProjectWorkRecord, "id" | "createdAt" | "updatedAt">;

/**
 * 新 project 的默认工位(全空岗)。projectName 用于替换 actionPrompt 的 {projectName}。
 */
export function defaultProjectWorks(projectId: string, projectName: string): WorkSeed[] {
	const enrich = WIKI_OPERATIONS.find((o) => o.id === "wiki-enrich")!.prompt.replaceAll("{projectName}", projectName);
	const rebuild = WIKI_OPERATIONS.find((o) => o.id === "doc-rebuild")!.prompt.replaceAll("{projectName}", projectName);
	const gitUp = WIKI_OPERATIONS.find((o) => o.id === "git-update")!.prompt.replaceAll("{projectName}", projectName);

	return [
		{
			projectId,
			name: "需求管理",
			actionPrompt: [
				`有新需求进入项目「${projectName}」。你的职责是接手并推进交付(需求 detail 由上下文注入,见 ## Requirement)。`,
				"",
				"交付步骤(对应 plan 门 / build / verify 门):",
				"1. 用 Read/Grep/Glob + Wiki(expand)读项目代码现状 + archivist wiki 做 plan。",
				"2. 用 Orchestrate 工具编排 DSL flow(parallel/pipeline/if/for/barrier),每个 task 节点指定一个你 subagents 列表里的执行 agent。",
				"3. 调 Orchestrate({ flow, mode: \"confirm\" }) 提交 —— plan 门:工具停住等用户确认。确认后 flow 跑;驳回返回 \"false: <reason>\",你据此自重 Orchestrate flow 再交(同 agent,mode=\"run\")。",
				"4. flow 跑完 + 自验通过后,**显式调用 verify 工具**提交覆盖判断:",
				"   - verify 置 status=verify + 阻塞调 PM 做产品粒度覆盖判断;",
				"   - PM APPROVED → PM 触发 archivist 合并 feature→main + 置 closed(你不用碰合并);",
				"   - PM REJECTED → 意见回灌,你改计划重提 verify,循环到通过。",
				"",
				"注意:",
				"- commit 引用 requirementId,格式如 \"feat: ... [req-<shortId>]\"。",
				"- 在 feature 分支(req-<shortId>)上每步 commit。",
				"- 默认串行(一次一个需求);完成后自动领下一个 ready 需求。",
			].join("\n"),
			requiredTools: ["Orchestrate", "Wiki"],
			agentId: null,
			contextPolicy: { injectProjectInfo: true, injectRequirementDetail: true, injectStepsProgress: true },
			hooks: [{ event: "requirements.create", collection: "requirements", enabled: true }],
			enabled: true,
		},
		{
			projectId,
			name: "技术调研",
			actionPrompt: [
				`对项目「${projectName}」做技术调研/分析,并把发现写回 wiki。`,
				"",
				"1. 扫描相关目录结构,为关键模块/文件建立或更新 Wiki 节点(职责、关键导出、依赖)。",
				"2. 若发现值得关注的问题或改进点,创建需求记录。",
				"3. 优先建立骨架(根目录 + 主要 src 目录),不要试图一次展开全部文件。",
			].join("\n"),
			requiredTools: ["Wiki"],
			agentId: null,
			contextPolicy: { injectProjectInfo: true, injectWikiBaseline: true },
			hooks: [],
			enabled: true,
		},
		{
			projectId,
			name: "文档充实",
			actionPrompt: enrich,
			requiredTools: ["Wiki"],
			agentId: null,
			contextPolicy: { injectProjectInfo: true, injectWikiBaseline: true },
			hooks: [],
			enabled: true,
		},
		{
			projectId,
			name: "文档重建",
			actionPrompt: rebuild,
			requiredTools: ["Wiki"],
			agentId: null,
			contextPolicy: { injectProjectInfo: true, injectWikiBaseline: true },
			hooks: [],
			enabled: true,
		},
		{
			projectId,
			name: "git 同步",
			actionPrompt: gitUp,
			requiredTools: ["Wiki"],
			agentId: null,
			contextPolicy: { injectProjectInfo: true, injectWikiBaseline: true },
			hooks: [],
			enabled: true,
		},
	];
}

/** 仅类型/常量导出占位(供 management-service import 不丢)。 */
export const DEFAULT_PROJECT_WORKS = defaultProjectWorks;
