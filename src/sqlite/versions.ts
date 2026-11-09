import { createHash } from "node:crypto";
import {
	EXTRACTION_LIMITS,
	KnowledgeError,
	embeddingSpaceKey,
	type EmbeddingSpace,
	type EvidenceRange,
	type Fragment,
	type FragmentExtraction,
	type Tx,
} from "../contracts/index.js";
import {
	applyIngestedVersionInTransaction,
	type DocumentKey,
	type IngestExpectation,
} from "./documents.js";
import { DEFAULT_ORPHAN_STAGING_AFTER_MS } from "./defaults.js";
import {
	deleteLinkRowsInTransaction,
	hasLinkRowsInTransaction,
} from "./links.js";
import { pruneScansInTransaction } from "./scans.js";

/**
 * Index versions (p2.md §5). A version is `(document, markdownSha256, ingest attempt)`. Its
 * fragments, full-text rows, vectors, extractions, mentions and evidence all carry its
 * `version_id`; a document reads only its `published_version_id`.
 *
 * Every function is synchronous and runs against the host's connection inside the host's
 * transaction. Malformed arguments throw `KnowledgeError("invalid_input")` before anything is
 * written; writing to a version that is not `staging` throws `KnowledgeError("not_available")`.
 * A thrown error means the host rolls the whole call back.
 */

export type VersionState = "staging" | "published" | "retired" | "abandoned";

export type VersionRow = DocumentKey & {
	versionId: number;
	markdownSha256: string;
	generation: number;
	ingestRetry: number;
	namespace: string;
	byteLength: number;
	state: VersionState;
	expectedFragments: number;
	fragmentsWritten: number;
	vectorsWritten: number;
	extractionsWritten: number;
	/** The vector space of the version, null until vectors were staged. */
	spaceKey: string | null;
	instructionDigest: string;
	/** At least one fragment's extraction failed. Set when the version is published. */
	extractionPartial: boolean;
	createdAt: number;
	publishedAt: number | null;
	/** When the version was retired or abandoned. */
	retiredAt: number | null;
};

type RawVersion = {
	version_id: number;
	source_namespace: string;
	document_id: string;
	markdown_sha256: string;
	generation: number;
	ingest_retry: number;
	namespace: string;
	byte_length: number;
	state: VersionState;
	expected_fragments: number;
	fragments_written: number;
	vectors_written: number;
	extractions_written: number;
	space_key: string | null;
	instruction_digest: string;
	extraction_partial: number;
	created_at: number;
	published_at: number | null;
	retired_at: number | null;
};

export function toVersionRow(r: RawVersion): VersionRow {
	return {
		versionId: r.version_id,
		sourceNamespace: r.source_namespace,
		documentId: r.document_id,
		markdownSha256: r.markdown_sha256,
		generation: r.generation,
		ingestRetry: r.ingest_retry,
		namespace: r.namespace,
		byteLength: r.byte_length,
		state: r.state,
		expectedFragments: r.expected_fragments,
		fragmentsWritten: r.fragments_written,
		vectorsWritten: r.vectors_written,
		extractionsWritten: r.extractions_written,
		spaceKey: r.space_key,
		instructionDigest: r.instruction_digest,
		extractionPartial: r.extraction_partial === 1,
		createdAt: r.created_at,
		publishedAt: r.published_at,
		retiredAt: r.retired_at,
	};
}

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};
const gone = (): never => {
	throw new KnowledgeError("not_available");
};
const isCount = (n: unknown): n is number =>
	typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isSha = (s: unknown): s is string =>
	typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const isText = (s: unknown): s is string =>
	typeof s === "string" && s.length > 0;
