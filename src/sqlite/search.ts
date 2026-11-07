import {
	KnowledgeError,
	SOURCE_NAMESPACE_DOCLING,
	type KnowledgeStatus,
	type Tx,
} from "../contracts/index.js";
import { DEFAULT_MAX_UNAPPLIED_ATTEMPTS } from "./defaults.js";
import { MAX_SEARCH_LIMIT, toFragment, type StoredFragment } from "./reads.js";
import { readStatusDetailInSnapshot } from "./status.js";

/**
 * Reads for the search (p3.md §3). Like the other reads they take the host's snapshot and write
 * nothing, and they fail closed: what a caller may see is the published version of a `current`
 * document (stored `current` covers derived `unverified`) in the namespaces given. `namespaces`
 * is required; an empty list returns nothing (zero counts, no rows). Matching is by string
 * only; this module decides nothing about meaning.
 */

const checkNamespaces = (namespaces: unknown): readonly string[] => {
	if (!Array.isArray(namespaces)) throw new KnowledgeError("invalid_input");
	return namespaces as readonly string[];
};

/** The rule `normalizeForSearch` of `src/core/text` states (this module imports no core). */
const normalize = (text: string): string =>
	text.normalize("NFKC").toLowerCase();
const charCount = (text: string): number => [...text].length;

const checkLimit = (limit: unknown): number => {
	if (
		typeof limit !== "number" ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_SEARCH_LIMIT
	) {
		throw new KnowledgeError("invalid_input");
	}
	return limit;
};

/** A fragment of a published version, named by version and ordinal. */
export type FragmentRef = { versionId: number; ordinal: number };

// ---------------------------------------------------------------------------
// Text route, short queries
// ---------------------------------------------------------------------------

/**
 * Fragments of searchable documents whose normalized search text contains `query` (normalized
 * the same way) as a substring, found by scanning the index text with `instr`. For queries the
 * trigram index cannot answer (under 3 characters); the caller bounds the scan with
 * `countSearchableFragmentsInSnapshot`. Document and ordinal order, at most `limit` (1..1000).
 */
export function scanFragmentsInSnapshot(
	db: Tx,
	query: string,
	limit: number,
	namespaces: readonly string[],
): FragmentRef[] {
	if (typeof query !== "string") throw new KnowledgeError("invalid_input");
	checkLimit(limit);
	if (checkNamespaces(namespaces).length === 0) return [];
	const needle = normalize(query);
	if (needle.length === 0) return [];
	return db
		.query<{ version_id: number; ordinal: number }>(
			`SELECT fr.version_id, fr.ordinal
FROM knowledge_fragment_fts f
JOIN knowledge_fragments fr ON fr.fragment_id = f.rowid
JOIN knowledge_documents d ON d.published_version_id = fr.version_id
WHERE instr(f.search_text, ?1) > 0 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY fr.version_id, fr.ordinal
LIMIT ?3`,
		)
		.all(needle, JSON.stringify(namespaces), limit)
		.map((r) => ({ versionId: r.version_id, ordinal: r.ordinal }));
}

/**
 * Fragments (of published versions) of searchable documents in `namespaces`: the number a
 * substring scan would read.
 */
export function countSearchableFragmentsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): number {
	if (checkNamespaces(namespaces).length === 0) return 0;
	return (
		db
			.query<{ n: number }>(
				`SELECT COALESCE(SUM(v.expected_fragments), 0) AS n FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
WHERE d.state = 'current' AND d.namespace IN (SELECT value FROM json_each(?))`,
			)
			.get(JSON.stringify(namespaces))?.n ?? 0
	);
}

// ---------------------------------------------------------------------------
// Vector route: which versions a search may use
// ---------------------------------------------------------------------------

/**
 * Published versions of `spaceKey` that belong to a `current` document in `namespaces`,
 * ascending. The resident vector index scores only these.
 */
export function listSearchableVersionIdsInSnapshot(
	db: Tx,
	spaceKey: string,
	namespaces: readonly string[],
): number[] {
	if (typeof spaceKey !== "string") throw new KnowledgeError("invalid_input");
	if (checkNamespaces(namespaces).length === 0) return [];
	return db
		.query<{ version_id: number }>(
			`SELECT v.version_id FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
WHERE v.space_key = ?1 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY v.version_id`,
		)
		.all(spaceKey, JSON.stringify(namespaces))
		.map((r) => r.version_id);
}

// ---------------------------------------------------------------------------
// Entity and relation routes
// ---------------------------------------------------------------------------

export type MentionKind = "entity" | "relation";

export type MentionHit = {
	kind: MentionKind;
	/** `entityId` / `relationId` of the mention. */
	mentionId: number;
	versionId: number;
	/** The fragment the mention was extracted from, and so the fragment of its evidence. */
	fragmentOrdinal: number;
	/** The entity's name, or the relation's short description. */
	label: string;
	evidence: { byteStart: number; byteEnd: number; quoteSha256: string }[];
};

