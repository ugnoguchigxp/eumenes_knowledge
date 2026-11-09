import {
	KnowledgeError,
	type EvidenceRange,
	type Tx,
} from "../contracts/index.js";
import type { DocumentKey } from "./documents.js";
import { decodeVector, toVersionRow, type VersionRow } from "./versions.js";

/**
 * Reads of the index. They take the host's connection (a snapshot or a transaction) and write
 * nothing. Ranking and merging are P3's; these only fetch correctly.
 *
 * Reads fail closed: what a caller may see is the published version of a `current` document
 * (stored `current` covers derived `unverified`) in the namespaces the caller was given. The
 * functions that take a version id check none of this, so they are internal: the package's
 * public `./sqlite` entry does not export them (tests and maintenance import this module).
 */

const PUBLISHED_VERSION_SQL = `SELECT v.* FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id
WHERE d.source_namespace = ? AND d.document_id = ? AND v.state = 'published'`;

/**
 * The published version of a document that is `current`; null for any other state (`stale`,
 * `unavailable`, `excluded`, `removed`) and for a document without a published version.
 */
export function getPublishedVersionInSnapshot(
	db: Tx,
	key: DocumentKey,
): VersionRow | null {
	const r = db
		.query<Parameters<typeof toVersionRow>[0]>(
			`${PUBLISHED_VERSION_SQL} AND d.state = 'current'`,
		)
		.get(key.sourceNamespace, key.documentId);
	return r ? toVersionRow(r) : null;
}

/**
 * Maintenance only: the version a document keeps as its published one whatever the document's
 * state (`unavailable` keeps it). Never for answering a read.
 */
export function getRetainedVersionInSnapshot(
	db: Tx,
	key: DocumentKey,
): VersionRow | null {
	const r = db
		.query<Parameters<typeof toVersionRow>[0]>(PUBLISHED_VERSION_SQL)
		.get(key.sourceNamespace, key.documentId);
	return r ? toVersionRow(r) : null;
}

/** Internal: any version by id, with no check of state or namespace. */
export function getVersionInSnapshot(
	db: Tx,
	versionId: number,
): VersionRow | null {
	const r = db
		.query<Parameters<typeof toVersionRow>[0]>(
			"SELECT * FROM knowledge_versions WHERE version_id = ?",
		)
		.get(versionId);
	return r ? toVersionRow(r) : null;
}

export type StoredFragment = {
	versionId: number;
	ordinal: number;
	byteStart: number;
	byteEnd: number;
	headingPath: string[];
	text: string;
	textSha256: string;
};

export type RawFragment = {
	version_id: number;
	ordinal: number;
	byte_start: number;
	byte_end: number;
	heading_path: string;
	text: string;
	text_sha256: string;
};

export const toFragment = (r: RawFragment): StoredFragment => ({
	versionId: r.version_id,
	ordinal: r.ordinal,
	byteStart: r.byte_start,
	byteEnd: r.byte_end,
	headingPath: JSON.parse(r.heading_path) as string[],
	text: r.text,
	textSha256: r.text_sha256,
});

/** The fragments of a version in ordinal order. */
export function listFragmentsInSnapshot(
	db: Tx,
	versionId: number,
): StoredFragment[] {
	return db
		.query<RawFragment>(
			`SELECT version_id, ordinal, byte_start, byte_end, heading_path, text, text_sha256
FROM knowledge_fragments WHERE version_id = ? ORDER BY ordinal`,
		)
		.all(versionId)
		.map(toFragment);
}

export type StoredExtraction = {
	versionId: number;
	ordinal: number;
	status: "ok" | "failed";
	errorCode: string | null;
	model: string | null;
	droppedCount: number;
	dropped: { reason: string; count: number }[];
};

export function listExtractionsInSnapshot(
	db: Tx,
	versionId: number,
): StoredExtraction[] {
	return db
		.query<{
			version_id: number;
			ordinal: number;
			status: "ok" | "failed";
			error_code: string | null;
			model: string | null;
			dropped_count: number;
			dropped_json: string;
		}>(
			"SELECT * FROM knowledge_extractions WHERE version_id = ? ORDER BY ordinal",
		)
		.all(versionId)
		.map((r) => ({
			versionId: r.version_id,
			ordinal: r.ordinal,
			status: r.status,
			errorCode: r.error_code,
			model: r.model,
			droppedCount: r.dropped_count,
			dropped: JSON.parse(r.dropped_json) as StoredExtraction["dropped"],
		}));
}

export type StoredEntityMention = {
	entityId: number;
	versionId: number;
	fragmentOrdinal: number;
	localId: string;
	name: string;
	type: string;
	description: string;
};

