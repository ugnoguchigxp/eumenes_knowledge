// Registry tables and synchronous operations. This module never opens a database and never
// imports `bun:sqlite` at run time: the host passes its connection (types only here).
export { migrations } from "./schema.js";
export {
	applyIngestedVersionInTransaction,
	getDocumentInTransaction,
	markDocumentUnavailableInTransaction,
	markOutsideNamespacesUnavailableInTransaction,
	markIngestSupersededInTransaction,
	recordIngestFailureInTransaction,
	recordTransientIngestFailureInTransaction,
	resetIngestFailuresInTransaction,
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
	pruneScansInTransaction,
	settleScanPageInTransaction,
	supersedeRunningScansInTransaction,
} from "./scans.js";
export type { ScanRow } from "./scans.js";
export { readScanInSnapshot, readStatusInSnapshot } from "./status.js";
export {
	abandonVersionInTransaction,
	cleanupInTransaction,
	countPublishedFragmentsInTransaction,
	createStagingVersionInTransaction,
	decodeVector,
	discardStagingInTransaction,
	encodeVector,
	getVersionInTransaction,
	hasCleanupInTransaction,
	publishVersionInTransaction,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageVectorsInTransaction,
} from "./versions.js";
export type {
	FragmentToStage,
	StagingTicket,
	VersionRow,
	VersionState,
} from "./versions.js";
export {
	advanceChainInTransaction,
	closeChainInTransaction,
	getActiveIngestInTransaction,
	getChainInTransaction,
	isChainOpenInTransaction,
	openChainInTransaction,
	pickNextDocumentInTransaction,
	setActiveIngestInTransaction,
	touchChainInTransaction,
} from "./chain.js";
export type { ChainState } from "./chain.js";
// Reads by version id (fragments, extractions, mentions, evidence, vectors, `getVersionInSnapshot`)
// and the maintenance read `getRetainedVersionInSnapshot` are internal to `./reads.js`: they do not
// check a document's state or a caller's namespaces.
export {
	MAX_SEARCH_LIMIT,
	getPublishedVersionInSnapshot,
	readPublishedVectorsInSnapshot,
	searchFragmentsInSnapshot,
} from "./reads.js";
export type {
	FragmentSearchHit,
	StoredEntityMention,
	StoredEvidence,
	StoredExtraction,
	StoredFragment,
	StoredRelationMention,
	StoredVector,
} from "./reads.js";
