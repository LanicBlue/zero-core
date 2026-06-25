// renderer 侧 UI 自动刷新订阅 helper
//
// # 文件说明书
//
// ## 核心功能
// 订阅统一的 data:changed 通道,按 collection 过滤。服务端在 store
// create/update 时**直接推送完整记录**(免 renderer 再 GET /:id),delete 推
// id。两种用法:
//   - subscribeDataChange(collection, refetchAll):收到任意变更就全量 refetch
//     (树形/结构 store 用,如 wiki)。
//   - subscribeListDataChange(collection, { patch, refetchAll }):列表 store
//     增量 patch —— create/update 推来的记录原地替换;delete 移除。新 id
//     (不在当前列表,如别项目的 requirement)由 patch 返回 false,helper
//     回退一次 refetchAll 重新套用 filter。
//
// ## 配套
// 服务端 data-change-hub 在 SqliteStore 写原语层 emit,带 {id, op, record?}。
// collection 取值见 hub 的 UI_COLLECTIONS。
//

const api = () => (window as any).api;

export interface DataChangeRecord {
	id: string;
	op: "create" | "update" | "delete";
	record?: any;
}

/** 收到该 collection 的任意变更 → 全量 refetch(树形 store 用)。 */
export function subscribeDataChange(collection: string, refetchAll: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	return api().onDataChanged((e: { collection: string }) => {
		if (e.collection === collection) refetchAll();
	});
}

/**
 * 列表 store 增量订阅。
 *
 * @param patch(id, record|null) 把记录原地替换进数组;record=null 表示按 id
 *        移除(delete)。**返回 true = 该 id 在当前列表里(已处理);返回
 *        false = 不在列表** —— 对 create/update,helper 据此回退一次
 *        refetchAll(重新套用 filter,正确纳入新项/过滤项)。delete 的返回值
 *        忽略(不在就 no-op)。
 *        策略由各 store 自定:非过滤 store(agents/projects/crons)直接
 *        append+返回 true;过滤 store(requirements)仅在已存在时替换、
 *        否则返回 false。
 */
export function subscribeListDataChange(collection: string, opts: {
	patch: (id: string, record: any | null) => boolean;
	refetchAll: () => void;
}): () => void {
	if (typeof window === "undefined") return () => {};
	return api().onDataChanged((e: { collection: string; changes: DataChangeRecord[] }) => {
		if (e.collection !== collection) return;
		for (const c of e.changes ?? []) {
			if (c.op === "delete") {
				opts.patch(c.id, null); // 在就移除,不在 no-op;返回值忽略
				continue;
			}
			// create/update —— 推来了完整 record。
			const handled = opts.patch(c.id, c.record);
			if (!handled) {
				// 新 id 不在当前(可能过滤过的)列表 → 重新拉一次套用 filter。
				opts.refetchAll();
				return;
			}
		}
	});
}
