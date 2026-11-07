import {
	KnowledgeError,
	type DocumentSummary,
	type Tx,
} from "../contracts/index.js";
import { MAX_TRANSIENT_RETRY_DELAY_MS } from "./defaults.js";

/** States the registry stores. `unverified` is derived when a read is made (p0.md §2.3). */
export type StoredDocumentState =
	"current" | "stale" | "unavailable" | "excluded" | "removed";

export type DocumentKey = { sourceNamespace: string; documentId: string };

export type DocumentRow = DocumentKey & {
	namespace: string;
	path: string;
	title: string;
	observedEtag: string;
	observedContentDigest: string;
	observedMarkdownSha256: string;
	appliedMarkdownSha256: string | null;
	appliedByteLength: number | null;
	state: StoredDocumentState;
	/** Invalidation generation, starting at 0 (p0.md §2.2). */
	generation: number;
	/**
	 * Unapplied ingest attempts of the observed version that the content caused (starting at 0;
	 * reset when a different version or another namespace is observed). It is part of the tuple an
	 * ingest is prepared against, and a version that reaches the ingest's attempt limit is skipped
	 * (p2.md §3). Temporary failures and superseded reads do not count here.
	 */
	ingestRetry: number;
	/** Not picked for ingest before this time (epoch ms) after a temporary failure; 0 = no wait. */
	ingestNotBefore: number;
	/** Consecutive temporary failures of the observed version; the wait doubles with it. */
	transientFailures: number;
	/**
	 * An ingest read another version or namespace at this time: not picked again until the
	 * document is observed again (`lastObservedAt` catches up). Null when not marked.
	 */
	supersededAt: number | null;
	/** The version reads use (`knowledge_versions`), null until one is published or after a withdrawal. */
	publishedVersionId: number | null;
	lastObservedAt: number;
	lastVerifiedAt: number | null;
	updatedAt: number;
};

type RawRow = {
	source_namespace: string;
	document_id: string;
	namespace: string;
	path: string;
	title: string;
	observed_etag: string;
	observed_content_digest: string;
	observed_markdown_sha256: string;
	applied_markdown_sha256: string | null;
	applied_byte_length: number | null;
	state: StoredDocumentState;
	generation: number;
	ingest_retry: number;
	ingest_not_before: number;
	transient_failures: number;
	superseded_at: number | null;
	published_version_id: number | null;
	last_observed_at: number;
	last_verified_at: number | null;
	updated_at: number;
};

export function getDocumentInTransaction(
	db: Tx,
	key: DocumentKey,
): DocumentRow | null {
	const r = db
		.query<RawRow>(
			"SELECT * FROM knowledge_documents WHERE source_namespace = ? AND document_id = ?",
		)
		.get(key.sourceNamespace, key.documentId);
	if (!r) return null;
	return {
		sourceNamespace: r.source_namespace,
		documentId: r.document_id,
		namespace: r.namespace,
		path: r.path,
		title: r.title,
		observedEtag: r.observed_etag,
		observedContentDigest: r.observed_content_digest,
		observedMarkdownSha256: r.observed_markdown_sha256,
		appliedMarkdownSha256: r.applied_markdown_sha256,
		appliedByteLength: r.applied_byte_length,
		state: r.state,
		generation: r.generation,
		ingestRetry: r.ingest_retry,
		ingestNotBefore: r.ingest_not_before,
		transientFailures: r.transient_failures,
		supersededAt: r.superseded_at,
		publishedVersionId: r.published_version_id,
		lastObservedAt: r.last_observed_at,
		lastVerifiedAt: r.last_verified_at,
		updatedAt: r.updated_at,
	};
}

export type ObservationResult = {
	/** The generation after this observation. */
	generation: number;
	/** The ingest retry counter to put in the job payload. */
	retry: number;
	/** The document waits for an ingest of the observed version at `generation`. */
	needsIngest: boolean;
	created: boolean;
};

