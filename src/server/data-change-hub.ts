// 数据变更通知中枢 (v0.8 UI 同步统一机制)
//
// # 文件说明书
//
// ## 核心功能
// 把 SqliteStore 的底层写(insertRow/updateRow/delete)统一聚合成一条
// `data:changed` 事件流,按 collection(= 表名)分发。renderer 订阅单通道、
// 按 collection 过滤后 refetch 对应 store —— 取代之前每个域一条事件通道
// (agents:changed / projects:changed / ...)、每个 store 手写 onChange 的做法。
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
// - **coalesce**:同一 tick 内对同一 collection 的多次写合并成一次 flush,
//   批量写(archivist 扫描数百节点 / migrateFromJson)只触发一次 UI 刷新。
//
// ## 新增一个 UI 同步域
// 1) 把表名加进 UI_COLLECTIONS;2) 该 renderer store 调 subscribeDataChange
// 订阅。两处,各一行。
//

/** UI 关心的 collection(= SqliteStore 表名)。其它表的写不广播。 */
const UI_COLLECTIONS = new Set([
	"agents",
	"projects",
	"crons",
	"requirements",
	"project_wiki",
]);

export interface DataChangeEvent {
	collection: string;
}

type Listener = (e: DataChangeEvent) => void;

const listeners = new Set<Listener>();

/** 本 tick 内有变更待 flush 的 collection(去重)。 */
let pending = new Set<string>();
let scheduled = false;

function flush(): void {
	scheduled = false;
	const ready = pending;
	pending = new Set();
	for (const collection of ready) {
		const e: DataChangeEvent = { collection };
		for (const cb of listeners) {
			try { cb(e); } catch { /* 一个监听者出错不能中断其它 */ }
		}
	}
}

/**
 * SqliteStore 写原语调此发变更。非 UI collection 直接忽略;UI collection 进
 * 待 flush 队列,下一个 tick 合并广播。collection 粒度(不带 id)——renderer
 * 反正是整表 refetch,id 无用,且去重更彻底。
 */
export function emitDataChange(table: string): void {
	if (!UI_COLLECTIONS.has(table)) return;
	pending.add(table);
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
	pending = new Set();
	scheduled = false;
}
