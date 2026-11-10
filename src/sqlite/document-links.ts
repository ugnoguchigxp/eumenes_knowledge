import { KnowledgeError, type Tx } from "../contracts/index.js";

/**
 * Reads of the links between documents (kg2.md §7.14, F; `knowledge_document_links`). Links are
 * stored as written; the caller resolves them against the documents' current paths. Only
 * `current` documents and their published versions are read.
 */

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};

/** The links one version records: fragment order, then href. */
export function readVersionLinksInSnapshot(
	db: Tx,
	versionId: number,
): { fragmentOrdinal: number; href: string }[] {
	if (!Number.isSafeInteger(versionId)) return invalid();
	return db
		.query<{ fragment_ordinal: number; href: string }>(
			"SELECT fragment_ordinal, href FROM knowledge_document_links WHERE version_id = ? ORDER BY fragment_ordinal, href",
		)
		.all(versionId)
		.map((r) => ({ fragmentOrdinal: r.fragment_ordinal, href: r.href }));
}

/**
 * The current documents of `namespace` whose stored path is one of `paths` (each compared as
 * written, with a leading `/` and with a leading `./`), with their published versions.
 */
export function readCurrentDocumentsAtPathsInSnapshot(
	db: Tx,
	namespace: string,
	paths: readonly string[],
): { versionId: number; path: string }[] {
	if (typeof namespace !== "string" || !Array.isArray(paths)) return invalid();
	if (paths.length === 0) return [];
	const forms = [...new Set(paths.flatMap((p) => [p, `/${p}`, `./${p}`]))];
	return db
		.query<{ version_id: number; path: string }>(
			`SELECT published_version_id AS version_id, path FROM knowledge_documents
WHERE namespace = ?1 AND state = 'current' AND published_version_id IS NOT NULL
 AND path IN (SELECT value FROM json_each(?2))
ORDER BY path, document_id`,
		)
		.all(namespace, JSON.stringify(forms))
		.map((r) => ({ versionId: r.version_id, path: r.path }));
}

/**
 * The links of current documents of `namespace` whose href's file name is `name` (lower case),
 * with the linking document's path, at most `cap` (`truncated` says more exist). They name
 * files of that name in any folder: the caller resolves each and keeps those to its document.
 */
export function readLinksNamedInSnapshot(
	db: Tx,
	namespace: string,
	name: string,
	cap: number,
): {
	links: {
		versionId: number;
		fragmentOrdinal: number;
		href: string;
		sourcePath: string;
	}[];
	truncated: boolean;
} {
	if (
		typeof namespace !== "string" ||
		typeof name !== "string" ||
		!Number.isSafeInteger(cap) ||
		cap < 1
	)
		return invalid();
	const rows = db
		.query<{
			version_id: number;
			fragment_ordinal: number;
			href: string;
			path: string;
		}>(
			`SELECT l.version_id, l.fragment_ordinal, l.href, d.path
FROM knowledge_document_links l CROSS JOIN knowledge_documents d
WHERE l.target_name = ?1 AND d.published_version_id = l.version_id AND d.state = 'current'
 AND d.namespace = ?2
ORDER BY l.version_id, l.fragment_ordinal, l.href LIMIT ?3`,
		)
		.all(name, namespace, cap + 1);
	return {
		links: rows.slice(0, cap).map((r) => ({
			versionId: r.version_id,
			fragmentOrdinal: r.fragment_ordinal,
			href: r.href,
			sourcePath: r.path,
		})),
		truncated: rows.length > cap,
	};
}

/** How many different hrefs each of `versionIds` records (an index of documents records many). */
export function countVersionLinksInSnapshot(
	db: Tx,
	versionIds: readonly number[],
): Map<number, number> {
	if (!Array.isArray(versionIds)) return invalid();
	if (versionIds.length === 0) return new Map();
	return new Map(
		db
			.query<{ version_id: number; n: number }>(
				`SELECT version_id, COUNT(DISTINCT href) AS n FROM knowledge_document_links
WHERE version_id IN (SELECT value FROM json_each(?1)) GROUP BY version_id`,
			)
			.all(JSON.stringify([...new Set(versionIds)]))
			.map((r) => [r.version_id, r.n] as const),
	);
}

/** The first fragment ordinal of each of `versionIds` that has a fragment. */
export function readFirstOrdinalsInSnapshot(
	db: Tx,
	versionIds: readonly number[],
): Map<number, number> {
	if (!Array.isArray(versionIds)) return invalid();
	if (versionIds.length === 0) return new Map();
	return new Map(
		db
			.query<{ version_id: number; ordinal: number }>(
				`SELECT version_id, MIN(ordinal) AS ordinal FROM knowledge_fragments
WHERE version_id IN (SELECT value FROM json_each(?1)) GROUP BY version_id`,
			)
			.all(JSON.stringify([...new Set(versionIds)]))
			.map((r) => [r.version_id, r.ordinal] as const),
	);
}