/**
 * Record one listing entry (p1 registry rules). Only `markdownSha256` decides whether work is
 * needed: a changed etag, contentDigest, path, title or namespace alone updates metadata. A
 * document the listing does not mention is never touched by any call of this function.
 */
export function observeDocumentInTransaction(
	db: Tx,
	summary: DocumentSummary,
	allowedNamespaces: readonly string[],
	now: number,
): ObservationResult {
	const key = {
		sourceNamespace: summary.sourceNamespace,
		documentId: summary.documentId,
	};
	const row = getDocumentInTransaction(db, key);
	const allowed = allowedNamespaces.includes(summary.namespace);
	if (!row) {
		const state: StoredDocumentState = allowed ? "stale" : "unavailable";
		db.query(
			`INSERT INTO knowledge_documents (
 source_namespace, document_id, namespace, path, title, observed_etag, observed_content_digest,
 observed_markdown_sha256, applied_markdown_sha256, applied_byte_length, state, generation,
 last_observed_at, last_verified_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, NULL, ?)`,
		).run(
			key.sourceNamespace,
			key.documentId,
			summary.namespace,
			summary.path,
			summary.title,
			summary.etag,
			summary.contentDigest,
			summary.markdownSha256,
			state,
			now,
			now,
		);
		return { generation: 0, retry: 0, needsIngest: allowed, created: true };
	}

	const sha = summary.markdownSha256;
	let state = row.state;
	let generation = row.generation;
	let verified = row.lastVerifiedAt;
	let needsIngest = false;

	if (state === "excluded" || state === "removed") {
		// Metadata only: no state change, no job.
	} else if (!allowed) {
		if (state !== "unavailable") {
			state = "unavailable";
			generation += 1;
		}
	} else if (state === "unavailable") {
		generation += 1;
		if (row.appliedMarkdownSha256 === sha) {
			state = "current";
			verified = now;
		} else {
			state = "stale";
			needsIngest = true;
		}
	} else if (row.appliedMarkdownSha256 === sha) {
		if (state === "stale") {
			// The source went back to the applied version: invalidate the pending ingest.
			state = "current";
			generation += 1;
		}
		verified = now;
	} else {
		if (state === "current" || row.observedMarkdownSha256 !== sha) {
			state = "stale";
			generation += 1;
		}
		// A stale document re-observed unchanged keeps its generation and still waits, so a lost
		// or failed ingest is picked up again by the chain the next scan restarts.
		needsIngest = true;
	}

	db.query(
		`UPDATE knowledge_documents SET
 namespace = ?1, path = ?2, title = ?3, observed_etag = ?4, observed_content_digest = ?5,
 ingest_retry = CASE WHEN observed_markdown_sha256 = ?6 AND namespace = ?1 THEN ingest_retry ELSE 0 END,
 ingest_not_before = CASE WHEN observed_markdown_sha256 = ?6 AND namespace = ?1 THEN ingest_not_before ELSE 0 END,
 transient_failures = CASE WHEN observed_markdown_sha256 = ?6 AND namespace = ?1 THEN transient_failures ELSE 0 END,
 superseded_at = NULL,
 observed_markdown_sha256 = ?6, state = ?7, generation = ?8, last_observed_at = ?9,
 last_verified_at = ?10, updated_at = ?11
WHERE source_namespace = ?12 AND document_id = ?13`,
	).run(
		summary.namespace,
		summary.path,
		summary.title,
		summary.etag,
		summary.contentDigest,
		sha,
		state,
		generation,
		now,
		verified,
		now,
		key.sourceNamespace,
		key.documentId,
	);
	return {
		generation,
		// A new version, or the same one in another namespace, starts counting from zero.
		retry:
			row.observedMarkdownSha256 === sha && row.namespace === summary.namespace
				? row.ingestRetry
				: 0,
		needsIngest,
		created: false,
	};
}

