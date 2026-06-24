// Fresh-DB 默认 seed (v0.8 P6 — RFC §7.1 / §7.5)
//
// # 文件说明书
//
// ## 核心功能
// 空库启动时写入 fresh-DB 默认记录,让用户拿到一个能跑的 software-dev
// 工作流入口 + 一个清晰的 §10.5 wiki 骨架:
//   1. **zero agent** —— 从 zero template 实例化的全局管理 agent,
//      workspaceDir = `~/.zero-core`(不绑单个项目)。protected:不可删。
//   2. **wiki `knowledge/software-dev` 节点** —— software-dev 工作流配置草稿
//      (角色清单 + subagents 关系 + cron 建议),zero 读它学习怎么搭工作流。
//      protected:不可删。
//   3. **wiki §10.5 子树根骨架** —— 在 global root 下 ensure 三个顶层分支:
//      `knowledge`(已有)/ `projects`(空容器)/ `memory`(空容器)。
//      projects/memory 根不 protected(仅导航骨架);真正的 per-project /
//      per-agent 子树根仍由 ensureProjectSubtree / ensureMemoryAgentRoot
//      按需 lazy 创建,与这些骨架根并存。
//
// ## 触发点
// `server/index.ts` 的 `startServer` 内、所有 store 建好后、`restoreAllSessions`
// 之前,检查 `agentStore.list().length === 0` → seed。业务语义,放服务层不放
// migration 层(RFC §7.1)。
//
// ## protected
// - `AgentStore delete` 拒删 zero agent —— 见 agent-store.ts(store 层拦截,
//   覆盖 agent-router REST DELETE / management tool / 任何未来 caller)。
// - `WikiStore delete` 拒删 software-dev 节点 —— 见 wiki-node-store.ts
//   (本阶段在 store 层直接拦)。
//
// ## seed 是启动期特权写入
// 绕过运行时 scope guard(P1 守卫对 seed 路径放行;RFC §7.5)。本模块直接调
// WikiStore.create / writeNodeDetail,不经过 caller 锚点并集校验。
//
// ## 输入
// - agentStore
// - wikiStore (global)
// - management (ManagementService — 用于 instantiateTemplate)
//
// ## 输出
// 无返回;写入失败仅 console.warn 不阻塞启动。
//
// ## 定位
// src/server/ — 服务层启动期 seed,被 server/index.ts 调用。
//

import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentStore } from "./agent-store.js";
import type { WikiStore } from "./wiki-node-store.js";
import {
	WIKI_GLOBAL_ROOT_ID,
	KNOWLEDGE_ROOT_PATH_SEED,
	WORKFLOW_PATH_SEED,
	SOFTWARE_DEV_NODE_PATH_SEED,
	SOFTWARE_DEV_NODE_PATH_SEED_LEGACY,
	PROJECTS_ROOT_PATH_SEED,
	MEMORY_ROOT_PATH_SEED,
} from "./wiki-node-store.js";
import type { ManagementService } from "./management-service.js";

/**
 * Aliases re-exporting the store-side seed path constants (kept for symmetry
 * with the protected-delete check, which keys off the same strings).
 */
export const KNOWLEDGE_ROOT_PATH = KNOWLEDGE_ROOT_PATH_SEED;
export const WORKFLOW_PATH = WORKFLOW_PATH_SEED;
export const SOFTWARE_DEV_NODE_PATH = SOFTWARE_DEV_NODE_PATH_SEED;

/**
 * Backfill a node's body detail ONLY when it has none yet — never clobbers a
 * body the user/agent has written or refined. Used by the ensure* seed helpers
 * so container/structural nodes get an explanatory doc on both fresh and
 * existing DBs (ensureWikiSkeleton runs on every startup).
 */
function ensureNodeDetail(wikiStore: WikiStore, nodeId: string, body: string): void {
	if (wikiStore.readNodeDetail(nodeId) === undefined) {
		wikiStore.writeNodeDetail(nodeId, body);
	}
}

// Body docs for the structural/container nodes (so the tree isn't opaque when
// an agent expands a folder — each folder explains what lives under it).
const GLOBAL_ROOT_DETAIL = `# Global Wiki Root

This is the root of zero-core's single global wiki memory tree. Three top-level branches live directly under here:

- **knowledge/** — general knowledge base. Any agent with node permission can read; zero maintains it by default. Organized by topic (e.g. \`workflow/\` holds playbooks).
- **projects/** — per-project wiki subtrees. Each project gets a \`wiki-root:<projectId>\` subtree, created lazily; project-role sessions auto-anchor into their own subtree.
- **memory/** — per-agent memory. Each agent gets a \`wiki-root:memory-agent:<agentId>\` subtree; extractor A writes, the agent itself can curate.

A project-role session sees only its own project subtree (+ its memory). Global-scope sessions (zero) anchor at this root and see the whole tree.`;

