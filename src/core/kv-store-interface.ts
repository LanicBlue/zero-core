// 键值存储抽象接口
//
// # 文件说明书
//
// ## 核心功能
// 定义最小化的键值持久化存储接口，解耦核心层与具体存储实现
//
// ## 输入
// 键名（字符串）和值（JSON 序列化对象或字符串）
//
// ## 输出
// IKVStore 接口，提供 get/set/delete/list 操作
//
// ## 定位
// src/core/ — 核心层接口定义，由 server 层具体实现
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 接口变更需确保所有实现方同步更新
//
/**
 * Minimal interface for key-value persistence.
 * Core layer uses this instead of depending on server/CoreDatabase.
 */
export interface IKVStore {
	getJson<T>(key: string): T | null;
	setJson(key: string, value: unknown): void;
	get(key: string): string | null;
	set(key: string, value: string): void;
	delete(key: string): void;
	list(): Array<{ key: string; value: string }>;
}