/** What an ingest was prepared against; every field must still match when its result is applied. */
export type IngestExpectation = DocumentKey & {
	generation: number;
	retry: number;
	markdownSha256: string;
	/** The namespace the version was observed in. */
	namespace: string;
};

/** Record a verified version as applied. False (nothing written) when the row moved on. */
export function applyIngestedVersionInTransaction(
	db: Tx,
	expected: IngestExpectation,
	byteLength: number,
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET
 applied_markdown_sha256 = ?, applied_byte_length = ?, state = 'current',
 ingest_not_before = 0, transient_failures = 0, superseded_at = NULL,
 last_verified_at = ?, updated_at = ?
WHERE source_namespace = ? AND document_id = ? AND state = 'stale' AND generation = ?
 AND ingest_retry = ? AND observed_markdown_sha256 = ? AND namespace = ?`,
		)
		.run(
			expected.markdownSha256,
			byteLength,
			now,
			now,
			expected.sourceNamespace,
			expected.documentId,
			expected.generation,
			expected.retry,
			expected.markdownSha256,
			expected.namespace,
		);
	return r.changes === 1;
}

/** A 404/403 on read: the document becomes unavailable (never removed) and the generation advances. */
export function markDocumentUnavailableInTransaction(
	db: Tx,
	expected: IngestExpectation,
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET
 state = 'unavailable', generation = generation + 1, updated_at = ?
WHERE source_namespace = ? AND document_id = ? AND state = 'stale' AND generation = ?
 AND ingest_retry = ? AND observed_markdown_sha256 = ? AND namespace = ?`,
		)
		.run(
			now,
			expected.sourceNamespace,
			expected.documentId,
			expected.generation,
			expected.retry,
			expected.markdownSha256,
			expected.namespace,
		);
	return r.changes === 1;
}

/**
 * The source reported its allowed namespaces (every listing page carries them): documents
 * registered in any other namespace become unavailable and their generation advances
 * (p0.md §2.3). This is a permission change stated by the source, not a deletion inferred from
 * absence. `excluded`, `removed` and already `unavailable` documents are left alone. Returns the
 * number of documents changed.
 */
export function markOutsideNamespacesUnavailableInTransaction(
	db: Tx,
	sourceNamespace: string,
	allowedNamespaces: readonly string[],
	now: number,
): number {
	const r = db
		.query(
			`UPDATE knowledge_documents SET
 state = 'unavailable', generation = generation + 1, updated_at = ?
WHERE source_namespace = ? AND state IN ('current', 'stale')
 AND namespace NOT IN (SELECT value FROM json_each(?))`,
		)
		.run(now, sourceNamespace, JSON.stringify(allowedNamespaces));
	return r.changes;
}

const TUPLE_MATCH = `source_namespace = ? AND document_id = ? AND state = 'stale' AND generation = ?
 AND ingest_retry = ? AND observed_markdown_sha256 = ? AND namespace = ?`;

const tupleParams = (e: IngestExpectation) =>
	[
		e.sourceNamespace,
		e.documentId,
		e.generation,
		e.retry,
		e.markdownSha256,
		e.namespace,
	] as const;

/**
 * An ingest ended without applying anything for a reason the content caused (digest, size,
 * contract): the same version read again gives the same result. Advance the retry counter; at
 * the ingest's limit the version is skipped until it changes. False (nothing written) when the
 * row moved on. Temporary failures use `recordTransientIngestFailureInTransaction` instead.
 */
