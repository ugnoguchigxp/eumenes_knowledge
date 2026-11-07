/**
 * The registry's tables, as migrations the host applies in order, each once, in its own migration
 * system and transaction (the host gives them the ids `knowledge-package/0001`, ...). A published
 * migration never changes; a change of the tables is a new entry. Times are epoch milliseconds
 * supplied by the caller.
 */
export const migrations: readonly string[] = [
	`CREATE TABLE knowledge_documents (
 source_namespace TEXT NOT NULL,
 document_id TEXT NOT NULL,
 namespace TEXT NOT NULL,
 path TEXT NOT NULL,
 title TEXT NOT NULL,
 observed_etag TEXT NOT NULL,
 observed_content_digest TEXT NOT NULL,
 observed_markdown_sha256 TEXT NOT NULL,
 applied_markdown_sha256 TEXT,
 applied_byte_length INTEGER CHECK (applied_byte_length IS NULL OR applied_byte_length >= 0),
 state TEXT NOT NULL CHECK (state IN ('current','stale','unavailable','excluded','removed')),
 generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
 ingest_retry INTEGER NOT NULL DEFAULT 0 CHECK (ingest_retry >= 0),
 last_observed_at INTEGER NOT NULL,
 last_verified_at INTEGER,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY (source_namespace, document_id),
 CHECK ((applied_markdown_sha256 IS NULL) = (applied_byte_length IS NULL)),
 CHECK (state <> 'current' OR applied_markdown_sha256 IS NOT NULL)
);
CREATE INDEX knowledge_documents_namespace_state ON knowledge_documents(namespace, state);
CREATE TABLE knowledge_scans (
 scan_id TEXT PRIMARY KEY,
 binding TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('running','complete','failed')),
 pages_settled INTEGER NOT NULL DEFAULT 0 CHECK (pages_settled >= 0),
 documents_queued INTEGER NOT NULL DEFAULT 0 CHECK (documents_queued >= 0),
 error_code TEXT,
 started_at INTEGER NOT NULL,
 finished_at INTEGER
);
CREATE INDEX knowledge_scans_state_finished ON knowledge_scans(state, finished_at);
CREATE TABLE knowledge_scan_pages (
 scan_id TEXT NOT NULL REFERENCES knowledge_scans(scan_id),
 page INTEGER NOT NULL CHECK (page >= 0),
 settled_at INTEGER NOT NULL,
 PRIMARY KEY (scan_id, page)
);`,
];