const MENTION_TABLES = {
	entity: {
		table: "knowledge_entity_mentions",
		id: "entity_id",
		fts: "knowledge_entity_fts",
		label: "name",
	},
	relation: {
		table: "knowledge_relation_mentions",
		id: "relation_id",
		fts: "knowledge_relation_fts",
		label: "relation",
	},
} as const;

function readMentions(
	db: Tx,
	kind: MentionKind,
	mode: "trigram" | "substring",
	query: string,
	limit: number,
	namespaces: readonly string[],
): MentionHit[] {
	if ((kind !== "entity" && kind !== "relation") || typeof query !== "string") {
		throw new KnowledgeError("invalid_input");
	}
	checkLimit(limit);
	if (checkNamespaces(namespaces).length === 0) return [];
	const normalized = normalize(query);
	const t = MENTION_TABLES[kind];
	let sql: string;
	let param: string;
	if (mode === "trigram") {
		if (charCount(normalized) < 3) return [];
		param = `"${normalized.replaceAll('"', '""')}"`;
		sql = `SELECT m.${t.id} AS mention_id, m.version_id, m.fragment_ordinal, m.${t.label} AS label
FROM ${t.fts}
JOIN ${t.table} m ON m.${t.id} = ${t.fts}.rowid
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE ${t.fts} MATCH ?1 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY bm25(${t.fts}), m.version_id, m.fragment_ordinal, m.${t.id}
LIMIT ?3`;
	} else {
		if (normalized.length === 0) return [];
		param = normalized;
		sql = `SELECT m.${t.id} AS mention_id, m.version_id, m.fragment_ordinal, m.${t.label} AS label
FROM ${t.fts} f
JOIN ${t.table} m ON m.${t.id} = f.rowid
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE instr(f.search_text, ?1) > 0 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))
ORDER BY m.version_id, m.fragment_ordinal, m.${t.id}
LIMIT ?3`;
	}
	const rows = db
		.query<{
			mention_id: number;
			version_id: number;
			fragment_ordinal: number;
			label: string;
		}>(sql)
		.all(param, JSON.stringify(namespaces), limit);
	const evidence = db.query<{
		byte_start: number;
		byte_end: number;
		quote_sha256: string;
	}>(
		`SELECT byte_start, byte_end, quote_sha256 FROM knowledge_evidence
WHERE subject_kind = ? AND subject_id = ? ORDER BY position`,
	);
	return rows.map((r) => ({
		kind,
		mentionId: r.mention_id,
		versionId: r.version_id,
		fragmentOrdinal: r.fragment_ordinal,
		label: r.label,
		evidence: evidence.all(kind, r.mention_id).map((e) => ({
			byteStart: e.byte_start,
			byteEnd: e.byte_end,
			quoteSha256: e.quote_sha256,
		})),
	}));
}

/**
 * Mentions of searchable documents whose normalized index text (entity: name, type,
 * description; relation: relation, description, keywords) contains `query` as one literal
 * phrase, best bm25 first, at most `limit` (1..1000). A query under 3 characters after
 * normalization returns nothing: use `scanMentionsInSnapshot`.
 */
export function searchMentionsInSnapshot(
	db: Tx,
	kind: MentionKind,
	query: string,
	limit: number,
	namespaces: readonly string[],
): MentionHit[] {
	return readMentions(db, kind, "trigram", query, limit, namespaces);
}