export function recordIngestFailureInTransaction(
	db: Tx,
	expected: IngestExpectation,
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET ingest_retry = ingest_retry + 1, updated_at = ?
WHERE ${TUPLE_MATCH}`,
		)
		.run(now, ...tupleParams(expected));
	return r.changes === 1;
}

/**
 * An ingest ended without applying anything for a temporary reason (a port failure, a shutdown,
 * a restart, a deadline, a cancel). Nothing is counted against the version; instead the document
 * is not picked before `now + delay`, where the delay is `baseDelayMs` doubled for each earlier
 * consecutive temporary failure, at most `MAX_TRANSIENT_RETRY_DELAY_MS` (a larger base wins).
 * False (nothing written) when the row moved on.
 */
export function recordTransientIngestFailureInTransaction(
	db: Tx,
	expected: IngestExpectation,
	now: number,
	baseDelayMs: number,
): boolean {
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(baseDelayMs) ||
		baseDelayMs < 0
	) {
		throw new KnowledgeError("invalid_input");
	}
	const row = db
		.query<{ transient_failures: number }>(
			`SELECT transient_failures FROM knowledge_documents WHERE ${TUPLE_MATCH}`,
		)
		.get(...tupleParams(expected));
	if (!row) return false;
	const delay = Math.min(
		baseDelayMs * 2 ** Math.min(row.transient_failures, 30),
		Math.max(baseDelayMs, MAX_TRANSIENT_RETRY_DELAY_MS),
	);
	const r = db
		.query(
			`UPDATE knowledge_documents SET transient_failures = transient_failures + 1,
 ingest_not_before = ?, updated_at = ?
WHERE ${TUPLE_MATCH}`,
		)
		.run(Math.floor(now + delay), now, ...tupleParams(expected));
	return r.changes === 1;
}

/**
 * An ingest read another version (another sha or namespace) than the one it was prepared for.
 * Nothing is counted; the document is not picked again until it is observed again (the next
 * scan). False (nothing written) when the row moved on.
 */
export function markIngestSupersededInTransaction(
	db: Tx,
	expected: IngestExpectation,
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET superseded_at = ?, updated_at = ?
WHERE ${TUPLE_MATCH}`,
		)
		.run(now, now, ...tupleParams(expected));
	return r.changes === 1;
}

/**
 * The operator's reset: the retry counter, the temporary-failure count, the wait and the
 * superseded mark go back to zero, for one document or (without `key`) for every document that
 * has any of them. An ingest prepared before the reset no longer matches its tuple and is not
 * applied. Returns the number of documents changed.
 */
export function resetIngestFailuresInTransaction(
	db: Tx,
	key?: DocumentKey,
): number {
	const where =
		key === undefined ? "" : "source_namespace = ?1 AND document_id = ?2 AND";
	const params = key === undefined ? [] : [key.sourceNamespace, key.documentId];
	return db
		.query(
			`UPDATE knowledge_documents SET ingest_retry = 0, ingest_not_before = 0,
 transient_failures = 0, superseded_at = NULL
WHERE ${where} (ingest_retry <> 0 OR ingest_not_before <> 0 OR transient_failures <> 0 OR superseded_at IS NOT NULL)`,
		)
		.run(...params).changes;
}

/**
 * Withdraw a document from use (`excluded`: explicit exclusion, `removed`: a confirmed DELETE).
 * The generation advances unless the document is already in that state. The published version
 * becomes `retired` (its rows are removed by the cleanup) and staging versions are abandoned.
 * (`unavailable` keeps the published version: that is not a confirmed deletion.)
 * False when no row.
 */
export function retireDocumentInTransaction(
	db: Tx,
	key: DocumentKey,
	state: "excluded" | "removed",
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET
 state = ?1, generation = generation + CASE WHEN state = ?1 THEN 0 ELSE 1 END,
 published_version_id = NULL, updated_at = ?2
WHERE source_namespace = ?3 AND document_id = ?4`,
		)
		.run(state, now, key.sourceNamespace, key.documentId);
	if (r.changes !== 1) return false;
	db.query(
		`UPDATE knowledge_versions SET state = 'retired', retired_at = ?
WHERE source_namespace = ? AND document_id = ? AND state = 'published'`,
	).run(now, key.sourceNamespace, key.documentId);
	db.query(
		`UPDATE knowledge_versions SET state = 'abandoned', retired_at = ?
WHERE source_namespace = ? AND document_id = ? AND state = 'staging'`,
	).run(now, key.sourceNamespace, key.documentId);
	return true;
}