const sha256 = (data: string | Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

export function getVersionInTransaction(
	db: Tx,
	versionId: number,
): VersionRow | null {
	const r = db
		.query<RawVersion>("SELECT * FROM knowledge_versions WHERE version_id = ?")
		.get(versionId);
	return r ? toVersionRow(r) : null;
}

function requireStaging(db: Tx, versionId: number): VersionRow {
	if (!Number.isSafeInteger(versionId)) return invalid();
	const v = getVersionInTransaction(db, versionId);
	if (!v || v.state !== "staging") return gone();
	return v;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** What a staging version is created for (the ingest's prepared tuple plus what was measured). */
export type StagingTicket = IngestExpectation & {
	/** UTF-8 byte length of the Markdown body. */
	byteLength: number;
	expectedFragments: number;
	/** Digest of the instruction set used for the extraction. */
	instructionDigest: string;
};

/**
 * Create a `staging` version for a registered document and abandon every older `staging`
 * version of the same document. Returns the new version id (never reused). Throws
 * `not_available` when the document is not registered.
 */
export function createStagingVersionInTransaction(
	db: Tx,
	ticket: StagingTicket,
	now: number,
): number {
	if (
		!isText(ticket.sourceNamespace) ||
		!isText(ticket.documentId) ||
		!isSha(ticket.markdownSha256) ||
		!isCount(ticket.generation) ||
		!isCount(ticket.retry) ||
		!isText(ticket.namespace) ||
		!isCount(ticket.byteLength) ||
		!isCount(ticket.expectedFragments) ||
		!isText(ticket.instructionDigest) ||
		!Number.isFinite(now)
	) {
		return invalid();
	}
	const doc = db
		.query(
			"SELECT 1 AS x FROM knowledge_documents WHERE source_namespace = ? AND document_id = ?",
		)
		.get(ticket.sourceNamespace, ticket.documentId);
	if (!doc) return gone();
	abandonStagingOfDocument(db, ticket, now);
	const r = db
		.query(
			`INSERT INTO knowledge_versions (
 source_namespace, document_id, markdown_sha256, generation, ingest_retry, namespace,
 byte_length, state, expected_fragments, instruction_digest, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?)`,
		)
		.run(
			ticket.sourceNamespace,
			ticket.documentId,
			ticket.markdownSha256,
			ticket.generation,
			ticket.retry,
			ticket.namespace,
			ticket.byteLength,
			ticket.expectedFragments,
			ticket.instructionDigest,
			now,
		);
	return Number(r.lastInsertRowid);
}

function abandonStagingOfDocument(db: Tx, key: DocumentKey, now: number): void {
	db.query(
		`UPDATE knowledge_versions SET state = 'abandoned', retired_at = ?
WHERE source_namespace = ? AND document_id = ? AND state = 'staging'`,
	).run(now, key.sourceNamespace, key.documentId);
}

export type FragmentToStage = {
	fragment: Fragment;
	/** Normalized text for the full-text index (NFKC + lowercase, done by the caller). */
	searchText: string;
};

/**
 * Add fragments to a staging version and index their search text. `ordinal` is in
 * `[0, expectedFragments)`, unique within the version, and the byte range matches the UTF-8
 * length of `text`. Throws `not_available` unless the version is `staging`.
 */
export function stageFragmentsInTransaction(
	db: Tx,
	versionId: number,
	items: readonly FragmentToStage[],
): void {
	const v = requireStaging(db, versionId);
	const seen = new Set<number>();
	const prepared = items.map(({ fragment: f, searchText }) => {
		if (
			!isCount(f.ordinal) ||
			f.ordinal >= v.expectedFragments ||
			seen.has(f.ordinal) ||
			!isCount(f.byteStart) ||
			!isCount(f.byteEnd) ||
			f.byteEnd <= f.byteStart ||
			!Array.isArray(f.headingPath) ||
			f.headingPath.some((h) => typeof h !== "string") ||
			typeof f.text !== "string" ||
			typeof searchText !== "string" ||
			utf8Length(f.text) !== f.byteEnd - f.byteStart
		) {
			return invalid();
		}
		seen.add(f.ordinal);
		return { f, searchText };
	});
	if (v.fragmentsWritten + prepared.length > v.expectedFragments) {
		return invalid();
	}
	const insert = db.query(
		`INSERT INTO knowledge_fragments (
 version_id, ordinal, byte_start, byte_end, heading_path, text, text_sha256
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const index = db.query(
		"INSERT INTO knowledge_fragment_fts (rowid, search_text, version_id, ordinal) VALUES (?, ?, ?, ?)",
	);
	for (const { f, searchText } of prepared) {
		const r = insert.run(
			versionId,
			f.ordinal,
			f.byteStart,
			f.byteEnd,
			JSON.stringify(f.headingPath),
			f.text,
			sha256(f.text),
		);
		index.run(r.lastInsertRowid, searchText, versionId, f.ordinal);
	}
	db.query(
		"UPDATE knowledge_versions SET fragments_written = fragments_written + ? WHERE version_id = ?",
	).run(prepared.length, versionId);
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** float32 little-endian bytes of `values`; null when a value is not finite as a float32. */
export function encodeVector(values: ArrayLike<number>): Uint8Array | null {
	const f = new Float32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		const x = values[i];
		if (typeof x !== "number" || !Number.isFinite(x)) return null;
		f[i] = x;
		if (!Number.isFinite(f[i]!)) return null;
	}
	if (LITTLE_ENDIAN) return new Uint8Array(f.buffer);
	const out = new Uint8Array(f.length * 4);
	const view = new DataView(out.buffer);
	for (let i = 0; i < f.length; i++) view.setFloat32(i * 4, f[i]!, true);
	return out;
}

/** The inverse of `encodeVector`; a copy, never a view of the row's buffer. */
export function decodeVector(blob: Uint8Array): Float32Array {
	const n = blob.byteLength / 4;
	if (!Number.isInteger(n)) return invalid();
	const copy = new Uint8Array(blob.byteLength);
	copy.set(blob);
	if (LITTLE_ENDIAN) return new Float32Array(copy.buffer);
	const out = new Float32Array(n);
	const view = new DataView(copy.buffer);
	for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
	return out;
}

function checkSpace(space: EmbeddingSpace): void {
	if (
		typeof space !== "object" ||
		space === null ||
		!isText(space.modelId) ||
		typeof space.revision !== "string" ||
		typeof space.artifactDigest !== "string" ||
		typeof space.queryPrefix !== "string" ||
		typeof space.passagePrefix !== "string" ||
		typeof space.dimension !== "number" ||
		!Number.isSafeInteger(space.dimension) ||
		space.dimension <= 0
	) {
		invalid();
	}
}

/**
 * Add one embedding per fragment to a staging version. The first call fixes the version's
 * space; a different space later throws `invalid_input`, as do a vector whose length differs
 * from `space.dimension` and any value that is not finite as a float32.
 */
export function stageVectorsInTransaction(
	db: Tx,
	versionId: number,
	space: EmbeddingSpace,
	items: readonly { ordinal: number; vector: ArrayLike<number> }[],
): void {
	const v = requireStaging(db, versionId);
	checkSpace(space);
	const key = embeddingSpaceKey(space);
	if (v.spaceKey !== null && v.spaceKey !== key) return invalid();
	const seen = new Set<number>();
	const prepared = items.map((item) => {
		if (
			!isCount(item.ordinal) ||
			item.ordinal >= v.expectedFragments ||
			seen.has(item.ordinal) ||
			item.vector.length !== space.dimension
		) {
			return invalid();
		}
		seen.add(item.ordinal);
		const blob = encodeVector(item.vector);
		if (!blob) return invalid();
		return { ordinal: item.ordinal, blob };
	});
	if (v.vectorsWritten + prepared.length > v.expectedFragments) {
		return invalid();
	}
	db.query(
		`INSERT OR IGNORE INTO knowledge_embedding_spaces (
 space_key, model_id, revision, artifact_digest, dimension, query_prefix, passage_prefix
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		key,
		space.modelId,
		space.revision,
		space.artifactDigest,
		space.dimension,
		space.queryPrefix,
		space.passagePrefix,
	);
	const insert = db.query(
		"INSERT INTO knowledge_vectors (space_key, version_id, ordinal, dimension, vector) VALUES (?, ?, ?, ?, ?)",
	);
	for (const p of prepared) {
		insert.run(key, versionId, p.ordinal, space.dimension, p.blob);
	}
	db.query(
		"UPDATE knowledge_versions SET space_key = ?, vectors_written = vectors_written + ? WHERE version_id = ?",
	).run(key, prepared.length, versionId);
}

/**
 * The index text of a mention: its fields joined by a line break, NFKC then lower case (the
 * rule `normalizeForSearch` of `src/core/text` states; this module imports no core).
 */
function mentionSearchText(fields: readonly string[]): string {
	return fields.join("\n").normalize("NFKC").toLowerCase();
}

function checkEvidence(e: EvidenceRange, ordinal: number): void {
	if (
		e.fragmentOrdinal !== ordinal ||
		!isCount(e.byteStart) ||
		!isCount(e.byteEnd) ||
		e.byteEnd <= e.byteStart ||
		!isSha(e.quoteSha256) ||
		typeof e.ambiguous !== "boolean"
	) {
		invalid();
	}
}

function checkExtraction(x: FragmentExtraction, expected: number): void {
	if (!isCount(x.fragmentOrdinal) || x.fragmentOrdinal >= expected) {
		return invalid();
	}
	if (x.model !== null && typeof x.model !== "string") return invalid();
	if (x.status === "failed") {
		if (!isText(x.errorCode)) invalid();
		return;
	}
	if (x.status !== "ok") return invalid();
	const entityIds = new Set<string>();
	for (const e of x.entities) {
		if (entityIds.has(e.id) || e.evidence.length === 0) return invalid();
		if (
			e.key !== undefined &&
			(typeof e.key !== "string" ||
				e.key.length === 0 ||
				e.key.length > EXTRACTION_LIMITS.keyChars)
		)
			return invalid();
		entityIds.add(e.id);
		for (const ev of e.evidence) checkEvidence(ev, x.fragmentOrdinal);
	}
	const relationIds = new Set<string>();
	for (const r of x.relations) {
		if (
			relationIds.has(r.id) ||
			!entityIds.has(r.source) ||
			!entityIds.has(r.target) ||
			r.evidence.length === 0
		) {
			return invalid();
		}
		relationIds.add(r.id);
		for (const ev of r.evidence) checkEvidence(ev, x.fragmentOrdinal);
	}
	for (const d of x.dropped) {
		if (!isCount(d.count) || !isText(d.reason)) return invalid();
	}
}

/**
 * Add the checked extraction of fragments to a staging version: one row per fragment (`ok` or
 * `failed`), and for `ok` the entity and relation mentions with their evidence ranges. Evidence
 * must name the fragment it belongs to and lie inside that fragment's `[byteStart, byteEnd]`
 * (a range of the whole body), so the fragment must be staged first; relations must name
 * entities of the same fragment.
 */
export function stageExtractionsInTransaction(
	db: Tx,
	versionId: number,
	items: readonly FragmentExtraction[],
): void {
	const v = requireStaging(db, versionId);
	const seen = new Set<number>();
	for (const x of items) {
		checkExtraction(x, v.expectedFragments);
		if (seen.has(x.fragmentOrdinal)) return invalid();
		seen.add(x.fragmentOrdinal);
	}
	if (v.extractionsWritten + items.length > v.expectedFragments) {
		return invalid();
	}
	// Evidence is a range of the whole body and must lie inside the fragment it names.
	const fragmentRange = db.query<{ byte_start: number; byte_end: number }>(
		"SELECT byte_start, byte_end FROM knowledge_fragments WHERE version_id = ? AND ordinal = ?",
	);
	for (const x of items) {
		if (x.status !== "ok") continue;
		const range = fragmentRange.get(versionId, x.fragmentOrdinal);
		if (!range) return invalid();
		for (const e of [...x.entities, ...x.relations]) {
			for (const ev of e.evidence) {
				if (ev.byteStart < range.byte_start || ev.byteEnd > range.byte_end) {
					return invalid();
				}
			}
		}
	}
	const insertExtraction = db.query(
		`INSERT INTO knowledge_extractions (
 version_id, ordinal, status, error_code, model, dropped_count, dropped_json
) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertEntity = db.query(
		`INSERT INTO knowledge_entity_mentions (
 version_id, fragment_ordinal, local_id, name, type, description, name_norm, name_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertRelation = db.query(
		`INSERT INTO knowledge_relation_mentions (
 version_id, fragment_ordinal, local_id, source_local_id, target_local_id, directed, relation,
 description, keywords_json, qualifier_negated, qualifier_condition, qualifier_certainty
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const indexEntity = db.query(
		"INSERT INTO knowledge_entity_fts (rowid, search_text) VALUES (?, ?)",
	);
	const indexRelation = db.query(
		"INSERT INTO knowledge_relation_fts (rowid, search_text) VALUES (?, ?)",
	);
	const insertEvidence = db.query(
		`INSERT INTO knowledge_evidence (
 version_id, subject_kind, subject_id, position, fragment_ordinal, byte_start, byte_end,
 quote_sha256, ambiguous
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const evidence = (
		kind: "entity" | "relation",
		subjectId: number,
		ranges: readonly EvidenceRange[],
	) => {
		ranges.forEach((e, position) => {
			insertEvidence.run(
				versionId,
				kind,
				subjectId,
				position,
				e.fragmentOrdinal,
				e.byteStart,
				e.byteEnd,
				e.quoteSha256,
				e.ambiguous ? 1 : 0,
			);
		});
	};
	for (const x of items) {
		if (x.status === "failed") {
			insertExtraction.run(
				versionId,
				x.fragmentOrdinal,
				"failed",
				x.errorCode,
				x.model,
				0,
				"[]",
			);
			continue;
		}
		insertExtraction.run(
			versionId,
			x.fragmentOrdinal,
			"ok",
			null,
			x.model,
			x.dropped.reduce((n, d) => n + d.count, 0),
			JSON.stringify(x.dropped),
		);
		for (const e of x.entities) {
			const r = insertEntity.run(
				versionId,
				x.fragmentOrdinal,
				e.id,
				e.name,
				e.type,
				e.description,
				mentionSearchText([e.name]),
				e.key ?? "",
			);
			// A model-free mention (it has a key) is indexed by its name alone: its type is one of two
			// fixed words and its description is empty, so they would match every mention.
			indexEntity.run(
				r.lastInsertRowid,
				mentionSearchText(
					e.key !== undefined ? [e.name] : [e.name, e.type, e.description],
				),
			);
			evidence("entity", Number(r.lastInsertRowid), e.evidence);
		}
		const keyed = new Set(
			x.entities.filter((e) => e.key !== undefined).map((e) => e.id),
		);
		for (const rel of x.relations) {
			const r = insertRelation.run(
				versionId,
				x.fragmentOrdinal,
				rel.id,
				rel.source,
				rel.target,
				rel.directed ? 1 : 0,
				rel.relation,
				rel.description,
				JSON.stringify(rel.keywords),
				rel.qualifiers.negated ? 1 : 0,
				rel.qualifiers.condition,
				rel.qualifiers.certainty,
			);
			// A relation between two model-free mentions (same sentence, kg2.md §3.1) names nothing
			// but the fixed word 同じ文: it is not indexed (the search's relation route skips it).
			if (!(keyed.has(rel.source) && keyed.has(rel.target)))
				indexRelation.run(
					r.lastInsertRowid,
					mentionSearchText([rel.relation, rel.description, ...rel.keywords]),
				);
			evidence("relation", Number(r.lastInsertRowid), rel.evidence);
		}
	}
	db.query(
		"UPDATE knowledge_versions SET extractions_written = extractions_written + ? WHERE version_id = ?",
	).run(items.length, versionId);
}

// ---------------------------------------------------------------------------
// Publish, abandon, retire
// ---------------------------------------------------------------------------

/**
 * Switch the document to a staged version. Writes nothing and returns false unless all hold:
 * the document row is `stale` and still matches `expectation` (generation, retry, observed
 * sha, namespace); the version is `staging` and was created for exactly that tuple; fragments,
 * vectors and extractions were all written in the expected number. Then, in this call: the
 * document becomes `current` with the version as `published_version_id` (the registry columns
 * are those of `applyIngestedVersionInTransaction`), the previous published version becomes
 * `retired`, and `extraction_partial` records whether any fragment's extraction failed.
 */
export function publishVersionInTransaction(
	db: Tx,
	versionId: number,
	expectation: IngestExpectation,
	now: number,
): boolean {
	const v = getVersionInTransaction(db, versionId);
	if (
		!v ||
		v.state !== "staging" ||
		v.sourceNamespace !== expectation.sourceNamespace ||
		v.documentId !== expectation.documentId ||
		v.markdownSha256 !== expectation.markdownSha256 ||
		v.generation !== expectation.generation ||
		v.ingestRetry !== expectation.retry ||
		v.namespace !== expectation.namespace ||
		v.fragmentsWritten !== v.expectedFragments ||
		v.vectorsWritten !== v.expectedFragments ||
		v.extractionsWritten !== v.expectedFragments
	) {
		return false;
	}
	const previous = db
		.query<{ published_version_id: number | null }>(
			"SELECT published_version_id FROM knowledge_documents WHERE source_namespace = ? AND document_id = ?",
		)
		.get(v.sourceNamespace, v.documentId)?.published_version_id;
	if (!applyIngestedVersionInTransaction(db, expectation, v.byteLength, now)) {
		return false;
	}
	db.query(
		"UPDATE knowledge_documents SET published_version_id = ? WHERE source_namespace = ? AND document_id = ?",
	).run(versionId, v.sourceNamespace, v.documentId);
	if (previous !== null && previous !== undefined && previous !== versionId) {
		db.query(
			"UPDATE knowledge_versions SET state = 'retired', retired_at = ? WHERE version_id = ? AND state = 'published'",
		).run(now, previous);
	}
	db.query(
		`UPDATE knowledge_versions SET state = 'published', published_at = ?2,
 extraction_partial = EXISTS (SELECT 1 FROM knowledge_extractions WHERE version_id = ?1 AND status = 'failed')
WHERE version_id = ?1`,
	).run(versionId, now);
	return true;
}

/**
 * Give up a staging version (cancelled, expired, stale, superseded). Returns false (nothing
 * written) when the version is not `staging`. Its rows are removed by `cleanupInTransaction`.
 */
export function abandonVersionInTransaction(
	db: Tx,
	versionId: number,
	now: number | null = null,
): boolean {
	return (
		db
			.query(
				"UPDATE knowledge_versions SET state = 'abandoned', retired_at = ? WHERE version_id = ? AND state = 'staging'",
			)
			.run(now, versionId).changes === 1
	);
}

/**
 * Give up every `staging` version created for exactly this tuple (an ingest that ended without
 * publishing: failed, expired, interrupted or cancelled). Returns how many versions it abandoned.
 */
export function discardStagingInTransaction(
	db: Tx,
	expectation: IngestExpectation,
	now: number,
): number {
	return db
		.query(
			`UPDATE knowledge_versions SET state = 'abandoned', retired_at = ?
WHERE source_namespace = ? AND document_id = ? AND markdown_sha256 = ? AND generation = ?
 AND ingest_retry = ? AND namespace = ? AND state = 'staging'`,
		)
		.run(
			now,
			expectation.sourceNamespace,
			expectation.documentId,
			expectation.markdownSha256,
			expectation.generation,
			expectation.retry,
			expectation.namespace,
		).changes;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Derived tables keyed by `version_id`, children first. `fts` names the full-text table whose
 * rowid is the row's id: those rows go first (see `deleteIndexed`).
 */
const DERIVED_STEPS: readonly {
	table: string;
	index?: { idColumn: string; fts: string };
}[] = [
	{ table: "knowledge_evidence" },
	{
		table: "knowledge_relation_mentions",
		index: { idColumn: "relation_id", fts: "knowledge_relation_fts" },
	},
	{
		table: "knowledge_entity_mentions",
		index: { idColumn: "entity_id", fts: "knowledge_entity_fts" },
	},
	{ table: "knowledge_extractions" },
	{ table: "knowledge_vectors" },
	{
		table: "knowledge_fragments",
		index: { idColumn: "fragment_id", fts: "knowledge_fragment_fts" },
	},
];

export function hasCleanupInTransaction(db: Tx): boolean {
	return (
		db
			.query(
				"SELECT 1 AS x FROM knowledge_versions WHERE state IN ('retired', 'abandoned') LIMIT 1",
			)
			.get() !== null
	);
}

/**
 * Fragments the published versions hold, not counting the published version of `excluding` (a
 * document being re-ingested: its old version retires when the new one is published).
 */
export function countPublishedFragmentsInTransaction(
	db: Tx,
	excluding?: DocumentKey,
): number {
	return (
		db
			.query<{ n: number }>(
				`SELECT COALESCE(SUM(expected_fragments), 0) AS n FROM knowledge_versions
WHERE state = 'published'
 AND (?1 IS NULL OR NOT (source_namespace = ?1 AND document_id = ?2))`,
			)
			.get(excluding?.sourceNamespace ?? null, excluding?.documentId ?? null)
			?.n ?? 0
	);
}

/**
 * Housekeeping in one bounded step, `maxRows` rows at most:
 * - A `staging` version created `orphanStagingAfterMs` (default 6 hours) before `now` or earlier
 *   is abandoned, unless it is the version the open chain link is working on and the chain
 *   advanced within that time. (State changes of versions are not counted as rows.)
 * - The derived rows of `retired` and `abandoned` versions are deleted (an index row and a
 *   version row count as rows too; `maxRows >= 1`). A version row is deleted last, once nothing
 *   derived is left. Published and staging versions are never touched.
 * - With the budget left, finished scans past their retention are deleted (see
 *   `pruneScansInTransaction`).
 * `more` tells whether any retired or abandoned version or any prunable scan remains.
 */
export function cleanupInTransaction(
	db: Tx,
	maxRows: number,
	options: { now: number; orphanStagingAfterMs?: number },
): { deletedRows: number; more: boolean } {
	if (
		!Number.isSafeInteger(maxRows) ||
		maxRows < 1 ||
		!Number.isFinite(options.now)
	) {
		return invalid();
	}
	abandonOrphanStaging(
		db,
		options.now,
		options.orphanStagingAfterMs ?? DEFAULT_ORPHAN_STAGING_AFTER_MS,
	);
	let remaining = maxRows;
	const versions = db
		.query<{ version_id: number }>(
			"SELECT version_id FROM knowledge_versions WHERE state IN ('retired', 'abandoned') ORDER BY version_id LIMIT ?",
		)
		.all(maxRows);
	for (const { version_id: id } of versions) {
		if (remaining <= 0) break;
		// Links, comparison marks and summaries that name this version's mentions go first, so
		// none of them outlives the mentions (p3.md 8).
		remaining -= deleteLinkRowsInTransaction(db, id, remaining);
		for (const step of DERIVED_STEPS) {
			if (remaining <= 0) break;
			remaining -= step.index
				? deleteIndexed(db, id, step.table, step.index, remaining)
				: db
						.query(
							`DELETE FROM ${step.table} WHERE rowid IN (SELECT rowid FROM ${step.table} WHERE version_id = ? LIMIT ?)`,
						)
						.run(id, remaining).changes;
		}
		if (remaining > 0 && !hasDerivedRows(db, id)) {
			remaining -= db
				.query(
					"DELETE FROM knowledge_versions WHERE version_id = ? AND state IN ('retired', 'abandoned')",
				)
				.run(id).changes;
		}
	}
	let more = hasCleanupInTransaction(db);
	if (remaining > 0 && !more) {
		const pruned = pruneScansInTransaction(db, options.now, remaining);
		remaining -= pruned.deletedRows;
		more = pruned.more;
	} else if (!more) {
		more = pruneScansInTransaction(db, options.now, 0).more;
	}
	return { deletedRows: maxRows - remaining, more };
}

/**
 * Abandon the `staging` versions nobody works on: created `afterMs` ago or earlier, and not the
 * tuple the open link recorded while the chain advanced less than `afterMs` ago.
 */
function abandonOrphanStaging(db: Tx, now: number, afterMs: number): void {
	const cutoff = now - afterMs;
	db.query(
		`UPDATE knowledge_versions SET state = 'abandoned', retired_at = ?1
WHERE state = 'staging' AND created_at <= ?2
 AND NOT EXISTS (
  SELECT 1 FROM knowledge_ingest_chain c
  WHERE c.id = 1 AND c.open_sweep IS NOT NULL AND c.advanced_at > ?2
   AND c.active_source_namespace = knowledge_versions.source_namespace
   AND c.active_document_id = knowledge_versions.document_id
   AND c.active_markdown_sha256 = knowledge_versions.markdown_sha256
   AND c.active_generation = knowledge_versions.generation
   AND c.active_retry = knowledge_versions.ingest_retry
   AND c.active_namespace = knowledge_versions.namespace)`,
	).run(now, cutoff);
}

/**
 * Delete rows of `table` together with their full-text rows within `budget` rows. The index
 * rows go first (their rowid is the row's id), then the rows; a row whose index row is already
 * gone costs one row, so the budget is exact and every call makes progress.
 */
function deleteIndexed(
	db: Tx,
	versionId: number,
	table: string,
	index: { idColumn: string; fts: string },
	budget: number,
): number {
	const ids = db
		.query<Record<string, number>>(
			`SELECT ${index.idColumn} AS id FROM ${table} WHERE version_id = ? ORDER BY ${index.idColumn} LIMIT ?`,
		)
		.all(versionId, Math.ceil(budget / 2))
		.map((r) => r.id);
	if (ids.length === 0) return 0;
	const list = JSON.stringify(ids);
	const indexed = db
		.query(
			`DELETE FROM ${index.fts} WHERE rowid IN (SELECT value FROM json_each(?))`,
		)
		.run(list).changes;
	const left = budget - indexed;
	if (left <= 0) return indexed;
	const rows = db
		.query(
			`DELETE FROM ${table} WHERE ${index.idColumn} IN (SELECT value FROM json_each(?) ORDER BY value LIMIT ?)`,
		)
		.run(list, left).changes;
	return indexed + rows;
}

function hasDerivedRows(db: Tx, versionId: number): boolean {
	if (hasLinkRowsInTransaction(db, versionId)) return true;
	for (const { table } of DERIVED_STEPS) {
		if (
			db
				.query(`SELECT 1 AS x FROM ${table} WHERE version_id = ? LIMIT 1`)
				.get(versionId) !== null
		) {
			return true;
		}
	}
	return false;
}
