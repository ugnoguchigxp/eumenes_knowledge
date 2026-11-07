import type { AccessContext } from "./access.js";
import type { KnowledgeStatus } from "./api.js";
import type { DocumentListPage, DocumentSummary } from "./documents.js";
import type {
	IngestDocumentPayload,
	JobSink,
	KnowledgeJobHandler,
	SyncPagePayload,
	Tx,
} from "./jobs.js";
import type { Clock, DocumentSourcePort, EventSink } from "./ports.js";

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

/** Result of reading one document for ingestion. */
export type IngestDocumentOutput =
	| {
			kind: "read";
			binding: string;
			summary: DocumentSummary;
			/** UTF-8 byte length of the verified body. */
			byteLength: number;
	  }
	/** The source answered 404/403 or the namespace left the allowed areas: the document becomes unavailable. */
	| { kind: "unavailable"; binding: string; reason: "not_found" | "forbidden" }
	/** The source already holds a different version: the observed one is superseded, nothing is applied. */
	| { kind: "superseded"; binding: string; markdownSha256: string };

export type CreateSyncPageHandler = (
	deps: HandlerDeps,
) => KnowledgeJobHandler<
	SyncPagePayload,
	SyncPagePayload & { binding: string },
	SyncPageOutput
>;

export type CreateIngestDocumentHandler = (
	deps: HandlerDeps,
) => KnowledgeJobHandler<
	IngestDocumentPayload,
	IngestDocumentPayload & { binding: string },
	IngestDocumentOutput
>;
