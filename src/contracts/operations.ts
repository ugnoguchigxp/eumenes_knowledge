import type { AccessContext } from "./access.js";
import type {
	EvidenceRequest,
	EvidenceResponse,
	GraphRequest,
	GraphResponse,
	KnowledgeStatus,
	RelatedRequest,
	RelatedResponse,
	SearchRequest,
	SearchResponse,
} from "./api.js";
import type { DocumentListPage } from "./documents.js";
import type {
	HostWriter,
	IngestNextPayload,
	LinkNextPayload,
	JobSink,
	KnowledgeJobHandler,
	SyncPagePayload,
	Tx,
} from "./jobs.js";
import type {
	Clock,
	DocumentSourcePort,
	EmbeddingPort,
	TokenizerPort,
	EventSink,
	InferencePort,
} from "./ports.js";

/**
 * Signatures of the package operations a host calls. `src/core` and `src/sqlite` implement them;
 * the example host and the future Eumenes adapter depend on these types only.
 */

export type StatusOptions = {
	/** A current document whose last verification is older than this is counted as unverified. */
	verifiedWithinMs: number;
	/**
	 * The host's current source binding (`DocumentSourcePort.binding()`). When given, only a scan
	 * completed under this binding counts as complete; null means the source is unconfigured.
	 */
	binding?: string | null;
	/**
	 * Stale documents whose version reached this many unapplied ingest attempts are counted as
	 * failed (`failed_documents`). Must equal the ingest option of the same name. Default 3.
	 */
	maxUnappliedAttempts?: number;
};

/** Read the status visible to `access` from one committed snapshot. Writes nothing. */
export type ReadStatusInSnapshot = (
	db: Tx,
	access: AccessContext,
	now: number,
	options: StatusOptions,
) => KnowledgeStatus;

/** A listing scan as the package records it. The host joins it with its own acceptance record. */
export type ScanStatus = {
	scanId: string;
	/** `complete`: the last page settled under the binding of the first page. */
	state: "running" | "complete" | "failed";
	pagesSettled: number;
	/** Ingest jobs this scan handed to the host's `JobSink`. */
	documentsQueued: number;
	/** Safe code when failed (`binding_changed`, `cancelled`, the job's error code, ...). */
	errorCode: string | null;
	startedAt: number;
	finishedAt: number | null;
};

/** Read one scan from a committed snapshot; null when the package never saw it. */
export type ReadScanInSnapshot = (db: Tx, scanId: string) => ScanStatus | null;

export type HandlerDeps = {
	source: DocumentSourcePort;
	jobs: JobSink;
	clock: Clock;
	events?: EventSink;
	/**
	 * The tokenizer of the model-free extractor (`extractor: "names"`, kg2.md §3.2). Default: the
	 * package's `createCharclassTokenizer()` (no dictionary). The sync-page job reads its id too
	 * (what extracted a version, kg2.md G7), so the same deps go to every job.
	 */
	tokenizer?: TokenizerPort;
};

/** Result of reading one listing page (opaque to the host apart from being serialisable). */
export type SyncPageOutput = {
	binding: string;
	page: DocumentListPage;
};

export type CreateSyncPageHandler = (
	deps: HandlerDeps,
) => KnowledgeJobHandler<
	SyncPagePayload,
	SyncPagePayload & { binding: string },
	SyncPageOutput
>;

/** What the P2 ingest chain needs on top of the P1 deps (p2.md §2). */
export type IngestDeps = HandlerDeps & {
	inference: InferencePort;
	embedding: EmbeddingPort;
	writer: HostWriter;
};

export type IngestOptions = {
	/** Upper bound of a document body in UTF-8 bytes. Default 8 MiB (Docling's limit). */
	maxDocumentBytes?: number;
	/** Upper bound of one fragment in UTF-8 bytes. Default `MAX_FRAGMENT_BYTES`. */
	maxFragmentBytes?: number;
	/**
	 * How fragments are extracted (kg2.md §3.1). `model`: the model's answer for each fragment
	 * (instruction `extract`, checked by `verifyExtraction`). `names`: no model; names from the
	 * tokenizer by the package's rules, and no relation (`extractNames`; kg2.md §7.14). Default
	 * `names` (KG2 G7: the model's extraction is frozen, kept for a host that asks for it). With
	 * `names`, a published version extracted by another extractor, tokenizer or rules version is
	 * extracted again from its stored fragments (no source read, no embedding), while the old
	 * version is still read. Hosts must pass the same value to the sync-page job.
	 */
	extractor?: "model" | "names";
	/** Additional extraction passes per fragment (p0.md #4). Default 0; only for `model`. */
	gleaning?: number;
	/**
	 * Unapplied attempts of one version, counted only for failures caused by the content (digest,
	 * size, contract), before it is skipped until the version changes. Default 3. Hosts must pass
	 * the same value to the sync-page job and the status read (`DEFAULT_MAX_UNAPPLIED_ATTEMPTS`).
	 */
	maxUnappliedAttempts?: number;
	/**
	 * Base delay before a document whose ingest failed for a temporary reason (a port failure, a
	 * shutdown, a restart, a deadline) is picked again. Such failures are not counted. Default 5 min.
	 */
	transientRetryDelayMs?: number;
	/** Fragments one document may have; more is refused as `document_too_large`. Default 10,000. */
	maxFragmentsPerDocument?: number;
	/** Fragments of all published versions together (p0.md §6.2: 50,000 per space). Default 50,000. */
	maxIndexedFragments?: number;
	/** A staging version older than this that no running link owns is abandoned. Default 6 hours. */
	orphanStagingAfterMs?: number;
	/** Rows of retired or abandoned versions deleted per transaction. */
	cleanupBatchRows?: number;
	/** Limit of one inference call, in milliseconds (capped by the job's deadline). */
	inferenceTimeoutMs?: number;
};

