import { createHash } from "node:crypto";
import { KnowledgeError, type Tx } from "../contracts/index.js";
import { MAX_TRANSIENT_RETRY_DELAY_MS } from "./defaults.js";
import {
	bumpLinkGenerationInTransaction,
	isSummarySearchNeededInTransaction,
	recordSummarySearchEmptyInTransaction,
} from "./link-chain.js";

/**
 * Identity links, comparison marks, clusters and summaries (p3.md §8, p0.md #2, #5).
 *
 * The code here narrows candidates and joins links by string equality, full-text matches and
 * graph connectivity only. Whether two mentions are the same entity, and what a summary says,
 * are the model's decisions; this module stores them with their provenance.
 *
 * What may be read: a mention is "current" when it belongs to the published version of a
 * `current` document (stored `current` covers derived `unverified`). Links, clusters and
 * candidates only ever include current mentions, so a retired version's links vanish from every
 * read at once, and cleanup deletes their rows later. Reads here are not limited to a caller's
 * namespaces (the index is one for the host); the package's `readRelated` narrows them.
 */

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};

/** The most mentions a cluster may hold; a larger one is not summarized and is shown truncated. */
export const MAX_CLUSTER_MEMBERS = 500;
/** A cluster with more mentions than this is not summarized (the prompt would grow without bound). */
export const MAX_SUMMARY_MEMBERS = 100;
/** The most mentions `readRelated` starts from (those with a `same` link). */
export const MAX_RELATED_STARTS = 1_000;

export type LinkDecision = "same" | "different" | "unsure";
export type LinkProvenance = {
	model: string | null;
	instructionId: string;
	instructionVersion: number;
};

const normalize = (text: string): string =>
	text.normalize("NFKC").toLowerCase();
const charCount = (text: string): number => [...text].length;

/** A link names its two mentions in this order. */
export function canonicalPair(a: number, b: number): [number, number] {
	if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a === b) {
		return invalid();
	}
	return a < b ? [a, b] : [b, a];
}

const CURRENT_MENTION_JOIN = `JOIN knowledge_documents d ON d.published_version_id = m.version_id AND d.state = 'current'`;

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export type LinkMention = {
	entityId: number;
	versionId: number;
	fragmentOrdinal: number;
	name: string;
	type: string;
	description: string;
};

type RawMention = {
	entity_id: number;
	version_id: number;
	fragment_ordinal: number;
	name: string;
	type: string;
	description: string;
};

const toMention = (r: RawMention): LinkMention => ({
	entityId: r.entity_id,
	versionId: r.version_id,
	fragmentOrdinal: r.fragment_ordinal,
	name: r.name,
	type: r.type,
	description: r.description,
});

const MENTION_COLUMNS =
	"m.entity_id, m.version_id, m.fragment_ordinal, m.name, m.type, m.description";

/** The version is the published one of a `current` document. */
export function isVersionComparableInTransaction(
	db: Tx,
	versionId: number,
): boolean {
	return (
		db
			.query(
				`SELECT 1 AS x FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
WHERE d.published_version_id = ? AND d.state = 'current'`,
			)
			.get(versionId) !== null
	);
}

/** Up to `limit` mentions of the version with an id above `afterEntityId`, in id order. */
export function listMentionsAfterInTransaction(
	db: Tx,
	versionId: number,
	afterEntityId: number,
	limit: number,
): LinkMention[] {
	if (!Number.isSafeInteger(limit) || limit < 1) return invalid();
	return db
		.query<RawMention>(
			`SELECT ${MENTION_COLUMNS} FROM knowledge_entity_mentions m
WHERE m.version_id = ? AND m.entity_id > ? ORDER BY m.entity_id LIMIT ?`,
		)
		.all(versionId, afterEntityId, limit)
		.map(toMention);
}

export function hasMentionsAfterInTransaction(
	db: Tx,
	versionId: number,
	afterEntityId: number,
): boolean {
	return (
		db
			.query(
				"SELECT 1 AS x FROM knowledge_entity_mentions WHERE version_id = ? AND entity_id > ? LIMIT 1",
			)
			.get(versionId, afterEntityId) !== null
	);
}

/** One current mention with its document, or null when it is gone or not current. */
export function getCurrentMentionInTransaction(
	db: Tx,
	entityId: number,
): (LinkMention & { sourceNamespace: string; documentId: string }) | null {
	const r = db
		.query<RawMention & { source_namespace: string; document_id: string }>(
			`SELECT ${MENTION_COLUMNS}, d.source_namespace, d.document_id
FROM knowledge_entity_mentions m ${CURRENT_MENTION_JOIN} WHERE m.entity_id = ?`,
		)
		.get(entityId);
	return r
		? {
				...toMention(r),
				sourceNamespace: r.source_namespace,
				documentId: r.document_id,
			}
		: null;
}

/**
 * The quotations of a mention's evidence, cut from the fragment text by the stored byte range
 * (each at most `maxChars` characters, in the order they were given).
 */
