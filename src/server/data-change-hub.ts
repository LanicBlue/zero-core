// 数据变更通知中枢 (v0.8 UI 同步统一机制)
//
// # 文件说明书
//
// ## 核心功能
// 把 SqliteStore 的底层写(insertRow/updateRow/delete)统一聚合成一条
// `data:changed` 事件流,按 collection(= 表名)+ 变更明细 {id, op} 分发。
// renderer 订阅单通道、按 collection 过滤后**增量**更新对应 store(只刷新
// 变化的记录),取代之前每个域一条事件通道、每个 store 手写 onChange、整表
// refetch 的做法。
//
// ## 为什么在 SqliteStore 层 emit
// 所有领域 store(AgentStore/ProjectStore/CronStore/RequirementStore/WikiStore
// ...)都包装同一个 SqliteStore。在 SqliteStore 的三个写原语里 emit,所有
// store 自动获得 UI 同步,零样板、不漏入口(否则得逐个追 writeNodeDetail /
// transitionStatus / upsertProjectNode 这些非标准突变)。
//
// ## 白名单 + coalesce
// - **白名单**:messages / tool_usage / turns 等表写入极频繁(流式每 chunk
//   都写 messages),全量广播会刷屏。只对 UI 关心的 collection 发事件。
// - **coalesce**:同一 tick 内对同一 (collection,id) 的多次写合并成一条
//   (保留最新 op),批量写(archivist 扫描数百节点 / migrateFromJson)只
//   触发一次 flush。flush 携带该 collection 的全部变更明细,renderer 可据此
//   增量 patch(只刷变化的记录),burst 太大时回退全量 refetch。
//
// ## 新增一个 UI 同步域
// 1) 把表名加进 UI_COLLECTIONS;2) 该 renderer store 调 subscribeDataChange
// 订阅。两处,各一行。
//

/**
 * UI 关心的 collection(= SqliteStore 表名)。其它表的写不广播。
 *
 * N1 (runtime-push-ui-sync) 扩展:
 * - 表:sessions(侧栏会话列表)/ orchestrate_plans(Kanban pending + confirm)/
 *   task_steps / requirement_messages(ExecutionDetail)。
 * - server 层 runtime 虚拟 collection(运行时内存对象经 emitDataChange 喂入):
 *   runtime:mcp / runtime:metrics / runtime:input-queue / runtime:orchestrate。
 *   它们不是 SqliteStore 表,但走同一条 hub → data:changed 通道,与表写一视同仁。
 * - **runtime:tasks 不进白名单**:它走 agent:event(runtime 层 TaskRegistry 不能
 *   反向 import server 层 hub),不经此通道。
 */
const UI_COLLECTIONS = new Set([
	"agents",
	"projects",
	"crons",
	"requirements",
	"project_wiki",
	// N1: structural session-list collections + kanban / execution-detail tables.
	"sessions",
	"orchestrate_plans",
	"task_steps",
	"requirement_messages",
	// N1: server-layer runtime virtual collections (in-memory objects that
	// emitDataChange directly). NOT SqliteStore tables — they share this
	// hub → data:changed channel.
	"runtime:mcp",
	"runtime:metrics",
	"runtime:input-queue",
	"runtime:orchestrate",
]);

export type DataChangeOp = "create" | "update" | "delete";

export interface DataChangeRecord {
	id: string;
	op: DataChangeOp;
	/** create/update 推送完整记录,renderer 直接 patch 免再 GET;delete 无。 */
	record?: unknown;
}

export interface DataChangeEvent {
	collection: string;
	/** 该 collection 在本 tick 内的全部变更明细(已按 id 去重,保留最新 op+record)。 */
	changes: DataChangeRecord[];
}

type Listener = (e: DataChangeEvent) => void;

const listeners = new Set<Listener>();

/** pending: collection → (id → 最新 {op, record?})。 */
let pending = new Map<string, Map<string, { op: DataChangeOp; record?: unknown }>>();
let scheduled = false;

function flush(): void {
	scheduled = false;
	const ready = pending;
	pending = new Map();
	for (const [collection, byId] of ready) {
		const changes: DataChangeRecord[] = [];
		for (const [id, entry] of byId) {
			// delete 不带 record(create/update 后再 delete → record 清掉)。
			changes.push(entry.op === "delete" ? { id, op: "delete" } : { id, op: entry.op, record: entry.record });
		}
		const e: DataChangeEvent = { collection, changes };
		for (const cb of listeners) {
			try { cb(e); } catch { /* 一个监听者出错不能中断其它 */ }
		}
	}
}

/**
 * SqliteStore 写原语调此发变更。非 UI collection 直接忽略;UI collection 把
 * (id, op, record?) 记入待 flush 队列(同 id 后写覆盖前写),下一个 tick 合并
 * 广播。create/update 带 record(renderer 直接 patch,免 GET /:id);delete 不带。
 */
export function emitDataChange(table: string, id: string, op: DataChangeOp, record?: unknown): void {
	if (!UI_COLLECTIONS.has(table)) return;
	let byId = pending.get(table);
	if (!byId) { byId = new Map(); pending.set(table, byId); }
	byId.set(id, { op, record });
	if (!scheduled) {
		scheduled = true;
		setTimeout(flush, 0);
	}
}

/** 订阅 data:changed。返回取消订阅。server/index.ts 用它接到 WS broadcast。 */
export function onDataChange(cb: Listener): () => void {
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}

/** 测试用:重置 hub 状态。 */
export function _resetDataChangeHubForTest(): void {
	listeners.clear();
	pending = new Map();
	scheduled = false;
}
