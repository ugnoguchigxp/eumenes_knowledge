import { KnowledgeError, type Tx } from "../contracts/index.js";

/**
 * Snapshot reads for one knowledge graph in a namespace scope (kg.md §2). Each read is bounded
 * and indexed: mentions come from the `current` documents of the scope (entity id order, at most
 * `cap`), the rest is read by `json_each` batches keyed by entity id, version id or subject id,
 * never one query per mention. Nothing here decides what is "the same" or what a name means; the
 * package's `readGraph` joins these rows.
 */

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};

const ids = (values: readonly number[]): string => JSON.stringify(values);

/** A mention is current when it belongs to the published version of a `current` document. */
const CURRENT_MENTION_JOIN = `JOIN knowledge_documents d ON d.published_version_id = m.version_id AND d.state = 'current'`;

export type GraphMention = {
	entityId: number;
	versionId: number;
	fragmentOrdinal: number;
	localId: string;
	name: string;
	/** NFKC + lower case of the name, as stored for candidate matching; may be empty on old rows. */
	nameNorm: string;
	type: string;
};

/**
 * The current entity mentions of the documents in `namespaces`, in entity id order, at most
 * `cap`. `truncated` says that more exist (only the first `cap` are listed).
 */
export function readGraphMentionsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
	cap: number,
): { mentions: GraphMention[]; truncated: boolean } {
	if (!Array.isArray(namespaces) || !Number.isSafeInteger(cap) || cap < 1) {
		return invalid();
	}
	if (namespaces.length === 0) return { mentions: [], truncated: false };
	const rows = db
		.query<{
			entity_id: number;
			version_id: number;
			fragment_ordinal: number;
			local_id: string;
			name: string;
			name_norm: string;
			type: string;
		}>(
			`SELECT m.entity_id, m.version_id, m.fragment_ordinal, m.local_id, m.name, m.name_norm, m.type
FROM knowledge_entity_mentions m ${CURRENT_MENTION_JOIN}
WHERE d.namespace IN (SELECT value FROM json_each(?1))
ORDER BY m.entity_id LIMIT ?2`,
		)
		.all(JSON.stringify(namespaces), cap + 1);
	return {
		mentions: rows.slice(0, cap).map((r) => ({
			entityId: r.entity_id,
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			localId: r.local_id,
			name: r.name,
			nameNorm: r.name_norm,
			type: r.type,
		})),
		truncated: rows.length > cap,
	};
}

export type GraphLink = {
	/** Canonical order: `a < b`. */
	a: number;
	b: number;
	decision: "same" | "different";
	model: string | null;
	instructionId: string;
	instructionVersion: number;
};

/**
 * The `same` and `different` judgments whose two ends are both in `entityIds`, in (a, b) order
 * (a judgment with any other mention is not read; `unsure` is not a link and not a constraint).
 */
export function readGraphLinksInSnapshot(
	db: Tx,
	entityIds: readonly number[],
): GraphLink[] {
	if (!Array.isArray(entityIds)) return invalid();
	if (entityIds.length === 0) return [];
	return db
		.query<{
			entity_a: number;
			entity_b: number;
			decision: "same" | "different";
			model: string | null;
			instruction_id: string;
			instruction_version: number;
		}>(
			`SELECT l.entity_a, l.entity_b, l.decision, l.model, l.instruction_id, l.instruction_version
FROM knowledge_entity_links l
WHERE l.decision IN ('same', 'different')
 AND l.entity_a IN (SELECT value FROM json_each(?1))
 AND l.entity_b IN (SELECT value FROM json_each(?1))
ORDER BY l.entity_a, l.entity_b`,
		)
		.all(ids(entityIds))
		.map((r) => ({
			a: r.entity_a,
			b: r.entity_b,
			decision: r.decision,
			model: r.model,
			instructionId: r.instruction_id,
			instructionVersion: r.instruction_version,
		}));
}

export type GraphDocument = {
	versionId: number;
	documentId: string;
	namespace: string;
	path: string;
	title: string;
	markdownSha256: string;
	lastVerifiedAt: number | null;
};

