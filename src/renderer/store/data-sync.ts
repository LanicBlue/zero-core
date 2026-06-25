// renderer 侧 UI 自动刷新订阅 helper
//
// # 文件说明书
//
// ## 核心功能
// 订阅统一的 data:changed 通道,按 collection 过滤。两种用法:
//   - subscribeDataChange(collection, refetchAll):收到任意变更就全量 refetch
//     (适用于树形/结构 store,如 wiki)。
//   - subscribeListDataChange(collection, { fetchOne, refetchAll, patch }):
//     **增量** patch —— 单条 create/update 只 fetch 那一条记录替换进数组,
//     delete 从数组移除;burst(同 tick 变更超过阈值)回退全量 refetch。
//     适用于列表 store(agents/projects/crons/requirements)。
//
// ## 配套
// 服务端 data-change-hub 在 SqliteStore 写原语层 emit,带 {id, op}。
// collection 取值见 hub 的 UI_COLLECTIONS。
//

const api = () => (window as any).api;

export interface DataChangeRecord {
	id: string;
	op: "create" | "update" | "delete";
}

/** 收到该 collection 的任意变更 → 全量 refetch(树形 store 用)。 */
export function subscribeDataChange(collection: string, refetchAll: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	return api().onDataChanged((e: { collection: string }) => {
		if (e.collection === collection) refetchAll();
	});
}

/**
 * Burst 阈值:同 tick 内变更条数超过此值,放弃逐条 patch,回退全量 refetch
 * (一次性 GET 列表比 N 次 GET /:id 更省)。
 */
const PATCH_BURST_THRESHOLD = 5;

/**
 * 列表 store 增量订阅。单条变更 → patch(id, op) 增量更新;burst → refetchAll。
 *
 * @param fetchOne(id) 拉单条记录(用于 create/update 后替换进数组)。delete 不需要它。
 * @param patch(id, record|null) 把记录替换/追加进数组;传 null 表示按 id 移除(delete)。
 *        返回 false 表示 patch 没命中(记录不在当前列表,如别人项目的 requirement),
 *        调用方可据此决定是否回退全量。通常忽略即可(不在列表就不用动)。
 * @param refetchAll burst 时回退用。
 */
export function subscribeListDataChange(collection: string, opts: {
	fetchOne: (id: string) => Promise<any | null | undefined>;
	patch: (id: string, record: any | null) => void;
	refetchAll: () => void;
}): () => void {
	if (typeof window === "undefined") return () => {};
	return api().onDataChanged(async (e: { collection: string; changes: DataChangeRecord[] }) => {
		if (e.collection !== collection) return;
		const changes = e.changes ?? [];
		// Burst (or unknown shape) → full refetch is cheaper than N round-trips.
		if (changes.length === 0 || changes.length > PATCH_BURST_THRESHOLD) {
			opts.refetchAll();
			return;
		}
		for (const c of changes) {
			if (c.op === "delete") {
				opts.patch(c.id, null);
			} else {
				// create or update — fetch the one record and replace/append.
				try {
					const record = await opts.fetchOne(c.id);
					if (record && !(record as any).error) {
						opts.patch(c.id, record);
					} else {
						// Record vanished (e.g. race with delete) → ensure removed.
						opts.patch(c.id, null);
					}
				} catch {
					// Single-record fetch failed → fall back to a full refetch.
					opts.refetchAll();
					return;
				}
			}
		}
	});
}
