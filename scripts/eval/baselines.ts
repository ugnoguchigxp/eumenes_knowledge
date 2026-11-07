// The two baselines of the comparison (p3.md section 6). They live in the evaluation only and
// know nothing of the package's search code.
//
//  - Baseline 1: FTS5 `trigram` alone, over the fragments of the documents (an in-memory index
//    built here, not the package's tables). One literal phrase, NFKC and lower case on both sides,
//    best bm25 first. A query under 3 characters cannot match a trigram index and returns nothing.
//  - Baseline 2: the substring search of Eumenes' collected-document ledger
//    (`api/domains/world/repository/documents.ts`, `searchDocuments`): `instr(lower(title))` or
//    `instr(lower(content))`, `ORDER BY id`, with SQLite's own `lower()` (ASCII only; no NFKC).
//    The SQL is the same text, run on an in-memory table of the ingested documents.
import { Database } from "bun:sqlite";
import { chunkMarkdown } from "../../src/core/index.js";

export const BASELINE_FTS_VERSION = "fts-trigram-fragments@1";
export const BASELINE_LEDGER_VERSION = "world-ledger-instr@1";

export type BaselineDocument = {
	/** What the method returns for a document: the evaluation uses document keys. */
	key: string;
	/** The ledger's `id` column: documents are ordered by it. */
	documentId: string;
	title: string;
	bytes: Uint8Array;
	markdown: string;
};

export interface BaselineIndex {
	/** Document keys in rank order, each once, at most `limit` fragments or documents deep. */
	search(query: string, limit: number): string[];
	close(): void;
}

const phraseOf = (query: string): string | null => {
	const normalized = query.normalize("NFKC").toLowerCase();
	if ([...normalized].length < 3) return null;
	return `"${normalized.replaceAll('"', '""')}"`;
};

/** Baseline 1. */
export function createFtsTrigramBaseline(
	documents: readonly BaselineDocument[],
): BaselineIndex {
	const db = new Database(":memory:");
	db.run("CREATE VIRTUAL TABLE fragments USING fts5(text, tokenize='trigram')");
	const owners: string[] = [];
	const insert = db.prepare("INSERT INTO fragments(rowid, text) VALUES (?, ?)");
	db.transaction(() => {
		for (const document of documents) {
			for (const fragment of chunkMarkdown(document.bytes, document.markdown)) {
				owners.push(document.key);
				insert.run(
					owners.length,
					fragment.text.normalize("NFKC").toLowerCase(),
				);
			}
		}
	})();
	const select = db.prepare(
		"SELECT rowid FROM fragments WHERE fragments MATCH ?1 ORDER BY bm25(fragments), rowid LIMIT ?2",
	);
	return {
		search(query, limit) {
			const phrase = phraseOf(query);
			if (phrase === null) return [];
			const rows = select.all(phrase, limit) as { rowid: number }[];
			return uniqueInOrder(rows.map((row) => owners[row.rowid - 1] as string));
		},
		close: () => db.close(),
	};
}

/** The statement of `searchDocuments`, with the page window replaced by `LIMIT ?2` from the start. */
export const LEDGER_SEARCH_SQL = `SELECT id FROM documents
 WHERE (instr(lower(title), lower(?1))>0 OR instr(lower(content), lower(?1))>0)
 ORDER BY id LIMIT ?2`;

/** Baseline 2. */
export function createLedgerSubstringBaseline(
	documents: readonly BaselineDocument[],
): BaselineIndex {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL)",
	);
	const keys = new Map(documents.map((d) => [d.documentId, d.key]));
	const insert = db.prepare(
		"INSERT INTO documents(id, title, content) VALUES (?, ?, ?)",
	);
	db.transaction(() => {
		for (const d of documents) insert.run(d.documentId, d.title, d.markdown);
	})();
	const select = db.prepare(LEDGER_SEARCH_SQL);
	return {
		search(query, limit) {
			const rows = select.all(query, limit) as { id: string }[];
			return rows.map((row) => keys.get(row.id) ?? `unknown:${row.id}`);
		},
		close: () => db.close(),
	};
}

export function uniqueInOrder<T>(values: readonly T[]): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}