export function readMentionQuotesInTransaction(
	db: Tx,
	entityId: number,
	maxChars: number,
): string[] {
	const rows = db
		.query<{
			byte_start: number;
			byte_end: number;
			fragment_start: number;
			text: string;
		}>(
			`SELECT e.byte_start, e.byte_end, f.byte_start AS fragment_start, f.text
FROM knowledge_evidence e
JOIN knowledge_entity_mentions m ON m.entity_id = e.subject_id
JOIN knowledge_fragments f ON f.version_id = e.version_id AND f.ordinal = e.fragment_ordinal
WHERE e.subject_kind = 'entity' AND e.subject_id = ? AND m.version_id = e.version_id
ORDER BY e.position`,
		)
		.all(entityId);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
	const out: string[] = [];
	for (const r of rows) {
		const bytes = encoder.encode(r.text);
		const from = r.byte_start - r.fragment_start;
		const to = r.byte_end - r.fragment_start;
		if (from < 0 || to > bytes.length || to <= from) continue;
		out.push(
			[...decoder.decode(bytes.subarray(from, to))].slice(0, maxChars).join(""),
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Candidates (mechanical: normalized-name equality, then the mention full-text index)
// ---------------------------------------------------------------------------

export type LinkCandidate = LinkMention & {
	sourceNamespace: string;
	documentId: string;
};

const NOT_DECIDED = `NOT EXISTS (SELECT 1 FROM knowledge_entity_links l
  WHERE l.entity_a = MIN(?1, m.entity_id) AND l.entity_b = MAX(?1, m.entity_id))`;

/**
 * Candidates to compare with one current mention: mentions of other documents' published
 * versions of `current` documents (any namespace: the index is the host's, and what a caller
 * sees is narrowed when reading) whose normalized name equals the mention's, then those the
 * mention full-text index finds for the name as one phrase (best bm25 first, ids breaking ties).
 * A pair that already has a decision is never returned. At most `limit`; empty when the mention
 * is not current.
 */
export function readLinkCandidatesInTransaction(
	db: Tx,
	entityId: number,
	limit: number,
): LinkCandidate[] {
	if (!Number.isSafeInteger(limit) || limit < 1) return invalid();
	const self = db
		.query<{
			name_norm: string;
			name: string;
			source_namespace: string;
			document_id: string;
		}>(
			`SELECT m.name_norm, m.name, d.source_namespace, d.document_id
FROM knowledge_entity_mentions m ${CURRENT_MENTION_JOIN} WHERE m.entity_id = ?`,
		)
		.get(entityId);
	if (!self) return [];
	const normName =
		self.name_norm !== "" ? self.name_norm : normalize(self.name);
	if (normName === "") return [];
	const picked = new Map<number, LinkCandidate>();
	const take = (
		rows: (RawMention & { source_namespace: string; document_id: string })[],
	) => {
		for (const r of rows) {
			if (picked.size >= limit) return;
			if (picked.has(r.entity_id)) continue;
			picked.set(r.entity_id, {
				...toMention(r),
				sourceNamespace: r.source_namespace,
				documentId: r.document_id,
			});
		}
	};
	const columns = `${MENTION_COLUMNS}, d.source_namespace, d.document_id`;
	const others = `m.entity_id <> ?1 AND NOT (d.source_namespace = ?2 AND d.document_id = ?3) AND ${NOT_DECIDED}`;
	take(
		db
			.query<RawMention & { source_namespace: string; document_id: string }>(
				`SELECT ${columns} FROM knowledge_entity_mentions m ${CURRENT_MENTION_JOIN}
WHERE m.name_norm = ?4 AND ${others} ORDER BY m.entity_id LIMIT ?5`,
			)
			.all(entityId, self.source_namespace, self.document_id, normName, limit),
	);
	if (picked.size < limit && charCount(normName) >= 3) {
		const phrase = `"${normName.replaceAll('"', '""')}"`;
		take(
			db
				.query<RawMention & { source_namespace: string; document_id: string }>(
					`SELECT ${columns} FROM knowledge_entity_fts
JOIN knowledge_entity_mentions m ON m.entity_id = knowledge_entity_fts.rowid ${CURRENT_MENTION_JOIN}
WHERE knowledge_entity_fts MATCH ?4 AND ${others}
ORDER BY bm25(knowledge_entity_fts), m.entity_id LIMIT ?5`,
				)
				.all(
					entityId,
					self.source_namespace,
					self.document_id,
					phrase,
					limit + picked.size,
				),
		);
	}
	return [...picked.values()];
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Store the decisions about the pairs (`entityId`, `otherId`), each pair in canonical order.
 * A pair that already has a decision keeps it; a pair of a mention that is gone is skipped.
 * Returns how many rows were added.
 */
export function recordLinkDecisionsInTransaction(
	db: Tx,
	items: readonly {
		entityId: number;
		otherId: number;
		decision: LinkDecision;
	}[],
	provenance: LinkProvenance,
	now: number,
): number {
	if (
		!Number.isFinite(now) ||
		typeof provenance.instructionId !== "string" ||
		!Number.isSafeInteger(provenance.instructionVersion) ||
		provenance.instructionVersion < 1
	) {
		return invalid();
	}
	const version = db.query<{ version_id: number }>(
		"SELECT version_id FROM knowledge_entity_mentions WHERE entity_id = ?",
	);
	const insert = db.query(
		`INSERT OR IGNORE INTO knowledge_entity_links (
 entity_a, entity_b, version_a, version_b, decision, model, instruction_id, instruction_version, decided_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let added = 0;
	let sameAdded = false;
	for (const item of items) {
		if (
			item.decision !== "same" &&
			item.decision !== "different" &&
			item.decision !== "unsure"
		) {
			return invalid();
		}
		const [a, b] = canonicalPair(item.entityId, item.otherId);
		const va = version.get(a)?.version_id;
		const vb = version.get(b)?.version_id;
		if (va === undefined || vb === undefined) continue;
		const changes = insert.run(
			a,
			b,
			va,
			vb,
			item.decision,
			provenance.model,
			provenance.instructionId,
			provenance.instructionVersion,
			now,
		).changes;
		added += changes;
		if (changes > 0 && item.decision === "same") sameAdded = true;
	}
	if (sameAdded) bumpLinkGenerationInTransaction(db);
	return added;
}

// ---------------------------------------------------------------------------
// Which versions were compared
// ---------------------------------------------------------------------------

export type LinkVersionRow = {
	versionId: number;
	state: "partial" | "done";
	cursorEntityId: number;
	failedMentions: number;
	notBefore: number;
	transientFailures: number;
	/** Recorded steps so far; a link that made progress has raised it. */
	steps: number;
};

export function getLinkVersionInTransaction(
	db: Tx,
	versionId: number,
): LinkVersionRow | null {
	const r = db
		.query<{
			version_id: number;
			state: "partial" | "done";
			cursor_entity_id: number;
			failed_mentions: number;
			not_before: number;
			transient_failures: number;
			steps: number;
		}>("SELECT * FROM knowledge_link_versions WHERE version_id = ?")
		.get(versionId);
	return r
		? {
				versionId: r.version_id,
				state: r.state,
				cursorEntityId: r.cursor_entity_id,
				failedMentions: r.failed_mentions,
				notBefore: r.not_before,
				transientFailures: r.transient_failures,
				steps: r.steps,
			}
		: null;
}

/**
 * The published version of a `current` document that was not compared yet (no mark, or a
 * partial one that is not waiting for a retry time ahead of `now`), oldest version first.
 */
export function pickVersionToCompareInTransaction(
	db: Tx,
	now: number,
): number | null {
	if (!Number.isFinite(now)) return invalid();
	return (
		db
			.query<{ version_id: number }>(
				`SELECT v.version_id FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
LEFT JOIN knowledge_link_versions lv ON lv.version_id = v.version_id
WHERE d.state = 'current' AND (lv.version_id IS NULL OR (lv.state = 'partial' AND lv.not_before <= ?))
ORDER BY v.version_id LIMIT 1`,
			)
			.get(now)?.version_id ?? null
	);
}

/**
 * Record that the mentions of `versionId` up to `cursorEntityId` were handled, `failed` of them
 * without a usable answer. Creates the row; a `done` row is left as it is. Clears a wait.
 */
export function advanceLinkVersionInTransaction(
	db: Tx,
	versionId: number,
	progress: { cursorEntityId: number; failed: number },
	instruction: { id: string; version: number },
	now: number,
): void {
	if (
		!Number.isSafeInteger(versionId) ||
		!Number.isSafeInteger(progress.cursorEntityId) ||
		progress.cursorEntityId < 0 ||
		!Number.isSafeInteger(progress.failed) ||
		progress.failed < 0 ||
		!Number.isFinite(now)
	) {
		return invalid();
	}
	db.query(
		`INSERT INTO knowledge_link_versions (
 version_id, state, cursor_entity_id, failed_mentions, steps, instruction_id, instruction_version, updated_at
) VALUES (?1, 'partial', ?2, ?3, 1, ?4, ?5, ?6)
ON CONFLICT(version_id) DO UPDATE SET
 cursor_entity_id = MAX(cursor_entity_id, excluded.cursor_entity_id),
 failed_mentions = failed_mentions + excluded.failed_mentions,
 steps = steps + 1,
 not_before = 0, transient_failures = 0, updated_at = excluded.updated_at
WHERE state = 'partial'`,
	).run(
		versionId,
		progress.cursorEntityId,
		progress.failed,
		instruction.id,
		instruction.version,
		now,
	);
}

/**
 * Mark the version compared: it must still be the published version of a `current` document and
 * have no mention above the recorded cursor. False (nothing written) otherwise.
 */
export function markLinkVersionDoneInTransaction(
	db: Tx,
	versionId: number,
	instruction: { id: string; version: number },
	now: number,
): boolean {
	if (!isVersionComparableInTransaction(db, versionId)) return false;
	advanceLinkVersionInTransaction(
		db,
		versionId,
		{ cursorEntityId: 0, failed: 0 },
		instruction,
		now,
	);
	return (
		db
			.query(
				`UPDATE knowledge_link_versions SET state = 'done', updated_at = ?2
WHERE version_id = ?1 AND state = 'partial'
 AND NOT EXISTS (SELECT 1 FROM knowledge_entity_mentions m
  WHERE m.version_id = ?1 AND m.entity_id > knowledge_link_versions.cursor_entity_id)`,
			)
			.run(versionId, now).changes === 1
	);
}

/**
 * A document went back to `current` with the version it had (it was `unavailable` or `stale`):
 * while it was away, versions compared by others could not name its mentions as candidates, so
 * the version is compared again from the start. Pairs that already have a decision are not
 * asked again, so this only adds the questions that were never put. Nothing is written for a
 * version that was never compared.
 */
export function reopenLinkVersionInTransaction(
	db: Tx,
	versionId: number,
	now: number,
): boolean {
	return (
		db
			.query(
				`UPDATE knowledge_link_versions SET state = 'partial', cursor_entity_id = 0,
 failed_mentions = 0, not_before = 0, transient_failures = 0, updated_at = ?2
WHERE version_id = ?1 AND (state = 'done' OR cursor_entity_id <> 0)`,
			)
			.run(versionId, now).changes === 1
	);
}

function waitDelay(failures: number, baseDelayMs: number): number {
	return Math.min(
		baseDelayMs * 2 ** Math.min(failures, 30),
		Math.max(baseDelayMs, MAX_TRANSIENT_RETRY_DELAY_MS),
	);
}

/**
 * A comparison ended for a temporary reason: the version is not picked before `now + delay`
 * (the base doubled for each consecutive failure). Nothing about the content is counted.
 */
export function recordLinkVersionWaitInTransaction(
	db: Tx,
	versionId: number,
	instruction: { id: string; version: number },
	now: number,
	baseDelayMs: number,
): boolean {
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(baseDelayMs) ||
		baseDelayMs < 0
	) {
		return invalid();
	}
	if (!isVersionComparableInTransaction(db, versionId)) return false;
	db.query(
		`INSERT OR IGNORE INTO knowledge_link_versions (
 version_id, state, cursor_entity_id, instruction_id, instruction_version, updated_at
) VALUES (?, 'partial', 0, ?, ?, ?)`,
	).run(versionId, instruction.id, instruction.version, now);
	const row = getLinkVersionInTransaction(db, versionId);
	if (!row || row.state !== "partial") return false;
	db.query(
		`UPDATE knowledge_link_versions SET not_before = ?2, transient_failures = transient_failures + 1,
 updated_at = ?3 WHERE version_id = ?1`,
	).run(
		versionId,
		Math.floor(now + waitDelay(row.transientFailures, baseDelayMs)),
		now,
	);
	return true;
}

/** Whether any published version of a `current` document is waiting to be compared now. */
export function hasVersionToCompareInTransaction(db: Tx, now: number): boolean {
	return pickVersionToCompareInTransaction(db, now) !== null;
}

/**
 * Published versions of `current` documents in `namespaces` that were not compared yet,
 * whatever their wait.
 */
export function countUncomparedVersionsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): number {
	if (!Array.isArray(namespaces)) return invalid();
	if (namespaces.length === 0) return 0;
	return (
		db
			.query<{ n: number }>(
				`SELECT COUNT(*) AS n FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
LEFT JOIN knowledge_link_versions lv ON lv.version_id = v.version_id
WHERE d.state = 'current' AND d.namespace IN (SELECT value FROM json_each(?))
 AND (lv.version_id IS NULL OR lv.state <> 'done')`,
			)
			.get(JSON.stringify(namespaces))?.n ?? 0
	);
}

/**
 * Published versions of `current` documents in `namespaces` with mentions that got no usable
 * answer (an invalid answer is not asked again, so the comparison of those mentions is missing).
 */
export function countVersionsWithFailedMentionsInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): number {
	if (!Array.isArray(namespaces)) return invalid();
	if (namespaces.length === 0) return 0;
	return (
		db
			.query<{ n: number }>(
				`SELECT COUNT(*) AS n FROM knowledge_documents d
JOIN knowledge_versions v ON v.version_id = d.published_version_id AND v.state = 'published'
JOIN knowledge_link_versions lv ON lv.version_id = v.version_id
WHERE d.state = 'current' AND d.namespace IN (SELECT value FROM json_each(?))
 AND lv.failed_mentions > 0`,
			)
			.get(JSON.stringify(namespaces))?.n ?? 0
	);
}

// ---------------------------------------------------------------------------
// Clusters: connected components of `same` links among current mentions
// ---------------------------------------------------------------------------

export type ClusterMember = {
	entityId: number;
	versionId: number;
	sourceNamespace: string;
	documentId: string;
	namespace: string;
	path: string;
	title: string;
	markdownSha256: string;
	lastVerifiedAt: number | null;
	fragmentOrdinal: number;
	name: string;
	type: string;
	description: string;
};

export type SameLink = {
	/** Canonical order: `a < b`. */
	a: number;
	b: number;
	provenance: LinkProvenance;
	decidedAt: number;
};

export type Cluster = {
	/** In ascending entity id order. */
	members: ClusterMember[];
	links: SameLink[];
	/** The cluster is larger than `cap`: only the first members found are listed. */
	truncated: boolean;
};

type RawMember = RawMention & {
	source_namespace: string;
	document_id: string;
	namespace: string;
	path: string;
	title: string;
	markdown_sha256: string;
	last_verified_at: number | null;
};

const MEMBER_COLUMNS = `${MENTION_COLUMNS}, d.source_namespace, d.document_id, d.namespace, d.path, d.title,
 v.markdown_sha256, d.last_verified_at`;
const MEMBER_JOIN = `${CURRENT_MENTION_JOIN}
JOIN knowledge_versions v ON v.version_id = m.version_id`;

const toMember = (r: RawMember): ClusterMember => ({
	...toMention(r),
	sourceNamespace: r.source_namespace,
	documentId: r.document_id,
	namespace: r.namespace,
	path: r.path,
	title: r.title,
	markdownSha256: r.markdown_sha256,
	lastVerifiedAt: r.last_verified_at,
});

/**
 * The cluster of a current mention: every current mention reachable through `same` links whose
 * both ends are current. Empty when the mention is not current. At most `cap` members; a larger
 * cluster is cut (`truncated`), keeping the first ones found breadth first.
 *
 * With `namespaces`, only mentions of documents in those namespaces take part: the links are
 * followed through them alone, the cap counts them alone, and a mention outside never connects
 * two inside (nothing about the outside shows in the result). Empty when the seed is outside.
 */
export function readSameClusterInTransaction(
	db: Tx,
	entityId: number,
	cap: number = MAX_CLUSTER_MEMBERS,
	namespaces?: readonly string[],
): Cluster {
	if (
		!Number.isSafeInteger(entityId) ||
		!Number.isSafeInteger(cap) ||
		cap < 1 ||
		(namespaces !== undefined && !Array.isArray(namespaces))
	) {
		return invalid();
	}
	const scope = namespaces === undefined ? null : JSON.stringify(namespaces);
	const seed = db
		.query<RawMember>(
			`SELECT ${MEMBER_COLUMNS} FROM knowledge_entity_mentions m ${MEMBER_JOIN}
WHERE m.entity_id = ?1 AND (?2 IS NULL OR d.namespace IN (SELECT value FROM json_each(?2)))`,
		)
		.get(entityId, scope);
	if (!seed) return { members: [], links: [], truncated: false };
	const members = new Map<number, ClusterMember>([[entityId, toMember(seed)]]);
	const links = new Map<string, SameLink>();
	const neighbors = db.query<
		RawMember & {
			link_a: number;
			link_b: number;
			model: string | null;
			instruction_id: string;
			instruction_version: number;
			decided_at: number;
		}
	>(
		`SELECT ${MEMBER_COLUMNS}, l.entity_a AS link_a, l.entity_b AS link_b, l.model, l.instruction_id,
 l.instruction_version, l.decided_at
FROM knowledge_entity_links l
JOIN knowledge_entity_mentions m ON m.entity_id = CASE WHEN l.entity_a = ?1 THEN l.entity_b ELSE l.entity_a END
${MEMBER_JOIN}
WHERE l.decision = 'same' AND (l.entity_a = ?1 OR l.entity_b = ?1)
 AND (?2 IS NULL OR d.namespace IN (SELECT value FROM json_each(?2)))
ORDER BY m.entity_id`,
	);
	let truncated = false;
	const queue = [entityId];
	const pending: SameLink[] = [];
	for (let i = 0; i < queue.length; i++) {
		for (const r of neighbors.all(queue[i] as number, scope)) {
			const link: SameLink = {
				a: r.link_a,
				b: r.link_b,
				provenance: {
					model: r.model,
					instructionId: r.instruction_id,
					instructionVersion: r.instruction_version,
				},
				decidedAt: r.decided_at,
			};
			pending.push(link);
			if (members.has(r.entity_id)) continue;
			if (members.size >= cap) {
				truncated = true;
				continue;
			}
			members.set(r.entity_id, toMember(r));
			queue.push(r.entity_id);
		}
	}
	for (const link of pending) {
		if (members.has(link.a) && members.has(link.b)) {
			links.set(`${link.a}:${link.b}`, link);
		}
	}
	return {
		members: [...members.values()].sort((x, y) => x.entityId - y.entityId),
		links: [...links.values()].sort((x, y) => x.a - y.a || x.b - y.b),
		truncated,
	};
}

/**
 * Entity ids of the version's mentions that have a `same` link, in id order, at most `limit`
 * (the answer says when more exist). Only these can start a cluster with two or more members.
 */
export function listLinkedMentionIdsInSnapshot(
	db: Tx,
	versionId: number,
	limit: number,
): { entityIds: number[]; truncated: boolean } {
	if (!Number.isSafeInteger(limit) || limit < 1) return invalid();
	const ids = db
		.query<{ entity_id: number }>(
			`SELECT m.entity_id FROM knowledge_entity_mentions m
WHERE m.version_id = ?1 AND (
 EXISTS (SELECT 1 FROM knowledge_entity_links l WHERE l.entity_a = m.entity_id AND l.decision = 'same')
 OR EXISTS (SELECT 1 FROM knowledge_entity_links l WHERE l.entity_b = m.entity_id AND l.decision = 'same'))
ORDER BY m.entity_id LIMIT ?2`,
		)
		.all(versionId, limit + 1)
		.map((r) => r.entity_id);
	return { entityIds: ids.slice(0, limit), truncated: ids.length > limit };
}

/** Digest of a cluster: sha256 of the sorted member ids. A different cluster has a different digest. */
export function clusterDigest(entityIds: readonly number[]): string {
	return createHash("sha256")
		.update([...entityIds].sort((x, y) => x - y).join(","))
		.digest("hex");
}

export type ClusterSummaryCandidate = {
	anchorEntityId: number;
	memberIds: number[];
	digest: string;
};

/**
 * Every cluster of two or more current mentions (union-find over the `same` links whose ends are
 * both current), with the documents they span. Clusters over `MAX_CLUSTER_MEMBERS` are left out.
 */
export function listSameClustersInTransaction(
	db: Tx,
): { memberIds: number[]; documents: number }[] {
	const rows = db
		.query<{ a: number; b: number; doc_a: string; doc_b: string }>(
			`SELECT l.entity_a AS a, l.entity_b AS b, da.document_id AS doc_a, dbb.document_id AS doc_b
FROM knowledge_entity_links l
JOIN knowledge_entity_mentions ma ON ma.entity_id = l.entity_a
JOIN knowledge_documents da ON da.published_version_id = ma.version_id AND da.state = 'current'
JOIN knowledge_entity_mentions mb ON mb.entity_id = l.entity_b
JOIN knowledge_documents dbb ON dbb.published_version_id = mb.version_id AND dbb.state = 'current'
WHERE l.decision = 'same'`,
		)
		.all();
	const parent = new Map<number, number>();
	const docOf = new Map<number, string>();
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root) as number;
		let node = x;
		while (parent.get(node) !== root) {
			const next = parent.get(node) as number;
			parent.set(node, root);
			node = next;
		}
		return root;
	};
	for (const r of rows) {
		for (const id of [r.a, r.b]) if (!parent.has(id)) parent.set(id, id);
		docOf.set(r.a, r.doc_a);
		docOf.set(r.b, r.doc_b);
		const ra = find(r.a);
		const rb = find(r.b);
		if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
	}
	const groups = new Map<number, number[]>();
	for (const id of parent.keys()) {
		const root = find(id);
		const list = groups.get(root);
		if (list) list.push(id);
		else groups.set(root, [id]);
	}
	return [...groups.values()]
		.filter((ids) => ids.length <= MAX_CLUSTER_MEMBERS)
		.map((ids) => ({
			memberIds: ids.sort((x, y) => x - y),
			documents: new Set(ids.map((id) => docOf.get(id))).size,
		}))
		.sort((x, y) => (x.memberIds[0] as number) - (y.memberIds[0] as number));
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/**
 * The first cluster that needs a summary: it spans two or more documents and holds
 * `minMentions` or more mentions, and its anchor has no row for the cluster's current digest
 * (an `ok` or `failed` row for the digest settles it; a `waiting` one only until its time).
 */
export function pickSummaryWorkInTransaction(
	db: Tx,
	options: { minMentions: number; now: number; maxMentions?: number },
): ClusterSummaryCandidate | null {
	if (
		!Number.isSafeInteger(options.minMentions) ||
		options.minMentions < 2 ||
		!Number.isFinite(options.now)
	) {
		return invalid();
	}
	// Reading every link of the host is done only after something changed since the last search
	// that found nothing (a link added, a document that became or stopped being current, cleanup),
	// or when a waiting summary comes due.
	const key = `${options.minMentions}:${options.maxMentions ?? MAX_CLUSTER_MEMBERS}`;
	if (!isSummarySearchNeededInTransaction(db, key, options.now)) return null;
	let recheckAt: number | null = null;
	const row = db.query<{
		members_digest: string;
		status: "ok" | "failed" | "waiting";
		not_before: number;
	}>(
		"SELECT members_digest, status, not_before FROM knowledge_entity_summaries WHERE anchor_entity_id = ?",
	);
	for (const cluster of listSameClustersInTransaction(db)) {
		if (
			cluster.documents < 2 ||
			cluster.memberIds.length < options.minMentions ||
			cluster.memberIds.length > (options.maxMentions ?? MAX_CLUSTER_MEMBERS)
		) {
			continue;
		}
		const digest = clusterDigest(cluster.memberIds);
		const anchor = cluster.memberIds[0] as number;
		const existing = row.get(anchor);
		if (existing && existing.members_digest === digest) {
			if (existing.status !== "waiting" || existing.not_before > options.now) {
				if (existing.status === "waiting") {
					recheckAt =
						recheckAt === null
							? existing.not_before
							: Math.min(recheckAt, existing.not_before);
				}
				continue;
			}
		}
		return { anchorEntityId: anchor, memberIds: cluster.memberIds, digest };
	}
	recordSummarySearchEmptyInTransaction(db, key, recheckAt);
	return null;
}

export type StoredSummary = {
	summary: string;
	model: string | null;
	instructionId: string;
	instructionVersion: number;
	createdAt: number;
};

/** The summary made for exactly this cluster digest; null for any other state. */
export function readSummaryInSnapshot(
	db: Tx,
	anchorEntityId: number,
	digest: string,
): StoredSummary | null {
	const r = db
		.query<{
			summary: string;
			model: string | null;
			instruction_id: string;
			instruction_version: number;
			created_at: number;
		}>(
			`SELECT summary, model, instruction_id, instruction_version, created_at
FROM knowledge_entity_summaries
WHERE anchor_entity_id = ? AND members_digest = ? AND status = 'ok'`,
		)
		.get(anchorEntityId, digest);
	return r
		? {
				summary: r.summary,
				model: r.model,
				instructionId: r.instruction_id,
				instructionVersion: r.instruction_version,
				createdAt: r.created_at,
			}
		: null;
}

/** The anchor is the cluster's smallest id and the digest is the cluster as it is now. */
function clusterMatches(db: Tx, anchor: number, digest: string): boolean {
	const cluster = readSameClusterInTransaction(db, anchor);
	if (cluster.truncated || cluster.members.length === 0) return false;
	const ids = cluster.members.map((m) => m.entityId);
	return ids[0] === anchor && clusterDigest(ids) === digest;
}

function anchorVersion(db: Tx, anchor: number): number | null {
	return (
		db
			.query<{ version_id: number }>(
				"SELECT version_id FROM knowledge_entity_mentions WHERE entity_id = ?",
			)
			.get(anchor)?.version_id ?? null
	);
}

/**
 * Store the summary of the cluster `digest` anchored at `anchorEntityId`, replacing that
 * anchor's earlier row. Writes nothing and returns false unless the cluster is still exactly
 * the one the summary was made for.
 */
export function storeSummaryInTransaction(
	db: Tx,
	input: {
		anchorEntityId: number;
		digest: string;
		summary: string;
		provenance: LinkProvenance;
	},
	now: number,
): boolean {
	if (!Number.isFinite(now) || input.summary.length === 0) return invalid();
	if (!clusterMatches(db, input.anchorEntityId, input.digest)) return false;
	const versionId = anchorVersion(db, input.anchorEntityId);
	if (versionId === null) return false;
	db.query(
		`INSERT OR REPLACE INTO knowledge_entity_summaries (
 anchor_entity_id, anchor_version_id, members_digest, status, summary, model, instruction_id,
 instruction_version, not_before, transient_failures, created_at
) VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, 0, 0, ?)`,
	).run(
		input.anchorEntityId,
		versionId,
		input.digest,
		input.summary,
		input.provenance.model,
		input.provenance.instructionId,
		input.provenance.instructionVersion,
		now,
	);
	return true;
}

/** The model's answer for this cluster was invalid: it is not asked again until the cluster changes. */
export function recordSummaryFailureInTransaction(
	db: Tx,
	input: { anchorEntityId: number; digest: string },
	instruction: { id: string; version: number },
	now: number,
): boolean {
	if (!Number.isFinite(now)) return invalid();
	if (!clusterMatches(db, input.anchorEntityId, input.digest)) return false;
	const versionId = anchorVersion(db, input.anchorEntityId);
	if (versionId === null) return false;
	db.query(
		`INSERT OR REPLACE INTO knowledge_entity_summaries (
 anchor_entity_id, anchor_version_id, members_digest, status, summary, model, instruction_id,
 instruction_version, not_before, transient_failures, created_at
) VALUES (?, ?, ?, 'failed', NULL, NULL, ?, ?, 0, 0, ?)`,
	).run(
		input.anchorEntityId,
		versionId,
		input.digest,
		instruction.id,
		instruction.version,
		now,
	);
	return true;
}

/** A summary ended for a temporary reason: the cluster is not picked before `now + delay`. */
export function recordSummaryWaitInTransaction(
	db: Tx,
	input: { anchorEntityId: number; digest: string },
	instruction: { id: string; version: number },
	now: number,
	baseDelayMs: number,
): boolean {
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(baseDelayMs) ||
		baseDelayMs < 0
	) {
		return invalid();
	}
	if (!clusterMatches(db, input.anchorEntityId, input.digest)) return false;
	const versionId = anchorVersion(db, input.anchorEntityId);
	if (versionId === null) return false;
	const earlier = db
		.query<{ members_digest: string; transient_failures: number }>(
			"SELECT members_digest, transient_failures FROM knowledge_entity_summaries WHERE anchor_entity_id = ?",
		)
		.get(input.anchorEntityId);
	const failures =
		earlier && earlier.members_digest === input.digest
			? earlier.transient_failures
			: 0;
	db.query(
		`INSERT OR REPLACE INTO knowledge_entity_summaries (
 anchor_entity_id, anchor_version_id, members_digest, status, summary, model, instruction_id,
 instruction_version, not_before, transient_failures, created_at
) VALUES (?, ?, ?, 'waiting', NULL, NULL, ?, ?, ?, ?, ?)`,
	).run(
		input.anchorEntityId,
		versionId,
		input.digest,
		instruction.id,
		instruction.version,
		Math.floor(now + waitDelay(failures, baseDelayMs)),
		failures + 1,
		now,
	);
	return true;
}

// ---------------------------------------------------------------------------
// Reads for related documents
// ---------------------------------------------------------------------------

export type EvidencePoint = {
	fragmentOrdinal: number;
	byteStart: number;
	byteEnd: number;
	quoteSha256: string;
};

/** The evidence ranges of an entity mention, in the order they were given. */
export function readEntityEvidenceInSnapshot(
	db: Tx,
	entityId: number,
): EvidencePoint[] {
	return db
		.query<{
			fragment_ordinal: number;
			byte_start: number;
			byte_end: number;
			quote_sha256: string;
		}>(
			`SELECT fragment_ordinal, byte_start, byte_end, quote_sha256 FROM knowledge_evidence
WHERE subject_kind = 'entity' AND subject_id = ? ORDER BY position`,
		)
		.all(entityId)
		.map((r) => ({
			fragmentOrdinal: r.fragment_ordinal,
			byteStart: r.byte_start,
			byteEnd: r.byte_end,
			quoteSha256: r.quote_sha256,
		}));
}

/** Whether any pair of current mentions in `namespaces` has the decision `unsure`. */
export function hasUnsureLinkInSnapshot(
	db: Tx,
	namespaces: readonly string[],
): boolean {
	if (!Array.isArray(namespaces)) return invalid();
	if (namespaces.length === 0) return false;
	return (
		db
			.query(
				`SELECT 1 AS x FROM knowledge_entity_links l
JOIN knowledge_entity_mentions ma ON ma.entity_id = l.entity_a
JOIN knowledge_documents da ON da.published_version_id = ma.version_id AND da.state = 'current'
JOIN knowledge_entity_mentions mb ON mb.entity_id = l.entity_b
JOIN knowledge_documents dbb ON dbb.published_version_id = mb.version_id AND dbb.state = 'current'
WHERE l.decision = 'unsure'
 AND da.namespace IN (SELECT value FROM json_each(?1)) AND dbb.namespace IN (SELECT value FROM json_each(?1))
LIMIT 1`,
			)
			.get(JSON.stringify(namespaces)) !== null
	);
}

// ---------------------------------------------------------------------------
// Cleanup (called by `cleanupInTransaction`)
// ---------------------------------------------------------------------------

/**
 * Delete, within `budget` rows, the links that name a mention of `versionId`, the version's
 * comparison mark and the summaries anchored at one of its mentions. Returns the rows deleted.
 */
export function deleteLinkRowsInTransaction(
	db: Tx,
	versionId: number,
	budget: number,
): number {
	let left = budget;
	if (left > 0) {
		const links = db
			.query(
				`DELETE FROM knowledge_entity_links WHERE (entity_a, entity_b) IN (
 SELECT entity_a, entity_b FROM knowledge_entity_links WHERE version_a = ?1 OR version_b = ?1 LIMIT ?2)`,
			)
			.run(versionId, left).changes;
		left -= links;
		if (links > 0) bumpLinkGenerationInTransaction(db);
	}
	if (left > 0) {
		left -= db
			.query(
				"DELETE FROM knowledge_entity_summaries WHERE anchor_entity_id IN (SELECT anchor_entity_id FROM knowledge_entity_summaries WHERE anchor_version_id = ? LIMIT ?)",
			)
			.run(versionId, left).changes;
	}
	if (left > 0) {
		left -= db
			.query("DELETE FROM knowledge_link_versions WHERE version_id = ?")
			.run(versionId).changes;
	}
	return budget - left;
}

export function hasLinkRowsInTransaction(db: Tx, versionId: number): boolean {
	return (
		db
			.query(
				`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM knowledge_entity_links WHERE version_a = ?1 OR version_b = ?1)
 OR EXISTS (SELECT 1 FROM knowledge_entity_summaries WHERE anchor_version_id = ?1)
 OR EXISTS (SELECT 1 FROM knowledge_link_versions WHERE version_id = ?1)`,
			)
			.get(versionId) !== null
	);
}