/** The substring scan counterpart for queries under 3 characters (document order). */
export function scanMentionsInSnapshot(
	db: Tx,
	kind: MentionKind,
	query: string,
	limit: number,
	namespaces: readonly string[],
): MentionHit[] {
	return readMentions(db, kind, "substring", query, limit, namespaces);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type SearchableFragment = StoredFragment & {
	sourceNamespace: string;
	documentId: string;
	namespace: string;
	path: string;
	title: string;
	markdownSha256: string;
	/** Last verification of the document; the caller derives `unverified` from it. */
	lastVerifiedAt: number | null;
};

/**
 * The fragments `refs` name, in the same order, for the ones a caller may read now (published
 * version of a `current` document in `namespaces`); the others are left out.
 */
export function readSearchableFragmentsInSnapshot(
	db: Tx,
	refs: readonly FragmentRef[],
	namespaces: readonly string[],
): SearchableFragment[] {
	if (!Array.isArray(refs)) throw new KnowledgeError("invalid_input");
	if (checkNamespaces(namespaces).length === 0) return [];
	const json = JSON.stringify(namespaces);
	const stmt = db.query<
		Parameters<typeof toFragment>[0] & {
			source_namespace: string;
			document_id: string;
			namespace: string;
			path: string;
			title: string;
			markdown_sha256: string;
			last_verified_at: number | null;
		}
	>(
		`SELECT fr.version_id, fr.ordinal, fr.byte_start, fr.byte_end, fr.heading_path, fr.text,
 fr.text_sha256, d.source_namespace, d.document_id, d.namespace, d.path, d.title,
 v.markdown_sha256, d.last_verified_at
FROM knowledge_fragments fr
JOIN knowledge_documents d ON d.published_version_id = fr.version_id
JOIN knowledge_versions v ON v.version_id = fr.version_id AND v.state = 'published'
WHERE fr.version_id = ?1 AND fr.ordinal = ?2 AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?3))`,
	);
	const out: SearchableFragment[] = [];
	for (const ref of refs) {
		const r = stmt.get(ref.versionId, ref.ordinal, json);
		if (!r) continue;
		out.push({
			...toFragment(r),
			sourceNamespace: r.source_namespace,
			documentId: r.document_id,
			namespace: r.namespace,
			path: r.path,
			title: r.title,
			markdownSha256: r.markdown_sha256,
			lastVerifiedAt: r.last_verified_at,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type SearchCoverage = {
	documents: number;
	/** `current` and `unverified` documents: the ones a search can use. */
	searchable: number;
	stale: number;
	/** `unavailable`, `excluded` and `removed`. */
	unavailable: number;
	/** Stale documents skipped after too many content-caused attempts (also counted in `stale`). */
	failed: number;
	extractionIncomplete: number;
};

export type SearchCoverageOptions = {
	/** A current document verified earlier than `now - verifiedWithinMs` is unverified. */
	verifiedWithinMs: number;
	maxUnappliedAttempts?: number;
};

/**
 * What the search could use among the documents of `namespaces`, and the reasons an answer is
 * partial that the registry alone decides: the same reasons and the same counting as
 * `readStatusInSnapshot` (scan reasons included; no binding is known here, so any complete scan
 * counts). An empty `namespaces` counts nothing.
 */
export function readSearchCoverageInSnapshot(
	db: Tx,
	namespaces: readonly string[],
	now: number,
	options: SearchCoverageOptions,
): {
	coverage: SearchCoverage;
	partialReasons: KnowledgeStatus["partialReasons"];
} {
	checkNamespaces(namespaces);
	const detail = readStatusDetailInSnapshot(
		db,
		{ principal: "search", namespaces: [...namespaces] },
		now,
		{
			verifiedWithinMs: options.verifiedWithinMs,
			maxUnappliedAttempts:
				options.maxUnappliedAttempts ?? DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
		},
	);
	const d = detail.status.documents;
	return {
		coverage: {
			documents: d.total,
			searchable: d.current + d.unverified,
			stale: d.stale,
			unavailable: d.unavailable + d.excluded + d.removed,
			failed: detail.failed,
			extractionIncomplete: detail.extractionIncomplete,
		},
		partialReasons: detail.status.partialReasons,
	};
}

// ---------------------------------------------------------------------------
// Evidence check
// ---------------------------------------------------------------------------

export type EvidenceTarget = {
	sourceNamespace: string;
	documentId: string;
	/** The registry's state. */
	state: "current" | "stale" | "unavailable" | "excluded" | "removed";
	observedMarkdownSha256: string;
	lastVerifiedAt: number | null;
	/** The version the document keeps as published, whatever its state; null if none. */
	published: {
		versionId: number;
		markdownSha256: string;
		byteLength: number;
	} | null;
};

/**
 * The registry row and the retained published version of a document, or null when the document
 * is unknown or outside `namespaces` (the two are not told apart). The caller decides from
 * `state` whether the version may be read at all.
 */
export function readEvidenceTargetInSnapshot(
	db: Tx,
	documentId: string,
	namespaces: readonly string[],
): EvidenceTarget | null {
	if (typeof documentId !== "string") throw new KnowledgeError("invalid_input");
	if (checkNamespaces(namespaces).length === 0) return null;
	const r = db
		.query<{
			source_namespace: string;
			document_id: string;
			state: EvidenceTarget["state"];
			observed_markdown_sha256: string;
			last_verified_at: number | null;
			version_id: number | null;
			markdown_sha256: string | null;
			byte_length: number | null;
		}>(
			`SELECT d.source_namespace, d.document_id, d.state, d.observed_markdown_sha256, d.last_verified_at,
 v.version_id, v.markdown_sha256, v.byte_length
FROM knowledge_documents d
LEFT JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
WHERE d.source_namespace = ?1 AND d.document_id = ?2
 AND d.namespace IN (SELECT value FROM json_each(?3))`,
		)
		.get(SOURCE_NAMESPACE_DOCLING, documentId, JSON.stringify(namespaces));
	if (!r) return null;
	return {
		sourceNamespace: r.source_namespace,
		documentId: r.document_id,
		state: r.state,
		observedMarkdownSha256: r.observed_markdown_sha256,
		lastVerifiedAt: r.last_verified_at,
		published:
			r.version_id !== null &&
			r.markdown_sha256 !== null &&
			r.byte_length !== null
				? {
						versionId: r.version_id,
						markdownSha256: r.markdown_sha256,
						byteLength: r.byte_length,
					}
				: null,
	};
}
