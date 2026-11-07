import type { AccessContext } from "./access.js";
import type { KnowledgeStatus } from "./api.js";
import type { DocumentListPage } from "./documents.js";
import type {
	HostWriter,
	IngestNextPayload,
	JobSink,
	KnowledgeJobHandler,
	SyncPagePayload,
	Tx,
} from "./jobs.js";
import type {
	Clock,
	DocumentSourcePort,
	EmbeddingPort,
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
	/** Additional extraction passes per fragment (p0.md #4). Default 0. */
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
