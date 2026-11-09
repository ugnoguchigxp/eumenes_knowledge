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
	delayReextractInTransaction,
	hasCleanupInTransaction,
	pickVersionToReextractInTransaction,
	publishVersionInTransaction,
	readVersionToCopyInTransaction,
	republishVersionInTransaction,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageVectorsInTransaction,
} from "./versions.js";
export type {
	FragmentToStage,
	ReextractTarget,
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
// Search reads (p3.md 3, 4): every one takes the caller's namespaces and fails closed.
export {
	countSearchableFragmentsInSnapshot,
	listSearchableVersionIdsInSnapshot,
	readEvidenceTargetInSnapshot,
	readSearchCoverageInSnapshot,
	readSearchableFragmentsInSnapshot,
	scanFragmentsInSnapshot,
	scanMentionsInSnapshot,
	searchMentionsInSnapshot,
} from "./search.js";
export type {
	EvidenceTarget,
	FragmentRef,
	MentionHit,
	MentionKind,
	SearchCoverage,
	SearchCoverageOptions,
	SearchableFragment,
} from "./search.js";
// Identity chain and its work queries (p3.md 8). The reads of mentions, candidates, clusters and
// summaries ignore a caller's namespaces, so they stay internal to `./links.js`.
export {
	advanceLinkChainInTransaction,
	closeLinkChainInTransaction,
	getActiveLinkInTransaction,
	getLinkChainInTransaction,
	isLinkChainLiveInTransaction,
	openLinkChainInTransaction,
	setActiveLinkInTransaction,
	touchLinkChainInTransaction,
} from "./link-chain.js";
export type { LinkActive, LinkChainState } from "./link-chain.js";
export {
	MAX_SUMMARY_MEMBERS,
	hasVersionToCompareInTransaction,
	pickSummaryWorkInTransaction,
} from "./links.js";
export type { ClusterSummaryCandidate } from "./links.js";
// Graph reads (kg.md 2): the rows `readGraph` joins, all inside the caller's namespaces.
export {
	readGraphDocumentsInSnapshot,
	readGraphEvidenceInSnapshot,
	readGraphLinksInSnapshot,
	readGraphMentionsInSnapshot,
	readGraphRelationsAmongInSnapshot,
} from "./graph.js";
export type {
	GraphDocument,
	GraphEvidence,
	GraphLink,
	GraphMention,
	GraphRelation,
} from "./graph.js";