export function listEntityMentionsInSnapshot(
	db: Tx,
	versionId: number,
): StoredEntityMention[] {
	return db
		.query<{
			entity_id: number;
			version_id: number;
			fragment_ordinal: number;
			local_id: string;
			name: string;
			type: string;
			description: string;
		}>(
			"SELECT * FROM knowledge_entity_mentions WHERE version_id = ? ORDER BY fragment_ordinal, entity_id",
		)
		.all(versionId)
		.map((r) => ({
			entityId: r.entity_id,
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			localId: r.local_id,
			name: r.name,
			type: r.type,
			description: r.description,
		}));
}

export type StoredRelationMention = {
	relationId: number;
	versionId: number;
	fragmentOrdinal: number;
	localId: string;
	sourceLocalId: string;
	targetLocalId: string;
	directed: boolean;
	relation: string;
	description: string;
	keywords: string[];
	qualifiers: {
		negated: boolean;
		condition: string | null;
		certainty: "stated" | "uncertain" | "hypothetical";
	};
};

export function listRelationMentionsInSnapshot(
	db: Tx,
	versionId: number,
): StoredRelationMention[] {
	return db
		.query<{
			relation_id: number;
			version_id: number;
			fragment_ordinal: number;
			local_id: string;
			source_local_id: string;
			target_local_id: string;
			directed: number;
			relation: string;
			description: string;
			keywords_json: string;
			qualifier_negated: number;
			qualifier_condition: string | null;
			qualifier_certainty: "stated" | "uncertain" | "hypothetical";
		}>(
			"SELECT * FROM knowledge_relation_mentions WHERE version_id = ? ORDER BY fragment_ordinal, relation_id",
		)
		.all(versionId)
		.map((r) => ({
			relationId: r.relation_id,
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			localId: r.local_id,
			sourceLocalId: r.source_local_id,
			targetLocalId: r.target_local_id,
			directed: r.directed === 1,
			relation: r.relation,
			description: r.description,
			keywords: JSON.parse(r.keywords_json) as string[],
			qualifiers: {
				negated: r.qualifier_negated === 1,
				condition: r.qualifier_condition,
				certainty: r.qualifier_certainty,
			},
		}));
}

export type StoredEvidence = EvidenceRange & {
	versionId: number;
	subjectKind: "entity" | "relation";
	/** `entityId` or `relationId` of the mention, by `subjectKind`. */
	subjectId: number;
	position: number;
};

/** All evidence ranges of a version, grouped by subject and in the order they were given. */
export function listEvidenceInSnapshot(
	db: Tx,
	versionId: number,
): StoredEvidence[] {
	return db
		.query<{
			version_id: number;
			subject_kind: "entity" | "relation";
			subject_id: number;
			position: number;
			fragment_ordinal: number;
			byte_start: number;
			byte_end: number;
			quote_sha256: string;
			ambiguous: number;
		}>(
			"SELECT * FROM knowledge_evidence WHERE version_id = ? ORDER BY subject_kind, subject_id, position",
		)
		.all(versionId)
		.map((r) => ({
			versionId: r.version_id,
			subjectKind: r.subject_kind,
			subjectId: r.subject_id,
			position: r.position,
			fragmentOrdinal: r.fragment_ordinal,
			byteStart: r.byte_start,
			byteEnd: r.byte_end,
			quoteSha256: r.quote_sha256,
			ambiguous: r.ambiguous === 1,
		}));
}

export type StoredVector = {
	versionId: number;
	ordinal: number;
	vector: Float32Array;
};

/** The vectors of one version in one space, in ordinal order. */
export function readVersionVectorsInSnapshot(
	db: Tx,
	versionId: number,
	spaceKey: string,
): StoredVector[] {
	return db
		.query<{ version_id: number; ordinal: number; vector: Uint8Array }>(
			"SELECT version_id, ordinal, vector FROM knowledge_vectors WHERE space_key = ? AND version_id = ? ORDER BY ordinal",
		)
		.all(spaceKey, versionId)
		.map((r) => ({
			versionId: r.version_id,
			ordinal: r.ordinal,
			vector: decodeVector(r.vector),
		}));
}

/**
 * Every vector of one space that a search may use: the published version of each `current`
 * document (stored `current` covers derived `unverified`) in `namespaces`. `namespaces` is
 * required; an empty list returns nothing. Order is by version and ordinal.
 */
