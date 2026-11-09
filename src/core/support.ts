import {
	SourceError,
	type EventSink,
	type KnowledgeEvent,
} from "../contracts/index.js";
import {
	DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
	DEFAULT_ORPHAN_STAGING_AFTER_MS,
	DEFAULT_TRANSIENT_RETRY_DELAY_MS,
} from "../sqlite/defaults.js";

/** An event sink must never break a transaction. */
export function safeEmit(
	sink: EventSink | undefined,
	event: KnowledgeEvent,
): void {
	if (!sink) return;
	try {
		sink(event);
	} catch {
		// Logging failures are not the job's failures.
	}
}

/**
 * Unapplied ingest attempts of one version (counted only for failures the content caused)
 * before it is skipped (p2.md §3). One constant for the sync-page job, the ingest job and the
 * status read.
 */
export {
	DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
	DEFAULT_ORPHAN_STAGING_AFTER_MS,
	DEFAULT_TRANSIENT_RETRY_DELAY_MS,
};

/** Default of `IngestOptions.maxFragmentsPerDocument`. */
export const DEFAULT_MAX_FRAGMENTS_PER_DOCUMENT = 10_000;
/** Default of `IngestOptions.maxIndexedFragments` (p0.md 6.2). */
export const DEFAULT_MAX_INDEXED_FRAGMENTS = 50_000;

/**
 * Codes of failures that the content of a version causes: reading the same version again gives
 * the same result. Only these advance the retry counter (p2.md 3); every other way an ingest
 * ends without applying (any other code, a shutdown, an expiry, a cancel, a port failure) is
 * temporary and only delays the next pick. A fixed allow list of codes, no judgement of meaning.
 */
export const CONTENT_ERROR_CODES: readonly string[] = [
	"digest_mismatch",
	"document_too_large",
	"invalid_input",
	"document_mismatch",
	"contract_mismatch",
	// The source's answer for this document broke its contract (schema, digest, size, id).
	"invalid_response",
];

export function isContentErrorCode(code: string): boolean {
	return CONTENT_ERROR_CODES.includes(code);
}

/** A chain link that did not advance for this long is taken for lost; the next scan restarts it. */
export const CHAIN_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * An inference or embedding port threw or answered with a failure (not an abort). Such a failure comes from the provider or
 * the connection, never from the data, so another attempt is worth it. Carries no message: a
 * provider's text is not ours to pass on.
 */
export class PortFailure extends Error {
	override readonly name = "PortFailure";
	constructor(readonly port: "inference" | "embedding" | "tokenizer") {
		super(port);
	}
}

/** Only a source or a provider that is down or slow is worth another attempt. */
export function classifyJobError(error: unknown): "retry" | "fail" {
	if (error instanceof PortFailure) return "retry";
	if (
		error instanceof SourceError &&
		(error.code === "unavailable" || error.code === "timeout")
	) {
		return "retry";
	}
	return "fail";
}