const KNOWLEDGE_DETAIL = `# Knowledge

General knowledge base — not tied to any single project. Topics are organized into category folders (e.g. \`workflow/\` for playbooks).

Visibility: any agent whose session anchors include this subtree can read it. Write scope is enforced in the store layer (a session needs an explicit anchor here to upsert).`;

const WORKFLOW_DETAIL = `# Workflow

Playbooks describing how to assemble agent cooperation workflows. Each playbook under here specifies a roster of roles, their subagents/delegation graph, suggested crons, gates, and state machines.

\`software-dev\` is the software-development workflow playbook (the fresh-DB default seed). zero reads the relevant playbook when the user asks to set up a workflow, then instantiates the agents + their cooperation relationships.`;

const PROJECTS_DETAIL = `# Projects

Container for per-project wiki subtrees. Each project gets its own subtree root \`wiki-root:<projectId>\`, created lazily by ensureProjectSubtree when a session first references the project.

A project-role session is scoped to (and auto-anchored into) its own project subtree — it cannot see other projects' subtrees.`;

const MEMORY_DETAIL = `# Memory

Container for per-agent memory subtrees. Each agent gets \`wiki-root:memory-agent:<agentId>\`, created lazily by ensureMemoryAgentRoot. Extractor A writes memory leaves here (event/decision/discovery/status_change/preference); the agent can also curate its own memory.

Memory is global to an agent (spans every project that agent touches), keyed by agentId, not by project.`;

/**
 * software-dev playbook body —— 软件开发示例工作流的**唯一知识源**。
 *
 * v0.8 ADR-020:项目代码是通用工作流平台(只提供机制),软件开发只是默认 seed
 * 进 wiki 的示例工作流。本 playbook 承载全部 software-dev 工作流知识(角色身份
 * +程序、管线、门、subagents 图、cron、状态机)。zero 读它来搭这套工作流;
 * lead/archivist/... 不在代码里硬编码,由 zero 读本 playbook 后用 AgentRegistry
 * 实例化(systemPrompt 由 zero 基于此处描述撰写)。
 */
