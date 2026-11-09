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
	/** The model-free extractor's identity key (kg2.md §3.3); '' for a model's mention. */
	nameKey: string;
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
			name_key: string;
			type: string;
		}>(
			`SELECT m.entity_id, m.version_id, m.fragment_ordinal, m.local_id, m.name, m.name_norm, m.name_key, m.type
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
			nameKey: r.name_key,
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
 AND +l.entity_b IN (SELECT value FROM json_each(?1))
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
 * The relation mentions whose two ends are both among `entityIds` (the mentions of the nodes a
 * graph returns), in (version, fragment, local id) order, at most `cap` (`truncated` says that
 * more exist). They are found from their source mention through an index, so a relation of
 * mentions the graph does not return is never read (kg2.md §7.9). A relation between two mentions
 * of one key is one node's loop and is not read either (it would only spend the cap). The ends
 * are local ids within the same version and fragment; the caller maps them to entity mentions.
 */
export function readGraphRelationsAmongInSnapshot(
	db: Tx,
	entityIds: readonly number[],
	cap: number,
): { relations: GraphRelation[]; truncated: boolean } {
	if (!Array.isArray(entityIds) || !Number.isSafeInteger(cap) || cap < 1) {
		return invalid();
	}
	if (entityIds.length === 0) return { relations: [], truncated: false };
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
FROM json_each(?1) k
JOIN knowledge_entity_mentions s ON s.entity_id = k.value
JOIN knowledge_relation_mentions r ON r.version_id = s.version_id
 AND r.fragment_ordinal = s.fragment_ordinal AND r.source_local_id = s.local_id
JOIN knowledge_entity_mentions t ON t.version_id = r.version_id
 AND t.fragment_ordinal = r.fragment_ordinal AND t.local_id = r.target_local_id
WHERE +t.entity_id IN (SELECT value FROM json_each(?1))
 AND NOT (s.name_key <> '' AND s.name_key = t.name_key)
ORDER BY r.version_id, r.fragment_ordinal, r.local_id LIMIT ?2`,
		)
		.all(ids(entityIds), cap + 1);
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

// ---------------------------------------------------------------------------
// The graph by identity keys (kg2.md §7.12): nodes and edges counted in SQL, so a scope of any
// size is read whole, without reading every mention.
// ---------------------------------------------------------------------------

/**
 * A group of current mentions: one identity key of one namespace, or one mention without a key
 * (`solo` its entity id; 0 for a key).
 */
export type KeyGroup = { namespace: string; key: string; solo: number };

export type KeyGroupCount = KeyGroup & {
	mentions: number;
	/** Documents (one published version each). */
	documents: number;
	/** The smallest entity id. */
	anchor: number;
	/** Whether a mention has one of the types asked for (always true when none is asked). */
	typed: boolean;
};

/**
 * Whether the graph of `namespaces` can be read by keys: every current document's published
 * version was extracted by the model-free extractor (its mentions are joined by key alone), and
 * no `same` or `different` judgment names a current mention of the scope (a judgment joins or
 * splits mentions one by one: the graph is then read mention by mention).
 */
export function canReadGraphByKeysInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): boolean {
	if (!Array.isArray(namespaces)) return invalid();
	const scope = JSON.stringify(namespaces);
	const other = db
		.query(
			`SELECT 1 AS x FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id
WHERE d.state = 'current' AND d.namespace IN (SELECT value FROM json_each(?1))
 AND v.extractor NOT LIKE 'names:%' LIMIT 1`,
		)
		.get(scope);
	if (other !== null) return false;
	const judged = db
		.query(
			// From the judgments (few) to their mentions, never from every mention to the judgments.
			`SELECT 1 AS x FROM knowledge_entity_links l
CROSS JOIN knowledge_entity_mentions m CROSS JOIN knowledge_documents d
WHERE l.decision IN ('same', 'different') AND (m.entity_id = l.entity_a OR m.entity_id = l.entity_b)
 AND d.published_version_id = m.version_id AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?1))
LIMIT 1`,
		)
		.get(scope);
	return judged === null;
}

/**
 * Every group of the current mentions of `namespaces` with its counts. `types` (null: any)
 * decides `typed`.
 */
export function readGraphKeyGroupsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
	types: readonly string[] | null,
): KeyGroupCount[] {
	if (!Array.isArray(namespaces) || (types !== null && !Array.isArray(types)))
		return invalid();
	if (namespaces.length === 0) return [];
	return db
		.query<{
			namespace: string;
			name_key: string;
			solo: number;
			mentions: number;
			documents: number;
			anchor: number;
			typed: number;
		}>(
			`SELECT d.namespace, m.name_key, CASE WHEN m.name_key = '' THEN m.entity_id ELSE 0 END AS solo,
 COUNT(*) AS mentions, COUNT(DISTINCT m.version_id) AS documents, MIN(m.entity_id) AS anchor,
 MAX(?2 IS NULL OR m.type IN (SELECT value FROM json_each(?2))) AS typed
FROM knowledge_documents d
JOIN knowledge_entity_mentions m ON m.version_id = d.published_version_id
WHERE d.state = 'current' AND d.namespace IN (SELECT value FROM json_each(?1))
GROUP BY d.namespace, m.name_key, solo`,
		)
		.all(
			JSON.stringify(namespaces),
			types === null ? null : JSON.stringify(types),
		)
		.map((r) => ({
			namespace: r.namespace,
			key: r.name_key,
			solo: r.solo,
			mentions: r.mentions,
			documents: r.documents,
			anchor: r.anchor,
			typed: r.typed === 1,
		}));
}