export function readPublishedVectorsInSnapshot(
	db: Tx,
	spaceKey: string,
	namespaces: readonly string[],
): StoredVector[] {
	if (!Array.isArray(namespaces)) throw new KnowledgeError("invalid_input");
	if (namespaces.length === 0) return [];
	return db
		.query<{ version_id: number; ordinal: number; vector: Uint8Array }>(
			`SELECT x.version_id, x.ordinal, x.vector FROM knowledge_vectors x
JOIN knowledge_documents d ON d.published_version_id = x.version_id
WHERE x.space_key = ?1 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY x.version_id, x.ordinal`,
		)
		.all(spaceKey, JSON.stringify(namespaces))
		.map((r) => ({
			versionId: r.version_id,
			ordinal: r.ordinal,
			vector: decodeVector(r.vector),
		}));
}

export type FragmentSearchHit = StoredFragment & {
	sourceNamespace: string;
	documentId: string;
	namespace: string;
	/** Last verification of the document; the caller derives `unverified` from it. */
	lastVerifiedAt: number | null;
	/** FTS5 bm25 (lower is better); not comparable with vector scores. */
	bm25: number;
};

export const MAX_SEARCH_LIMIT = 1000;

/**
 * Fragments of published versions of `current` documents in `namespaces` whose normalized
 * search text contains `query`. `query` is normalized here (NFKC, then lower case: the rule the
 * index text went through, `normalizeForSearch` of `src/core/text`), then matched as one
 * literal phrase. A query shorter than 3 characters after normalization cannot match a trigram
 * index and returns nothing: the caller decides on a fallback. Best bm25 first, at most `limit`
 * (1..1000). `namespaces` is required; an empty list returns nothing.
 */
export function searchFragmentsInSnapshot(
	db: Tx,
	query: string,
	limit: number,
	namespaces: readonly string[],
): FragmentSearchHit[] {
	if (
		typeof query !== "string" ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_SEARCH_LIMIT ||
		!Array.isArray(namespaces)
	) {
		throw new KnowledgeError("invalid_input");
	}
	if (namespaces.length === 0) return [];
	// The same two steps as `normalizeForSearch` (src/core/text); this module imports no core.
	const normalized = query.normalize("NFKC").toLowerCase();
	if ([...normalized].length < 3) return [];
	const phrase = `"${normalized.replaceAll('"', '""')}"`;
	return db
		.query<
			RawFragment & {
				source_namespace: string;
				document_id: string;
				namespace: string;
				last_verified_at: number | null;
				score: number;
			}
		>(
			`SELECT fr.version_id, fr.ordinal, fr.byte_start, fr.byte_end, fr.heading_path, fr.text,
 fr.text_sha256, d.source_namespace, d.document_id, d.namespace, d.last_verified_at,
 bm25(knowledge_fragment_fts) AS score
FROM knowledge_fragment_fts
JOIN knowledge_fragments fr ON fr.fragment_id = knowledge_fragment_fts.rowid
JOIN knowledge_documents d ON d.published_version_id = fr.version_id
WHERE knowledge_fragment_fts MATCH ?1 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY score, fr.version_id, fr.ordinal
LIMIT ?3`,
		)
		.all(phrase, JSON.stringify(namespaces), limit)
		.map((r) => ({
			...toFragment(r),
			sourceNamespace: r.source_namespace,
			documentId: r.document_id,
			namespace: r.namespace,
			lastVerifiedAt: r.last_verified_at,
			bm25: r.score,
		}));
}

// ---------------------------------------------------------------------------
// P3: reads for the resident vector index and the evidence check. Internal, like the other
// reads by version id: the callers check the document's state and the caller's namespaces.
// ---------------------------------------------------------------------------

/**
 * Ids of every published version that has vectors in `spaceKey`, with their fragment counts,
 * in ascending order. Ids and counts only (no document data); the resident vector index diffs it
 * against what it holds. Who may see a version is decided by `listSearchableVersionIdsInSnapshot`.
 */
export function listPublishedVersionsOfSpaceInSnapshot(
	db: Tx,
	spaceKey: string,
): { versionId: number; fragments: number }[] {
	return db
		.query<{ version_id: number; vectors_written: number }>(
			`SELECT version_id, vectors_written FROM knowledge_versions
WHERE state = 'published' AND space_key = ? ORDER BY version_id`,
		)
		.all(spaceKey)
		.map((r) => ({ versionId: r.version_id, fragments: r.vectors_written }));
}

export type VectorMatrix = {
	/** Fragment ordinal of each row. */
	ordinals: Int32Array;
	/** `ordinals.length * dimension` float32 values, row by row. */
	matrix: Float32Array;
};