const SOFTWARE_DEV_PLAYBOOK = `# software-dev 工作流配置

> 这是 fresh-DB 默认 seed 写入的 **software-dev playbook**(示例工作流)。zero 读
> 它来学习怎么搭这套工作流。本节点是该工作流的**唯一知识源**——角色身份/程序、
> 管线、门、subagents 图、cron 都在这里,代码里不硬编码。后续可由 zero / 用户 refine。

## 平台定位

zero-core 是**通用工作流引擎**:提供 agents、tools、cron、wiki 知识树、Orchestrate
编排、委派。它不绑定任何具体工作流。software-dev 是默认自带的**示例工作流**;若要
别的工作流(研究、内容生产、运维……),照此结构另写一份 playbook 即可。

## 角色清单

> 这些角色**不在代码里**;zero 读完本表后,用 AgentRegistry 把它们建成 agent
> (systemPrompt 基于下面各角色的「身份 + 程序」撰写,toolPolicy 按需配,subagents
> 按「subagents 图」连)。能力底座优先用能力画廊里的模板(Coder / Reviewer /
> QA Engineer / Product Manager 等)。

| 角色 | 能力底座(画廊模板) | 职责 | cron |
|---|---|---|---|
| \`zero\` | (平台自带,已 seed) | 平台管家 / 用户入口;读 playbook 搭工作流、配置 agent 与合作。 | 按需 |
| \`pm\` | Product Manager | 产品侧:cron 巡检发现需求、discuss 细化、**verify 产品粒度覆盖判断**。 | interval 巡检 |
| \`lead\` | (自建,FS 只读) | 交付侧:领 ready 需求 → Orchestrate 编排 → 委派 dev/review/qa → 提交 verify。 | fallback |
| \`developer\` | Coder | 实现(被 lead 委派,继承 caller bundle)。 | 无 |
| \`reviewer\` | Reviewer | 评审(被 lead 委派,只读,返回 verdict)。 | 无 |
| \`qa\` | QA Engineer | 测试(被 lead 委派)。 | 无 |
| \`archivist\` | (自建,FS 只读) | 知识侧:**管 git main**、wiki 项目子树、feature→main 合并。 | alarm 巡检 |

> analyzer / planner 是抽象概念,不作为独立角色落地;需要深度分析/规划时,lead
> 或 pm 直接用能力画廊里的领域专家(Security/UI-UX/Performance Expert 等)委派。

## 各角色身份与程序(写 systemPrompt 的依据)

### pm(产品经理)
产品发现、需求管理、覆盖判断:
1. **discover** —— 周期巡检工作区;是否分析、分析多深,自己定。cron 只是唤醒,发现什么、建什么由 PM 自己决定。
2. **create requirement** —— 对每个值得跟踪的新发现,建需求记录(status 'discuss')并写 repo 需求文档,绑定 docPath。幂等:同项目同名重建是 no-op。**只在发现 pass 建新需求,绝不改已存在需求文档**(discuss 期改动走 discuss session)。
3. **discuss** —— 与用户细化需求;确认后状态 → 'ready' 交给 lead。
4. **judge coverage (verify)** —— lead 提交 verify 后,PM 判断变更+测试是否覆盖原始需求意图。这是**产品粒度覆盖,不是技术验收**(技术验收在 lead flow 内已完成)。判定:pass → 触发 archivist 合并;not pass + 修改意见 → lead 改计划重提 verify。
- 读 archivist 的项目 wiki 子树,把需求写得更好、覆盖判断更准。
- 不碰代码、wiki 树结构、feature-branch git(对 PM 只读);PM 唯一写面是需求记录/文档(+ 自己的 memory)。
- 巡检是 PM 自己的职责,不是 cron 直调 service。
- 工具:启用 CreateRequirementWithDoc + Wiki(读 archivist wiki)+ FS 只读。

### lead(交付负责人)
交付管线,一次一个需求:
1. **pickup** —— 领进入 'ready' 的需求;完成一个自动领下一个,cron 只是兜底唤醒。
2. **plan** —— 出任务大纲,转成 Orchestrate flow(parallel / pipeline / if / for / barrier),指定每个节点由哪个 agent 执行。提交 flow;**plan 门**等用户确认后才执行。
3. **build** —— 按确认的 flow 驱动 developer → reviewer → qa 执行,控制节奏、审结果。
4. **verify** —— build 完成后**提交 verify**(做了什么 + 证据)并停下等 PM 判定。PM pass 即交付;not pass + 意见 → 改计划、重执行、重提 verify,直到 pass。
- lead 写 Orchestrate DSL,自己 plan(除非另配 planner)。
- **不自己写代码**——委派给 developer/reviewer/qa。
- 不碰 PM 的需求文档和 archivist 的 wiki 树(对 lead 只读);读 archivist wiki 做 plan。
- 边界止于「实现完成 + verify 通过」;合 main 是 archivist 的活(PM 触发),lead 不碰。
- 一次只做一个需求,做完自动领下一个。
- 工具:FS 只读(不写码)。

### archivist(知识管理)
项目 wiki 子树 + main 分支:
- 把项目 wiki 子树建成结构节点树(module / subsystem / convention),**叶子是参考文档**——每片叶子的正文(你的理解/注释)**在正文里链接到真实项目文件**(你读但绝不改);项目文件本身不在 wiki 里,只被引用。这样不碰代码也能理解项目。
- 维护节点间链接(模块包含、依赖、需求↔实现追溯)。
- 项目文档**只读**(代码、需求文档、ADR);只写自己的 wiki 子树(结构行 + 参考文档正文)。
- **渐进扫描**:先建结构(骨架 + docPointer),再增量填参考文档正文;中断后从 cursor 续。
- **管 main 分支**:PM 触发合并时(verify 通过后)把 feature → main;合并后增量重扫变更文件、更新受影响参考文档。
- 给结构断言打 provenance:structure(来自代码)/ derived(来自 commit·ADR)/ confirmed(来自需求文档·用户 discuss)。检测意图与代码的偏离,标给 PM/lead。
- 写面是自己服务的项目子树(项目 anchor);绝不改项目文件本身。意图从制品聚合,不发明。把值得记的事实(决策、教训、模式)抽进自己 memory 子树。
- 工具:FS 只读 + Wiki(写自己子树)。

### developer / reviewer / qa(交付执行角色)
被 lead 委派,继承 caller bundle,做完一个委派任务就返回,不自主领活、不跨需求、不做产品/合并判断。systemPrompt 直接用能力画廊的 Coder / Reviewer / QA Engineer(身份 + 工作方式已在画廊 prompt 里;任务框架由 Orchestrate dispatch 模板带)。

## subagents 关系图 (caller → callee)

\`\`\`
zero (顶层配置者,不参与运行时委派)

pm  ─── 委派 ───► archivist  (verify 通过 → 触发 archivist 合并 feature→main)
lead ─── 委派 ──► developer / reviewer / qa  (Orchestrate flow 节点)
\`\`\`

- **lead** 的 subagents: \`[developer, reviewer, qa]\`(zero 用能力模板 Coder/Reviewer/QA Engineer 建)
- **pm** 的 subagents: \`[archivist]\`
- **archivist** 不委派(只被 PM 委派)
- **zero** 是顶层配置者,不参与运行时委派

## cron 建议(由 zero 配)

- **PM** — interval 巡检 cron(默认每 2-4 小时,按项目节奏调):
  scope = 项目 \`{projectId, workspaceDir, wikiRootNodeId}\`;prompt 触发 PM 自主发现/创建/细化需求。
- **archivist** — alarm 巡检 cron(可选,默认每天 1 次):
  scope = 项目;触发 archivist 增量扫描更新 wiki。
- **lead** — fallback cron(可选,默认每 30 分钟):
  仅 idle 兜底;lead 主要靠「完成上一任务后自动领下一个」。

## 两道门

1. **plan confirm 门** —— lead 提交 Orchestrate flow 后停下,等用户确认。
2. **verify 门** —— lead 完成实现后提交 verify 停下,**PM 做产品粒度覆盖判断**:
   - pass → PM 触发 archivist 合并
   - not pass + 修改意见 → lead 改计划再执行、重新提交 verify

## 状态机

\`\`\`
found → discuss → ready → plan → build → verify → closed
                                        ↑            ↓
                                        └─ (PM 判不通过+意见) lead 改计划再执行

cancelled ←─ (用户/PM 取消;任意状态可达)
\`\`\`

> 状态值对齐代码 \`RequirementStatus\`(shared/types.ts):found / discuss /
> ready / plan / build / verify / closed / cancelled。

## fresh-DB seed

- **zero agent**:平台自带,fresh-DB 自动实例化(平台基础设施,不是工作流知识)。
- **本 playbook 节点**(\`knowledge/workflow/software-dev\`):software-dev 工作流
  的唯一知识源,protected 不可删。
- pm/lead/archivist/developer/reviewer/qa **永不自动 seed**:它们是 software-dev
  工作流的角色,知识在本 playbook 里,由 zero 读出后用 AgentRegistry 按需建成 agent。
`;