/**
 * Rows over the current mentions of the given groups: `select` and `tail` (a GROUP BY, an ORDER
 * BY) see the mention as `m`, its document as `d`, and `g`, the group's index in `groups`. Keyed
 * groups are found through the key index, groups of one mention by its id.
 */
function groupRows<T>(
	db: Tx,
	groups: readonly KeyGroup[],
	select: string,
	tail = "",
): (T & { g: number })[] {
	const keyed: [number, string, string][] = [];
	const solos: [number, string, number][] = [];
	groups.forEach((g, i) => {
		if (g.solo === 0) keyed.push([i, g.namespace, g.key]);
		else solos.push([i, g.namespace, g.solo]);
	});
	// CROSS JOIN keeps the order: each group's mentions through the index, then their documents
	// (the planner would otherwise walk every document of the namespace for each group).
	const run = (match: string, list: unknown[]) =>
		list.length === 0
			? []
			: db
					.query<T & { g: number }>(
						`SELECT json_extract(c.value, '$[0]') AS g, ${select}
FROM json_each(?1) c
CROSS JOIN knowledge_entity_mentions m
CROSS JOIN knowledge_documents d
WHERE ${match} AND d.published_version_id = m.version_id AND d.state = 'current'
 AND d.namespace = json_extract(c.value, '$[1]')
${tail}`,
					)
					.all(JSON.stringify(list));
	return [
		...run(
			"m.name_key = json_extract(c.value, '$[2]') AND m.name_key <> ''",
			keyed,
		),
		...run("m.entity_id = json_extract(c.value, '$[2]')", solos),
	];
}

/**
 * What the groups' current mentions are, in one read: per group, document (published version),
 * name and type, how many mentions and the first one. Names, types and documents of a node are
 * all summed from these rows.
 */
export function readGraphKeyMentionStatsInSnapshot(
	db: Tx,
	groups: readonly KeyGroup[],
): {
	group: number;
	versionId: number;
	name: string;
	type: string;
	count: number;
	first: number;
}[] {
	if (!Array.isArray(groups)) return invalid();
	return groupRows<{
		version_id: number;
		name: string;
		type: string;
		count: number;
		first: number;
	}>(
		db,
		groups,
		"m.version_id, m.name, m.type, COUNT(*) AS count, MIN(m.entity_id) AS first",
		"GROUP BY g, m.version_id, m.name, m.type",
	).map((r) => ({
		group: r.g,
		versionId: r.version_id,
		name: r.name,
		type: r.type,
		count: r.count,
		first: r.first,
	}));
}

/** The first `n` current mentions (entity id order) of one group. */
export function readGraphKeyFirstMentionsInSnapshot(
	db: Tx,
	group: KeyGroup,
	n: number,
): number[] {
	if (!Number.isSafeInteger(n) || n < 1) return invalid();
	const rows =
		group.solo !== 0
			? db
					.query<{ entity_id: number }>(
						`SELECT m.entity_id FROM knowledge_entity_mentions m ${CURRENT_MENTION_JOIN}
WHERE m.entity_id = ?1 AND d.namespace = ?2`,
					)
					.all(group.solo, group.namespace)
			: db
					.query<{ entity_id: number }>(
						`SELECT m.entity_id FROM knowledge_entity_mentions m CROSS JOIN knowledge_documents d
WHERE m.name_key = ?1 AND m.name_key <> '' AND d.published_version_id = m.version_id
 AND d.state = 'current' AND d.namespace = ?2
ORDER BY m.entity_id LIMIT ?3`,
					)
					.all(group.key, group.namespace, n);
	return rows.map((r) => r.entity_id);
}

export type KeyPair = {
	namespace: string;
	sourceKey: string;
	targetKey: string;
	directed: boolean;
	negated: boolean;
	certainty: GraphRelation["certainty"];
	relation: string;
	versionId: number;
	mentions: number;
	/** The pair's smallest relation ids in the version (at most 3), ascending. */
	firstIds: number[];
};

/**
 * The relation pairs (kg2.md §7.12) of current documents in `namespaces` whose two keys are both
 * among `keys`, read by (source, target) through the pairs' index: a pair with any other key is
 * never read. The caller drops a pair whose key is kept in another namespace only.
 */
export function readGraphKeyPairsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
	keys: readonly string[],
): KeyPair[] {
	if (!Array.isArray(namespaces) || !Array.isArray(keys)) return invalid();
	if (namespaces.length === 0 || keys.length < 2) return [];
	return db
		.query<{
			namespace: string;
			source_key: string;
			target_key: string;
			directed: number;
			negated: number;
			certainty: GraphRelation["certainty"];
			relation: string;
			version_id: number;
			mentions: number;
			first_ids: string;
		}>(
			`SELECT d.namespace, p.source_key, p.target_key, p.directed, p.negated, p.certainty, p.relation,
 p.version_id, p.mentions, p.first_ids
FROM json_each(?1) a CROSS JOIN json_each(?1) b
CROSS JOIN knowledge_relation_pairs p CROSS JOIN knowledge_documents d
WHERE a.value <> b.value AND p.source_key = a.value AND p.target_key = b.value
 AND d.published_version_id = p.version_id AND d.state = 'current'
 AND d.namespace IN (SELECT value FROM json_each(?2))`,
		)
		.all(JSON.stringify([...new Set(keys)]), JSON.stringify(namespaces))
		.map((r) => ({
			namespace: r.namespace,
			sourceKey: r.source_key,
			targetKey: r.target_key,
			directed: r.directed === 1,
			negated: r.negated === 1,
			certainty: r.certainty,
			relation: r.relation,
			versionId: r.version_id,
			mentions: r.mentions,
			firstIds: (JSON.parse(r.first_ids) as number[]).sort((x, y) => x - y),
		}));
}