/** The `current` documents whose published versions are `versionIds`. */
export function readGraphDocumentsInSnapshot(
	db: Tx,
	versionIds: readonly number[],
): GraphDocument[] {
	if (!Array.isArray(versionIds)) return invalid();
	if (versionIds.length === 0) return [];
	return db
		.query<{
			version_id: number;
			document_id: string;
			namespace: string;
			path: string;
			title: string;
			markdown_sha256: string;
			last_verified_at: number | null;
		}>(
			`SELECT v.version_id, d.document_id, d.namespace, d.path, d.title, v.markdown_sha256, d.last_verified_at
FROM knowledge_versions v
JOIN knowledge_documents d ON d.published_version_id = v.version_id AND d.state = 'current'
WHERE v.version_id IN (SELECT value FROM json_each(?1))
ORDER BY v.version_id`,
		)
		.all(ids(versionIds))
		.map((r) => ({
			versionId: r.version_id,
			documentId: r.document_id,
			namespace: r.namespace,
			path: r.path,
			title: r.title,
			markdownSha256: r.markdown_sha256,
			lastVerifiedAt: r.last_verified_at,
		}));
}

export type GraphRelation = {
	relationId: number;
	versionId: number;
	fragmentOrdinal: number;
	sourceLocalId: string;
	targetLocalId: string;
	directed: boolean;
	relation: string;
	keywords: string[];
	negated: boolean;
	condition: string | null;
	certainty: "stated" | "uncertain" | "hypothetical";
};

const parseKeywords = (json: string): string[] => {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value)
			? value.filter((k): k is string => typeof k === "string")
			: [];
	} catch {
		return [];
	}
};

/**
 * The relation mentions of the given versions in (version, fragment, local id) order, at most
 * `cap` (`truncated` says that more exist). The ends are local ids within the same version and
 * fragment; the caller maps them to entity mentions.
 */
export function readGraphRelationsInSnapshot(
	db: Tx,
	versionIds: readonly number[],
	cap: number,
): { relations: GraphRelation[]; truncated: boolean } {
	if (!Array.isArray(versionIds) || !Number.isSafeInteger(cap) || cap < 1) {
		return invalid();
	}
	if (versionIds.length === 0) return { relations: [], truncated: false };
	const rows = db
		.query<{
			relation_id: number;
			version_id: number;
			fragment_ordinal: number;
			source_local_id: string;
			target_local_id: string;
			directed: number;
			relation: string;
			keywords_json: string;
			qualifier_negated: number;
			qualifier_condition: string | null;
			qualifier_certainty: GraphRelation["certainty"];
		}>(
			`SELECT r.relation_id, r.version_id, r.fragment_ordinal, r.source_local_id, r.target_local_id,
 r.directed, r.relation, r.keywords_json, r.qualifier_negated, r.qualifier_condition, r.qualifier_certainty
FROM knowledge_relation_mentions r
WHERE r.version_id IN (SELECT value FROM json_each(?1))
ORDER BY r.version_id, r.fragment_ordinal, r.local_id LIMIT ?2`,
		)
		.all(ids(versionIds), cap + 1);
	return {
		relations: rows.slice(0, cap).map((r) => ({
			relationId: r.relation_id,
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			sourceLocalId: r.source_local_id,
			targetLocalId: r.target_local_id,
			directed: r.directed === 1,
			relation: r.relation,
			keywords: parseKeywords(r.keywords_json),
			negated: r.qualifier_negated === 1,
			condition: r.qualifier_condition,
			certainty: r.qualifier_certainty,
		})),
		truncated: rows.length > cap,
	};
}

export type GraphEvidence = {
	subjectId: number;
	versionId: number;
	fragmentOrdinal: number;
	byteStart: number;
	byteEnd: number;
	quoteSha256: string;
};

/**
 * The first `perSubject` evidence ranges of each subject (an entity or a relation mention), in
 * subject id then position order.
 */
export function readGraphEvidenceInSnapshot(
	db: Tx,
	kind: "entity" | "relation",
	subjectIds: readonly number[],
	perSubject: number,
): GraphEvidence[] {
	if (
		!Array.isArray(subjectIds) ||
		!Number.isSafeInteger(perSubject) ||
		perSubject < 1
	) {
		return invalid();
	}
	if (subjectIds.length === 0) return [];
	return db
		.query<{
			subject_id: number;
			version_id: number;
			fragment_ordinal: number;
			byte_start: number;
			byte_end: number;
			quote_sha256: string;
		}>(
			`SELECT e.subject_id, e.version_id, e.fragment_ordinal, e.byte_start, e.byte_end, e.quote_sha256
FROM knowledge_evidence e
WHERE e.subject_kind = ?1 AND e.subject_id IN (SELECT value FROM json_each(?2)) AND e.position < ?3
ORDER BY e.subject_id, e.position`,
		)
		.all(kind, ids(subjectIds), perSubject)
		.map((r) => ({
			subjectId: r.subject_id,
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			byteStart: r.byte_start,
			byteEnd: r.byte_end,
			quoteSha256: r.quote_sha256,
		}));
}
