import type { DocumentSummary, Tx } from "../contracts/index.js";

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
	 * Monotonic counter of finally failed ingests (starting at 0). It is part of the ingest job's
	 * dedupe key, so the next scan can queue the same version again after a final failure.
	 */
	ingestRetry: number;
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
		// A stale document re-observed unchanged keeps its generation and asks again (the host
		// deduplicates by key), so a lost or failed ingest is retried by the next scan.
		needsIngest = true;
	}

	db.query(
		`UPDATE knowledge_documents SET
 namespace = ?, path = ?, title = ?, observed_etag = ?, observed_content_digest = ?,
 observed_markdown_sha256 = ?, state = ?, generation = ?, last_observed_at = ?,
 last_verified_at = ?, updated_at = ?
WHERE source_namespace = ? AND document_id = ?`,
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
		retry: row.ingestRetry,
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

/**
 * An ingest ended for good (failed, expired or interrupted) while the row still matched it:
 * advance the retry counter so the next scan queues the same version under a new key.
 * False (nothing written) when the row moved on.
 */
export function recordIngestFailureInTransaction(
	db: Tx,
	expected: IngestExpectation,
	now: number,
): boolean {
	const r = db
		.query(
			`UPDATE knowledge_documents SET ingest_retry = ingest_retry + 1, updated_at = ?
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
 * Withdraw a document from use (`excluded`: explicit exclusion, `removed`: a confirmed DELETE).
 * The generation advances unless the document is already in that state. False when no row.
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
 state = ?1, generation = generation + CASE WHEN state = ?1 THEN 0 ELSE 1 END, updated_at = ?2
WHERE source_namespace = ?3 AND document_id = ?4`,
		)
		.run(state, now, key.sourceNamespace, key.documentId);
	return r.changes === 1;
}
