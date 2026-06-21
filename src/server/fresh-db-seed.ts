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
	SOFTWARE_DEV_NODE_PATH_SEED,
	PROJECTS_ROOT_PATH_SEED,
	MEMORY_ROOT_PATH_SEED,
} from "./wiki-node-store.js";
import type { ManagementService } from "./management-service.js";

/**
 * Aliases re-exporting the store-side seed path constants (kept for symmetry
 * with the protected-delete check, which keys off the same strings).
 */
export const KNOWLEDGE_ROOT_PATH = KNOWLEDGE_ROOT_PATH_SEED;
export const SOFTWARE_DEV_NODE_PATH = SOFTWARE_DEV_NODE_PATH_SEED;

/**
 * software-dev playbook body (草稿,后续可 refine;RFC §7.1 验收:含角色清单 +
 * subagents 关系 + cron 建议)。
 */
const SOFTWARE_DEV_PLAYBOOK = `# software-dev 工作流配置

> 这是 fresh-DB 默认 seed 写入的 software-dev playbook 草稿(RFC §7.1)。zero
> 读它来学习怎么搭这套工作流。后续可由 zero / 用户 refine。

## 角色清单 (role templates)

| template | 职责 |
|---|---|
| \`zero\` | 软件管家 / 用户入口。配置其他 agent 与合作关系。**默认 seed**(fresh-DB 自动实例化)。 |
| \`pm\` | 产品经理。cron 巡检发现需求、discuss 细化、**verify 覆盖判断**。 |
| \`lead\` | 交付负责人。领 ready 需求 → Orchestrate 编排 → 委派 dev/review/qa → 提交 verify。 |
| \`developer\` / \`reviewer\` / \`qa\` | 交付流程执行角色(写码 / 审 / 测)。被 lead 委派,无 cron。 |
| \`archivist\` | 知识管理。**管 git main**、wiki 项目子树、feature→main 合并。 |

> analyzer / planner 是抽象概念,不作为独立角色 template 落地。

## subagents 关系图 (caller → callee)

\`\`\`
zero (顶层配置者,不参与运行时委派)

pm  ─── 委派 ───► archivist  (verify 通过 → 触发 archivist 合并 feature→main)
lead ─── 委派 ──► developer / reviewer / qa  (Orchestrate flow 节点)
\`\`\`

- **lead** 的 subagents: \`[developer, reviewer, qa]\`
- **pm** 的 subagents: \`[archivist]\`
- **archivist** 不委派(只被 PM 委派)
- **zero** 是顶层配置者,不参与运行时委派

## cron 建议 (PM / archivist 巡检,由 zero 配)

- **PM** — interval 巡检 cron(默认每 2-4 小时一次,按项目节奏调):
  scope = 项目 \`{projectId, workspaceDir, wikiRootNodeId}\`;prompt 触发 PM
  自主发现/创建/细化需求。
- **archivist** — alarm 巡检 cron(可选,默认每天 1 次):
  scope = 项目;触发 archivist 增量扫描更新 wiki。
- **lead** — fallback cron(可选,默认每 30 分钟一次):
  仅作 idle 兜底;lead 主要靠「完成上一任务后自动领下一个」。

## 两道门 (RFC §4.3 / §4.5)

1. **plan confirm 门** —— lead 提交 Orchestrate flow 后停下,等用户确认。
2. **verify 门** —— lead 完成实现后提交 verify 停下,**PM 做产品粒度覆盖判断**:
   - pass → PM 触发 archivist 合并
   - not pass + 修改意见 → lead 改计划再执行、重新提交 verify

## 状态机

\`\`\`
found → discuss → ready → plan → build → verify → archived
                                        ↑            ↓
                                        └─ (PM 判不通过+意见) lead 改计划再执行
\`\`\`

## fresh-DB seed(本节点 + zero agent)

zero agent + \`knowledge/software-dev\` 节点是 fresh-DB 默认两条 seed,**不可删**
(protected)。其余角色(pm/lead/archivist/dev/...)永不 seed,永远留在
template 表里,由 zero 按用户对话按需实例化。
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
		management.instantiateTemplate(
			"zero",
			{
				name: "zero",
				workspaceDir: join(homedir(), ".zero-core"),
			},
			{ bindToolPolicy: false },
		);
		console.log("[seed] instantiated zero agent (fresh-DB seed)");
	} catch (err) {
		console.warn("[seed] failed to seed zero agent:", (err as Error).message);
	}

	// ─── 2. knowledge/software-dev wiki node ──────────────────────
	// Ensure the knowledge subtree root exists (directly under the global
	// root), then create the software-dev leaf with the playbook body.
	try {
		ensureKnowledgeRoot(wikiStore);
		ensureSoftwareDevNode(wikiStore);
	} catch (err) {
		console.warn("[seed] failed to seed software-dev wiki node:", (err as Error).message);
	}

	// ─── 3. §10.5 wiki subtree-root skeleton ──────────────────────
	// Alongside the knowledge subtree, ensure empty container roots for the
	// two other §10.5 top-level branches so the wiki browser opens with the
	// full skeleton:
	//   global → knowledge (→ software-dev) / projects / memory
	// These roots are NOT protected (navigation only). Per-project /
	// per-agent subtree roots are created lazily as siblings.
	try {
		ensureProjectsRoot(wikiStore);
		ensureMemoryRoot(wikiStore);
	} catch (err) {
		console.warn("[seed] failed to seed §10.5 wiki skeleton roots:", (err as Error).message);
	}
}

function ensureKnowledgeRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED);
	if (existing) return;
	wikiStore.create({
		parentId: WIKI_GLOBAL_ROOT_ID,
		path: KNOWLEDGE_ROOT_PATH_SEED,
		title: "Knowledge",
		summary: "工作流配置 playbook 子树(zero 管;将来 HR)。",
		type: "knowledge" as any,
	});
}

function ensureSoftwareDevNode(wikiStore: WikiStore): void {
	const knowledgeRoot = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, KNOWLEDGE_ROOT_PATH_SEED);
	if (!knowledgeRoot) {
		throw new Error("knowledge root missing — ensureKnowledgeRoot must run first");
	}
	const existing = wikiStore.getByParentAndPath(knowledgeRoot.id, SOFTWARE_DEV_NODE_PATH_SEED);
	if (existing) {
		// Body may have been refined by zero/user since seed — don't clobber.
		return;
	}
	const node = wikiStore.create({
		parentId: knowledgeRoot.id,
		path: SOFTWARE_DEV_NODE_PATH_SEED,
		title: "software-dev 工作流",
		summary: "software-dev 工作流的全部配置:角色清单、subagents 关系、cron 建议、两道门、状态机。",
		type: "knowledge" as any,
	});
	wikiStore.writeNodeDetail(node.id, SOFTWARE_DEV_PLAYBOOK);
	console.log("[seed] created knowledge/software-dev wiki node (fresh-DB seed)");
}

/**
 * v0.8 (§10.5): ensure the empty container root for project wiki subtrees.
 * Hangs directly under the global root as a navigation skeleton; the actual
 * per-project subtree roots (`wiki-root:<projectId>`) are created lazily by
 * ensureProjectSubtree and live as siblings of this node. NOT protected.
 */
function ensureProjectsRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, PROJECTS_ROOT_PATH_SEED);
	if (existing) return;
	wikiStore.create({
		parentId: WIKI_GLOBAL_ROOT_ID,
		path: PROJECTS_ROOT_PATH_SEED,
		title: "Projects",
		summary: "项目 wiki 子树根;每个项目一个 wiki-root:<projectId> 子树。",
		type: "project" as any,
	});
}

/**
 * v0.8 (§10.5): ensure the empty container root for global memory subtrees.
 * Hangs directly under the global root as a navigation skeleton; the actual
 * per-agent memory subtree roots (`wiki-root:memory-agent:<agentId>`) are
 * created lazily by ensureMemoryAgentRoot and live as siblings of this node.
 * NOT protected.
 */
function ensureMemoryRoot(wikiStore: WikiStore): void {
	const existing = wikiStore.getByParentAndPath(WIKI_GLOBAL_ROOT_ID, MEMORY_ROOT_PATH_SEED);
	if (existing) return;
	wikiStore.create({
		parentId: WIKI_GLOBAL_ROOT_ID,
		path: MEMORY_ROOT_PATH_SEED,
		title: "Memory",
		summary: "全局记忆子树;每个 agent 一个 memory/<agentId> 子树。",
		type: "memory" as any,
	});
}