export type CreateIngestNextHandler = (
	deps: IngestDeps,
	options?: IngestOptions,
) => KnowledgeJobHandler<IngestNextPayload, unknown, unknown>;

// ---------------------------------------------------------------------------
// Search and evidence (p3.md §3, §4)
// ---------------------------------------------------------------------------

/** Runs a synchronous read on one committed snapshot of the host's database. */
export type SnapshotReader = <T>(operation: (db: Tx) => T) => T;

/**
 * The resident vectors of the published fragments, per embedding space (p0.md #11). Created
 * once per host process by the package (`createVectorIndex`); only versions published or
 * retired since the last search are read again. Opaque to the host.
 */
export interface VectorIndex {
	readonly kind: "knowledge.vector-index";
}

export type SearchOptions = {
	/** Candidates each route may return. Default `SEARCH_LIMITS.candidatesPerRoute`. */
	candidatesPerRoute?: number;
	/** Limit of the query embedding. Default 2,500 ms. */
	queryEmbeddingTimeoutMs?: number;
	/** Upper bound of the answer's quotes in UTF-8 bytes. Default `SEARCH_LIMITS.responseBytes`. */
	maxResponseBytes?: number;
	/** Above this many searchable fragments a query under 3 characters is not scanned. Default 50,000. */
	substringScanMaxFragments?: number;
	/**
	 * Above this many searchable fragments the routes of names and relations do not scan for a
	 * query under 3 characters (`route_skipped`): their tables hold some 50 and 100 rows per
	 * fragment (kg2.md §7.12). Default 5,000.
	 */
	substringScanMaxNameFragments?: number;
	/** Same meaning as in `StatusOptions`. */
	verifiedWithinMs: number;
	maxUnappliedAttempts?: number;
};

export type SearchDeps = {
	read: SnapshotReader;
	embedding: EmbeddingPort;
	vectors: VectorIndex;
	clock: Clock;
	events?: EventSink;
	options: SearchOptions;
};

/** Search what `access` may read. Validates `request` itself; never writes. */
export type Search = (
	deps: SearchDeps,
	access: AccessContext,
	request: SearchRequest,
	signal: AbortSignal,
) => Promise<SearchResponse>;

/** Check a cited range against the current index (adoption-time check, plan §5.2 step 6). */
export type ReadEvidence = (
	deps: Pick<SearchDeps, "read" | "clock" | "options">,
	access: AccessContext,
	request: EvidenceRequest,
) => EvidenceResponse;

// ---------------------------------------------------------------------------
// Identity links, summaries and related documents (p3.md §8)
// ---------------------------------------------------------------------------

export type LinkOptions = {
	/** Candidates compared with one mention (several calls if above `LINK_LIMITS.candidatesPerCall`). Default 10. */
	maxCandidatesPerMention?: number;
	/**
	 * Which mentions the mention full-text index adds after the equal names (kg.md §7): `name`,
	 * those whose name contains the mention's name; `text`, also those whose type or description
	 * contains it (P3). Default `name`.
	 */
	candidateMatch?: "name" | "text";
	/** Mentions of one version compared per link of the chain. Default 200. */
	maxMentionsPerVersion?: number;
	/**
	 * Whether entities are summarized by the model (instruction `summarize`). Default false (KG2
	 * G7: frozen). Hosts must pass the same value to the sync-page job.
	 */
	summaries?: boolean;
	/** An entity is summarized once this many current mentions from at least two documents are linked. Default 3. */
	summaryMinMentions?: number;
	/** Limit of one inference call, in milliseconds. Default 120,000. */
	inferenceTimeoutMs?: number;
	/** Same meaning as in `IngestOptions`. Default 5 minutes. */
	transientRetryDelayMs?: number;
};

export type CreateLinkNextHandler = (
	deps: IngestDeps,
	options?: LinkOptions,
) => KnowledgeJobHandler<LinkNextPayload, unknown, unknown>;

/**
 * Documents related to one document, as far as `access` may read (never writes): by shared
 * entities and, when `deps.vectors` is given (the search's index), by the nearness of fragments.
 */
export type ReadRelated = (
	deps: Pick<SearchDeps, "read" | "clock" | "options"> &
		Partial<Pick<SearchDeps, "vectors">>,
	access: AccessContext,
	request: RelatedRequest,
) => RelatedResponse;

/** The knowledge graph of the current documents `access` may read (kg.md §2; never writes). */
export type ReadGraph = (
	deps: Pick<SearchDeps, "read" | "clock" | "options">,
	access: AccessContext,
	request: GraphRequest,
) => GraphResponse;
