// Wiki 模块 barrel（wiki-system-redesign plan-01 §1）
//
// # 文件说明书
//
// ## 核心功能
// `src/server/wiki/` 模块的统一出口。DatabaseManager / 后续 sub 的 service 层
// 通过此 import,避免散落多行 import。
//
// ## 不做
//   - 不在此塞业务逻辑(plan-02 service 层独立)。
//   - 不重新导出内部 row 类型中的敏感字段(只导出类型与 class 本身)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-01-database-contracts.md §1（模块布局）

export { WikiDatabase } from "./wiki-database.js";
export type { WikiDatabaseHealth } from "./wiki-database.js";
export { WIKI_SCHEMA_VERSION } from "./wiki-schema.js";
export {
	initWikiSchema,
	readWikiSchemaVersion,
	WIKI_TABLE_NAMES,
} from "./wiki-schema.js";
export {
	WIKI_ROOT_PATH,
	WIKI_PATH_SEPARATOR,
	WIKI_NAME_MAX_LENGTH,
	WIKI_PATH_MAX_SEGMENTS,
	normalizeWikiPath,
	joinWikiPath,
	parentWikiPath,
	isSameOrDescendant,
	validateWikiName,
	splitWikiPath,
	lastSegmentOfWikiPath,
	isWikiRoot,
} from "./wiki-path.js";
export {
	WikiNodeRepository,
	rowKindAsKind,
} from "./wiki-node-repository.js";
export type {
	WikiNodeRow,
	CreateNodeInput,
	UpdateNodeInput,
	WikiChildCursor,
} from "./wiki-node-repository.js";
export { WikiLinkRepository } from "./wiki-link-repository.js";
export type { WikiLinkRow, CreateLinkInput } from "./wiki-link-repository.js";
export {
	WikiRepositoryStore,
	WikiRepositoryTable,
	WikiSourceBindingTable,
	WikiAddressTable,
} from "./wiki-repository-store.js";
export type {
	WikiRepositoryRow,
	UpsertRepositoryInput,
	WikiSourceBindingRow,
	UpsertSourceBindingInput,
	WikiAddressRow,
	UpsertAddressInput,
} from "./wiki-repository-store.js";
export { WikiAuditRepository } from "./wiki-audit-repository.js";
export type {
	WikiAuditRow,
	AppendAuditInput,
	AppendAuditResult,
} from "./wiki-audit-repository.js";

// plan-02 data-plane service layer（wiki-system-redesign）
export { WikiService, WIKI_MOVE_NODE_CAP } from "./wiki-service.js";
export type { WikiServiceDeps } from "./wiki-service.js";
export { WikiAddressService } from "./wiki-address-service.js";
export type {
	WikiAddressContext,
	WikiResolvedAddress,
	RegisterAddressInput,
	WikiAddressResolver,
} from "./wiki-address-service.js";
export {
	WIKI_DYNAMIC_MEMORY_SCHEME,
	WIKI_DYNAMIC_PROJECT_SCHEME,
	WIKI_ADDRESS_RESOLVERS,
} from "./wiki-address-service.js";
export { WikiAuthorizationService } from "./wiki-authorization-service.js";
export type { WikiAuthorizationDecision } from "./wiki-authorization-service.js";
export { WikiEditService } from "./wiki-edit-service.js";
export type { SectionHit } from "./wiki-edit-service.js";
export { WikiServiceError, isWikiServiceError, wikiError, assertFound } from "./wiki-errors.js";
