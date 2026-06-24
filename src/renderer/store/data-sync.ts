// renderer 侧 UI 自动刷新订阅 helper
//
// # 文件说明书
//
// ## 核心功能
// 订阅统一的 data:changed 通道,按 collection 过滤后触发回调(通常是该
// store 的 refetch)。这是把一个 renderer store 接到 UI 自动刷新的**唯一
// 声明点** —— 新增一个同步域只需在其 store 模块里调一次本函数。
//
// ## 配套
// 服务端 data-change-hub 在 SqliteStore 写原语层 emit,按表名(= collection)
// 广播。collection 取值见 hub 的 UI_COLLECTIONS(agents/projects/crons/
// requirements/project_wiki)。
//

const api = () => (window as any).api;

/**
 * Subscribe to the unified `data:changed` channel, filtered to one collection.
 * `cb` fires (e.g. refetch the store) whenever that collection is mutated
 * server-side — by any surface (management tool, REST router, archivist,
 * extractor). Returns an unsubscribe.
 */
export function subscribeDataChange(collection: string, cb: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	return api().onDataChanged((e: { collection: string }) => {
		if (e.collection === collection) cb();
	});
}