/**
 * Seed the fresh-DB defaults (RFC §7.1).
 *
 * STRICT FRESH-ONLY (v0.8 P7): the function is a hard no-op whenever
 * `agentStore.list().length > 0`. The caller (server/index.ts) already
 * gates on this condition; we re-check here as the authoritative guard
 * so a re-seed can never write a duplicate on a partially-populated DB.
 * The wiki-side helpers below remain individually idempotent (safe if
 * re-invoked by callers that pre-seeded the wiki subtree).
 *
 * Both records are protected:
 * - zero agent: AgentRegistry delete rejects (management-service.ts).
 * - software-dev node: WikiStore delete rejects (wiki-node-store.ts).
 */
export function seedFreshDbDefaults(deps: {
	agentStore: AgentStore;
	wikiStore: WikiStore;
	management: ManagementService;
}): void {
	const { agentStore, wikiStore, management } = deps;

	// ─── 1. zero agent ─────────────────────────────────────────────
	// Identity in v0.8 = name + systemPrompt (RFC §1.4).
	//
	// STRICT FRESH-ONLY guard (v0.8 P7). Before P7, AgentStore's constructor
	// seeded a legacy default "Zero" agent, so a "truly empty" DB still had
	// length > 0 and a name==='zero' workaround guard was used to coexist.
	// P7 retired the legacy default (agent-store.ts), so
	// `agentStore.list().length === 0` now correctly identifies a fresh DB.
	// The caller (server/index.ts) already gates on this condition, but we
	// re-check here as a hard guarantee: this function ONLY writes on a truly
	// empty table. On any non-empty DB (legacy data, partial state, a prior
	// "Zero" capitalized record) we are a no-op — we never seed a duplicate.
	const currentAgents = agentStore.list();
	if (currentAgents.length > 0) {
		return;
	}
	try {
		management.instantiateRole("zero", {
			name: "zero",
			workspaceDir: join(homedir(), ".zero-core"),
		});
		console.log("[seed] instantiated zero agent (fresh-DB seed)");
	} catch (err) {
		console.warn("[seed] failed to seed zero agent:", (err as Error).message);
	}

	// ─── 2. wiki skeleton ─────────────────────────────────────────
	// knowledge/workflow/software-dev + projects/memory container roots, each
	// with an explanatory detail doc. ensureWikiSkeleton is idempotent and
	// also runs unconditionally from server startup (so existing DBs get
	// structural changes without a re-seed); calling it here covers the
	// fresh path + unit tests that invoke seedFreshDbDefaults directly.
	try {
		ensureWikiSkeleton(wikiStore);
	} catch (err) {
		console.warn("[seed] failed to seed wiki skeleton:", (err as Error).message);
	}
}

