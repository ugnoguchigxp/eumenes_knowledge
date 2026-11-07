import {
	documentInputSchema,
	ingestDocumentPayloadSchema,
	KNOWLEDGE_JOB_KINDS,
	KnowledgeError,
	SourceError,
	type CreateIngestDocumentHandler,
	type HandlerDeps,
	type IngestDocumentPayload,
	type Tx,
} from "../../contracts/index.js";
import {
	applyIngestedVersionInTransaction,
	getDocumentInTransaction,
	markDocumentUnavailableInTransaction,
	recordIngestFailureInTransaction,
} from "../../sqlite/index.js";
import { sha256Hex, utf8Bytes } from "../bytes.js";
import { classifyJobError, safeEmit } from "../support.js";

export const DEFAULT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export type IngestDocumentOptions = {
	/** Largest accepted body in UTF-8 bytes (default 8 MiB). */
	maxDocumentBytes?: number;
};

type Handler = ReturnType<CreateIngestDocumentHandler>;

/**
 * An ingest job ended without applying anything (final failure, cancel, stale result, stale
 * prepare). Its dedupe key stays used in the host queue, so count it: while the registry row
 * still matches the job, advance `ingest_retry` and the next scan queues the version under a new
 * key. A row that moved on is left alone (a newer key is already used or about to be). The row's
 * own current namespace is used, so a moved document still matches itself.
 */
function countUnappliedIngest(
	tx: Tx,
	deps: HandlerDeps,
	p: IngestDocumentPayload,
	eventType: string,
	level: "info" | "warn",
): void {
	const current = getDocumentInTransaction(tx, p);
	if (
		current &&
		recordIngestFailureInTransaction(
			tx,
			{ ...p, namespace: current.namespace },
			deps.clock.now(),
		)
	) {
		safeEmit(deps.events, {
			type: eventType,
			level,
			fields: { documentId: p.documentId, retry: p.retry + 1 },
		});
	}
}

/** Settle ends stale: nothing was applied, so count it first (see `countUnappliedIngest`). */
function staleUnapplied(
	tx: Tx,
	deps: HandlerDeps,
	p: IngestDocumentPayload,
): "stale" {
	countUnappliedIngest(
		tx,
		deps,
		p,
		"knowledge.document.ingest_unapplied",
		"info",
	);
	return "stale";
}

/** The job that reads one document version, verifies its bytes and marks the registry row current. */
export function createIngestDocumentHandler(
	deps: HandlerDeps,
	options: IngestDocumentOptions = {},
): Handler {
	const maxBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;

	return {
		kind: KNOWLEDGE_JOB_KINDS.ingestDocument,
		payloadVersions: [1],
		schema: ingestDocumentPayloadSchema,
		recovery: "replay_safe",

		prepareInTransaction(tx, claim) {
			const p = claim.payload;
			const row = getDocumentInTransaction(tx, p);
			if (
				!row ||
				row.state !== "stale" ||
				row.generation !== p.generation ||
				row.ingestRetry !== p.retry ||
				row.observedMarkdownSha256 !== p.markdownSha256
			) {
				return { status: "stale", reason: "superseded" };
			}
			const binding = deps.source.binding();
			if (binding === null) {
				// The row still matches this job (checked above) but the job ends here.
				countUnappliedIngest(
					tx,
					deps,
					p,
					"knowledge.document.ingest_unapplied",
					"info",
				);
				return { status: "stale", reason: "source_unconfigured" };
			}
			return { status: "ready", input: { ...p, binding } };
		},

		async execute(input, context) {
			const assertBinding = () => {
				if (deps.source.binding() !== input.binding) {
					throw new SourceError("connection_changed");
				}
			};
			assertBinding();
			let raw: unknown;
			try {
				raw = await deps.source.read(input.documentId, context.signal);
			} catch (error) {
				if (
					error instanceof SourceError &&
					(error.code === "not_found" || error.code === "forbidden")
				) {
					return {
						kind: "unavailable",
						binding: input.binding,
						reason: error.code,
					};
				}
				throw error;
			}
			assertBinding();
			const parsed = documentInputSchema.safeParse(raw);
			if (!parsed.success) throw new KnowledgeError("contract_mismatch");
			const { markdown, ...summary } = parsed.data;
			if (
				summary.documentId !== input.documentId ||
				summary.sourceNamespace !== input.sourceNamespace
			) {
				throw new KnowledgeError("document_mismatch");
			}
			if (summary.markdownSha256 !== input.markdownSha256) {
				return {
					kind: "superseded",
					binding: input.binding,
					markdownSha256: summary.markdownSha256,
				};
			}
			const bytes = utf8Bytes(markdown);
			if (sha256Hex(bytes) !== input.markdownSha256) {
				throw new KnowledgeError("digest_mismatch");
			}
			if (bytes.byteLength > maxBytes) {
				throw new KnowledgeError("document_too_large");
			}
			return {
				kind: "read",
				binding: input.binding,
				summary,
				byteLength: bytes.byteLength,
			};
		},

		classify: classifyJobError,

		settleInTransaction(tx, claim, _input, outcome) {
			const p: IngestDocumentPayload = claim.payload;
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success") {
				// The ingest ended for good: count it, so the next scan can queue this version
				// again under a new dedupe key. A row that moved on is left alone.
				countUnappliedIngest(
					tx,
					deps,
					p,
					"knowledge.document.ingest_failed",
					"warn",
				);
				return "applied";
			}
			const result = outcome.result;
			if (result.kind === "superseded") return staleUnapplied(tx, deps, p);
			if (deps.source.binding() !== result.binding) {
				return staleUnapplied(tx, deps, p);
			}
			const now = deps.clock.now();
			const row = getDocumentInTransaction(tx, p);
			if (
				!row ||
				row.state !== "stale" ||
				row.generation !== p.generation ||
				row.ingestRetry !== p.retry ||
				row.observedMarkdownSha256 !== p.markdownSha256
			) {
				return staleUnapplied(tx, deps, p);
			}
			const expected = { ...p, namespace: row.namespace };
			if (result.kind === "read") {
				const s = result.summary;
				if (
					s.documentId !== p.documentId ||
					s.sourceNamespace !== p.sourceNamespace ||
					s.markdownSha256 !== p.markdownSha256 ||
					s.namespace !== row.namespace
				) {
					return staleUnapplied(tx, deps, p);
				}
				if (
					!applyIngestedVersionInTransaction(
						tx,
						expected,
						result.byteLength,
						now,
					)
				) {
					return staleUnapplied(tx, deps, p);
				}
				safeEmit(deps.events, {
					type: "knowledge.document.current",
					level: "info",
					fields: { documentId: p.documentId, byteLength: result.byteLength },
				});
				return "applied";
			}
			if (!markDocumentUnavailableInTransaction(tx, expected, now)) {
				return staleUnapplied(tx, deps, p);
			}
			safeEmit(deps.events, {
				type: "knowledge.document.unavailable",
				level: "warn",
				fields: { documentId: p.documentId, reason: result.reason },
			});
			return "applied";
		},

		cancelInTransaction(tx, job) {
			// A late result is rejected by settle's re-check. The cancelled job's dedupe key stays
			// used in the host queue, so count the cancellation like a final failure: the next scan
			// can then queue this version again under a new key.
			const p = ingestDocumentPayloadSchema.safeParse(job.payload);
			if (!p.success) return;
			countUnappliedIngest(
				tx,
				deps,
				p.data,
				"knowledge.document.ingest_cancelled",
				"info",
			);
		},
	};
}