/** The vectors of one version in one space as one packed matrix (ordinal order). */
export function readVersionVectorMatrixInSnapshot(
	db: Tx,
	versionId: number,
	spaceKey: string,
	dimension: number,
	rows: number,
): VectorMatrix {
	const ordinals = new Int32Array(rows);
	const matrix = new Float32Array(rows * dimension);
	let i = 0;
	for (const r of db
		.query<{ ordinal: number; vector: Uint8Array }>(
			"SELECT ordinal, vector FROM knowledge_vectors WHERE space_key = ? AND version_id = ? ORDER BY ordinal",
		)
		.all(spaceKey, versionId)) {
		const v = decodeVector(r.vector);
		if (i >= rows || v.length !== dimension) {
			throw new KnowledgeError("contract_mismatch");
		}
		ordinals[i] = r.ordinal;
		matrix.set(v, i * dimension);
		i++;
	}
	if (i !== rows) throw new KnowledgeError("contract_mismatch");
	return { ordinals, matrix };
}

/** Fragments of a version whose byte range overlaps `[byteStart, byteEnd)`, in ordinal order. */
export function readFragmentsOverlappingInSnapshot(
	db: Tx,
	versionId: number,
	byteStart: number,
	byteEnd: number,
): StoredFragment[] {
	return db
		.query<RawFragment>(
			`SELECT version_id, ordinal, byte_start, byte_end, heading_path, text, text_sha256
FROM knowledge_fragments WHERE version_id = ? AND byte_end > ? AND byte_start < ? ORDER BY ordinal`,
		)
		.all(versionId, byteStart, byteEnd)
		.map(toFragment);
}

// ---------------------------------------------------------------------------
// Related fragments (kg2.md §3.5): the scope's size, a version's space, fragment points
// ---------------------------------------------------------------------------

/** The ordinals of a version's fragments, in order (no text read). */
export function listFragmentOrdinalsInSnapshot(
	db: Tx,
	versionId: number,
): number[] {
	return db
		.query<{ ordinal: number }>(
			"SELECT ordinal FROM knowledge_fragments WHERE version_id = ? ORDER BY ordinal",
		)
		.all(versionId)
		.map((r) => r.ordinal);
}

/** Fragments of the published versions of `current` documents in `namespaces`. */
export function countScopeFragmentsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): number {
	if (!Array.isArray(namespaces)) throw new KnowledgeError("invalid_input");
	if (namespaces.length === 0) return 0;
	return (
		db
			.query<{ n: number }>(
				`SELECT COUNT(*) AS n FROM knowledge_fragments f
JOIN knowledge_documents d ON d.published_version_id = f.version_id AND d.state = 'current'
WHERE d.namespace IN (SELECT value FROM json_each(?1))`,
			)
			.get(JSON.stringify(namespaces))?.n ?? 0
	);
}

/** The embedding space of a version's vectors, or null when it has none. */
export function readVersionSpaceInSnapshot(
	db: Tx,
	versionId: number,
): { key: string; dimension: number } | null {
	const r = db
		.query<{ space_key: string; dimension: number }>(
			`SELECT v.space_key, s.dimension FROM knowledge_versions v
JOIN knowledge_embedding_spaces s ON s.space_key = v.space_key
WHERE v.version_id = ?1`,
		)
		.get(versionId);
	return r ? { key: r.space_key, dimension: r.dimension } : null;
}

export type FragmentPoint = {
	versionId: number;
	ordinal: number;
	byteStart: number;
	byteEnd: number;
	/** sha256 of the fragment's UTF-8 bytes: the whole fragment is the quotation. */
	quoteSha256: string;
};

/** The byte ranges and digests of fragments, by (version id, ordinal). */
export function readFragmentPointsInSnapshot(
	db: Tx,
	refs: readonly { versionId: number; ordinal: number }[],
): FragmentPoint[] {
	if (!Array.isArray(refs)) throw new KnowledgeError("invalid_input");
	if (refs.length === 0) return [];
	return db
		.query<{
			version_id: number;
			ordinal: number;
			byte_start: number;
			byte_end: number;
			text_sha256: string;
		}>(
			`SELECT f.version_id, f.ordinal, f.byte_start, f.byte_end, f.text_sha256
FROM json_each(?1) j
JOIN knowledge_fragments f ON f.version_id = json_extract(j.value, '$[0]')
 AND f.ordinal = json_extract(j.value, '$[1]')`,
		)
		.all(JSON.stringify(refs.map((r) => [r.versionId, r.ordinal])))
		.map((r) => ({
			versionId: r.version_id,
			ordinal: r.ordinal,
			byteStart: r.byte_start,
			byteEnd: r.byte_end,
			quoteSha256: r.text_sha256,
		}));
}