/**
 * Exported so non-fresh environments (e.g. the E2E test-mode seed in
 * src/core/test-seed.ts) can also ensure the §10.5 wiki skeleton exists. The
 * helpers are individually idempotent (return early if the node already
 * exists), so calling them from a non-fresh DB is safe and never duplicates.
 */

/**
 * Idempotently ensure the full §10.5 wiki skeleton (knowledge/workflow +
 * software-dev + projects/memory roots). Safe to call on EVERY startup — on a
 * fresh DB it builds the skeleton; on an existing DB it no-ops (and migrates
 * legacy-positioned nodes, e.g. software-dev from knowledge/ → knowledge/workflow/).
 * Called unconditionally from server startup so structural seed changes
 * (like the workflow reorg) reach existing DBs without a re-seed.
 */
export function ensureWikiSkeleton(wikiStore: WikiStore): void {
	ensureKnowledgeRoot(wikiStore);
	ensureWorkflowNode(wikiStore);
	ensureSoftwareDevNode(wikiStore);
	ensureProjectsRoot(wikiStore);
	ensureMemoryRoot(wikiStore);
	// Global root detail (the root itself is ensured by the store constructor;
	// backfill its explanatory doc here so the tree root isn't opaque).
	ensureNodeDetail(wikiStore, WIKI_GLOBAL_ROOT_ID, GLOBAL_ROOT_DETAIL);
	// One-time disk-layout migration: move body files from the legacy flat
	// layout to the tree-mirror layout. Idempotent (no-op once migrated).
	wikiStore.migrateWikiDiskLayout();
}

export function ensureKnowledgeRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED);
	if (!existing) {
		wikiStore.create({
			parentId: WIKI_GLOBAL_ROOT_ID,
			path: KNOWLEDGE_ROOT_PATH_SEED,
			title: "Knowledge",
			summary: "工作流配置 playbook 子树(zero 管;将来 HR)。",
			type: "knowledge" as any,
		});
	}
	const node = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED)!;
	ensureNodeDetail(wikiStore, node.id, KNOWLEDGE_DETAIL);
}

/**
 * Ensure the "workflow" category node exists under knowledge. software-dev
 * (and future playbook docs) hang under it. Pure organization — not protected.
 */
export function ensureWorkflowNode(wikiStore: WikiStore): void {
	const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED);
	if (!knowledgeRoot) {
		throw new Error("knowledge root missing — ensureKnowledgeRoot must run first");
	}
	const existing = wikiStore.getByParentAndPath(knowledgeRoot.id, WORKFLOW_PATH_SEED);
	if (!existing) {
		wikiStore.create({
			parentId: knowledgeRoot.id,
			path: WORKFLOW_PATH_SEED,
			title: "Workflow",
			summary: "工作流 playbook 文档分类(software-dev 等)。",
			type: "knowledge" as any,
		});
	}
	const node = wikiStore.getByParentAndPath(knowledgeRoot.id, WORKFLOW_PATH_SEED)!;
	ensureNodeDetail(wikiStore, node.id, WORKFLOW_DETAIL);
}

