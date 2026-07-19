// WikiService 错误对象 / 错误判定（wiki-system-redesign plan-02 §1 / §2）
//
// # 文件说明书
//
// ## 核心功能
// WikiService 层抛出的错误统一形状：`WikiError`（code + message + 可选
// requestId/path）。service 在解析、授权、CRUD、edit 各阶段失败时抛
// `WikiError`;调用方（wiki-tool / REST / UI）捕获后映射到 ToolResult / HTTP。
//
// ## 关键不变量（plan-02 §2 / acceptance-02 §G）
//   - 错误码必须来自 `WikiErrorCode` 闭集（20 个;不增删）。
//   - 错误消息严禁携带内部整数 ID。
//   - 同一外观规则（acceptance-02 §C）：无 grant 覆盖与节点不存在均返回
//     NOT_FOUND,且消息文本不应泄露哪种情况;由 service 调用方决定细节。
//
// ## 不做
//   - 不在错误对象里塞内部 ID（id / parent_id / target_id）。
//   - 不把错误码闭集扩展（必须先改 design + 共享契约）。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-02-core-service-address-auth.md §2
//   - docs/archive/wiki-system-redesign/design.md §8.10（错误码闭集）

import type { WikiError, WikiErrorCode } from "../../shared/wiki-types.js";

/**
 * WikiService 抛出的错误对象。继承 Error 以便 try/catch + instanceof。
 * 携带 `code` 字段（WikiErrorCode 闭集）和可选 `path` / `requestId` 元信息。
 */
export class WikiServiceError extends Error {
	readonly code: WikiErrorCode;
	readonly path: string | null;
	readonly requestId: string | null;

	constructor(code: WikiErrorCode, message: string, opts: {
		path?: string | null;
		requestId?: string | null;
		cause?: unknown;
	} = {}) {
		super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
		this.name = "WikiServiceError";
		this.code = code;
		this.path = opts.path ?? null;
		this.requestId = opts.requestId ?? null;
	}

	/** 转为共享契约 WikiError（无内部 ID）。 */
	toWikiError(): WikiError {
		return {
			code: this.code,
			message: this.message,
			requestId: this.requestId,
			path: this.path,
		};
	}
}

/**
 * 断言值非 undefined / null,否则抛 NOT_FOUND。常见于「按 path 查节点未命中」。
 */
export function assertFound<T>(value: T | null | undefined, code: WikiErrorCode, message: string, opts: {
	path?: string | null;
	requestId?: string | null;
} = {}): T {
	if (value === null || value === undefined) {
		throw new WikiServiceError(code, message, opts);
	}
	return value;
}

/**
 * 便捷构造。callers 用 `throw wikiError('INVALID_ADDRESS', '...')` 风格。
 */
export function wikiError(code: WikiErrorCode, message: string, opts: {
	path?: string | null;
	requestId?: string | null;
	cause?: unknown;
} = {}): WikiServiceError {
	return new WikiServiceError(code, message, opts);
}

/**
 * 判断是否 WikiServiceError（窄化类型用）。
 */
export function isWikiServiceError(err: unknown): err is WikiServiceError {
	return err instanceof WikiServiceError;
}
