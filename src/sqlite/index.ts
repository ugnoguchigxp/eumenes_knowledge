// Registry tables and synchronous operations. This module never opens a database and never
// imports `bun:sqlite` at run time: the host passes its connection (types only here).
export { migrations } from "./schema.js";
export {
	applyIngestedVersionInTransaction,
	getDocumentInTransaction,
	markDocumentUnavailableInTransaction,
	markOutsideNamespacesUnavailableInTransaction,
	recordIngestFailureInTransaction,
	observeDocumentInTransaction,
	retireDocumentInTransaction,
} from "./documents.js";
export type {
	DocumentKey,
	DocumentRow,
	IngestExpectation,
	ObservationResult,
	StoredDocumentState,
} from "./documents.js";
export {
	beginScanInTransaction,
	failScanInTransaction,
	getScanInTransaction,
	isScanPageSettledInTransaction,
	settleScanPageInTransaction,
	supersedeRunningScansInTransaction,
} from "./scans.js";
export type { ScanRow } from "./scans.js";
export { readScanInSnapshot, readStatusInSnapshot } from "./status.js";