export function ensureSoftwareDevNode(wikiStore: WikiStore): void {
	const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED);
	if (!knowledgeRoot) {
		throw new Error("knowledge root missing — ensureKnowledgeRoot must run first");
	}
	const workflowRoot = wikiStore.getByParentAndPath(knowledgeRoot.id, WORKFLOW_PATH_SEED);
	if (!workflowRoot) {
		throw new Error("workflow node missing — ensureWorkflowNode must run first");
	}
	// Migrate legacy position: pre-workflow DBs have software-dev directly under
	// knowledge with path "software-dev". Reparent it under workflow + update its
	// path so the body file re-derives to knowledge/workflow/software-dev__<id>.md.
	const legacy = wikiStore.getByParentAndPath(knowledgeRoot.id, SOFTWARE_DEV_NODE_PATH_SEED_LEGACY);
	if (legacy) {
		const oldDetail = wikiStore.readNodeDetail(legacy.id);
		wikiStore.update(legacy.id, {
			parentId: workflowRoot.id,
			path: SOFTWARE_DEV_NODE_PATH_SEED,
		});
		// update() doesn't relocate the body file; rewrite it at the new derived
		// path so readNodeDetail finds it post-migration.
		if (oldDetail !== undefined) {
			wikiStore.writeNodeDetail(legacy.id, oldDetail);
		}
		console.log("[seed] migrated software-dev node under knowledge/workflow/");
	}
	const existing = wikiStore.getByParentAndPath(workflowRoot.id, SOFTWARE_DEV_NODE_PATH_SEED);
	if (existing) {
		// One-time refresh: earlier v0.8 seeds wrote a shorter playbook (roster +
		// graph + gates only). ADR-020 migrated the full per-role procedures into
		// the playbook. If the body lacks the new-version marker, it's the stale
		// seed — refresh it. A user-refined body would differ and is left alone
		// (best-effort: the marker is specific to the new seed structure).
		const body = wikiStore.readNodeDetail(existing.id);
		if (body !== undefined && !/平台定位|各角色身份与程序/.test(body)) {
			wikiStore.writeNodeDetail(existing.id, SOFTWARE_DEV_PLAYBOOK);
			console.log("[seed] refreshed stale software-dev playbook to the ADR-020 version");
		}
		return;
	}
	const node = wikiStore.create({
		parentId: workflowRoot.id,
		path: SOFTWARE_DEV_NODE_PATH_SEED,
		title: "software-dev 工作流",
		summary: "software-dev 工作流的全部配置:角色清单、subagents 关系、cron 建议、两道门、状态机。",
		type: "knowledge" as any,
	});
	wikiStore.writeNodeDetail(node.id, SOFTWARE_DEV_PLAYBOOK);
	console.log("[seed] created knowledge/workflow/software-dev wiki node (fresh-DB seed)");
}

/**
 * v0.8 (§10.5): ensure the empty container root for project wiki subtrees.
 * Hangs directly under the global root as a navigation skeleton; the actual
 * per-project subtree roots (`wiki-root:<projectId>`) are created lazily by
 * ensureProjectSubtree and live as siblings of this node. NOT protected.
 */
export function ensureProjectsRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, PROJECTS_ROOT_PATH_SEED);
	if (!existing) {
		wikiStore.create({
			parentId: WIKI_GLOBAL_ROOT_ID,
			path: PROJECTS_ROOT_PATH_SEED,
			title: "Projects",
			summary: "项目 wiki 子树根;每个项目一个 wiki-root:<projectId> 子树。",
			type: "project" as any,
		});
	}
	const node = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, PROJECTS_ROOT_PATH_SEED)!;
	ensureNodeDetail(wikiStore, node.id, PROJECTS_DETAIL);
}

/**
 * v0.8 (§10.5): ensure the empty container root for global memory subtrees.
 * Hangs directly under the global root as a navigation skeleton; the actual
 * per-agent memory subtree roots (`wiki-root:memory-agent:<agentId>`) are
 * created lazily by ensureMemoryAgentRoot and live as siblings of this node.
 * NOT protected.
 */
export function ensureMemoryRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, MEMORY_ROOT_PATH_SEED);
	if (!existing) {
		wikiStore.create({
			parentId: WIKI_GLOBAL_ROOT_ID,
			path: MEMORY_ROOT_PATH_SEED,
			title: "Memory",
			summary: "全局记忆子树;每个 agent 一个 memory/<agentId> 子树。",
			type: "memory" as any,
		});
	}
	const node = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, MEMORY_ROOT_PATH_SEED)!;
	ensureNodeDetail(wikiStore, node.id, MEMORY_DETAIL);
}
