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
	// P2: versions, fragments, indexes, vectors, mentions, evidence and the ingest chain.
	// Everything derived hangs off `version_id`; a document reads only its `published_version_id`.
	`ALTER TABLE knowledge_documents ADD COLUMN published_version_id INTEGER;
-- Not picked before this time (epoch ms): set after a temporary ingest failure (p2.md 3).
ALTER TABLE knowledge_documents ADD COLUMN ingest_not_before INTEGER NOT NULL DEFAULT 0 CHECK (ingest_not_before >= 0);
-- Consecutive temporary failures of the observed version; the next delay doubles with it.
ALTER TABLE knowledge_documents ADD COLUMN transient_failures INTEGER NOT NULL DEFAULT 0 CHECK (transient_failures >= 0);
-- An ingest read another version: not picked again until the next observation of the document.
ALTER TABLE knowledge_documents ADD COLUMN superseded_at INTEGER;
CREATE INDEX knowledge_documents_published ON knowledge_documents(published_version_id) WHERE published_version_id IS NOT NULL;
CREATE INDEX knowledge_documents_pick ON knowledge_documents(state, ingest_retry, last_observed_at, document_id);
CREATE TABLE knowledge_embedding_spaces (
 space_key TEXT PRIMARY KEY,
 model_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 artifact_digest TEXT NOT NULL,
 dimension INTEGER NOT NULL CHECK (dimension > 0),
 query_prefix TEXT NOT NULL,
 passage_prefix TEXT NOT NULL
);
CREATE TABLE knowledge_versions (
 version_id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_namespace TEXT NOT NULL,
 document_id TEXT NOT NULL,
 markdown_sha256 TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK (generation >= 0),
 ingest_retry INTEGER NOT NULL CHECK (ingest_retry >= 0),
 namespace TEXT NOT NULL,
 byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
 state TEXT NOT NULL CHECK (state IN ('staging','published','retired','abandoned')),
 expected_fragments INTEGER NOT NULL CHECK (expected_fragments >= 0),
 fragments_written INTEGER NOT NULL DEFAULT 0 CHECK (fragments_written >= 0),
 vectors_written INTEGER NOT NULL DEFAULT 0 CHECK (vectors_written >= 0),
 extractions_written INTEGER NOT NULL DEFAULT 0 CHECK (extractions_written >= 0),
 space_key TEXT REFERENCES knowledge_embedding_spaces(space_key),
 instruction_digest TEXT NOT NULL,
 extraction_partial INTEGER NOT NULL DEFAULT 0 CHECK (extraction_partial IN (0, 1)),
 created_at INTEGER NOT NULL,
 published_at INTEGER,
 retired_at INTEGER
);
CREATE INDEX knowledge_versions_document ON knowledge_versions(source_namespace, document_id, state);
CREATE INDEX knowledge_versions_state ON knowledge_versions(state, version_id);
CREATE INDEX knowledge_versions_published_space ON knowledge_versions(space_key, version_id) WHERE state = 'published';
CREATE TABLE knowledge_fragments (
 fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
 byte_end INTEGER NOT NULL,
 heading_path TEXT NOT NULL,
 text TEXT NOT NULL,
 text_sha256 TEXT NOT NULL,
 CHECK (byte_end > byte_start),
 UNIQUE (version_id, ordinal)
);
CREATE VIRTUAL TABLE knowledge_fragment_fts USING fts5(
 search_text,
 version_id UNINDEXED,
 ordinal UNINDEXED,
 tokenize = 'trigram'
);
CREATE TABLE knowledge_vectors (
 vector_id INTEGER PRIMARY KEY AUTOINCREMENT,
 space_key TEXT NOT NULL REFERENCES knowledge_embedding_spaces(space_key),
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 dimension INTEGER NOT NULL CHECK (dimension > 0),
 vector BLOB NOT NULL,
 CHECK (length(vector) = dimension * 4),
 UNIQUE (space_key, version_id, ordinal)
);
CREATE INDEX knowledge_vectors_version ON knowledge_vectors(version_id);
CREATE TABLE knowledge_extractions (
 extraction_id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 status TEXT NOT NULL CHECK (status IN ('ok','failed')),
 error_code TEXT,
 model TEXT,
 dropped_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_count >= 0),
 dropped_json TEXT NOT NULL DEFAULT '[]',
 CHECK ((status = 'failed') = (error_code IS NOT NULL)),
 UNIQUE (version_id, ordinal)
);
CREATE TABLE knowledge_entity_mentions (
 entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 fragment_ordinal INTEGER NOT NULL CHECK (fragment_ordinal >= 0),
 local_id TEXT NOT NULL,
 name TEXT NOT NULL,
 type TEXT NOT NULL,
 description TEXT NOT NULL,
 -- NFKC + lower case of name: the string the identity candidates are matched on (p3.md 8).
 name_norm TEXT NOT NULL DEFAULT '',
 UNIQUE (version_id, fragment_ordinal, local_id)
);
CREATE INDEX knowledge_entity_mentions_name_norm ON knowledge_entity_mentions(name_norm);
CREATE TABLE knowledge_relation_mentions (
 relation_id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 fragment_ordinal INTEGER NOT NULL CHECK (fragment_ordinal >= 0),
 local_id TEXT NOT NULL,
 source_local_id TEXT NOT NULL,
 target_local_id TEXT NOT NULL,
 directed INTEGER NOT NULL CHECK (directed IN (0, 1)),
 relation TEXT NOT NULL,
 description TEXT NOT NULL,
 keywords_json TEXT NOT NULL,
 qualifier_negated INTEGER NOT NULL CHECK (qualifier_negated IN (0, 1)),
 qualifier_condition TEXT,
 qualifier_certainty TEXT NOT NULL CHECK (qualifier_certainty IN ('stated','uncertain','hypothetical')),
 UNIQUE (version_id, fragment_ordinal, local_id)
);
-- Full-text indexes of the mentions (p3.md 3). rowid = entity_id / relation_id of the mention;
-- search_text is NFKC + lower case, like the fragment index.
CREATE VIRTUAL TABLE knowledge_entity_fts USING fts5(
 search_text,
 tokenize = 'trigram'
);
CREATE VIRTUAL TABLE knowledge_relation_fts USING fts5(
 search_text,
 tokenize = 'trigram'
);
CREATE TABLE knowledge_evidence (
 evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
 version_id INTEGER NOT NULL REFERENCES knowledge_versions(version_id),
 subject_kind TEXT NOT NULL CHECK (subject_kind IN ('entity','relation')),
 subject_id INTEGER NOT NULL,
 position INTEGER NOT NULL CHECK (position >= 0),
 fragment_ordinal INTEGER NOT NULL CHECK (fragment_ordinal >= 0),
 byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
 byte_end INTEGER NOT NULL,
 quote_sha256 TEXT NOT NULL,
 ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1)),
 CHECK (byte_end > byte_start),
 UNIQUE (subject_kind, subject_id, position)
);
CREATE INDEX knowledge_evidence_version ON knowledge_evidence(version_id);
CREATE TABLE knowledge_ingest_chain (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 next_sweep INTEGER NOT NULL CHECK (next_sweep >= 1),
 open_sweep INTEGER,
 opened_at INTEGER,
 advanced_at INTEGER,
 active_source_namespace TEXT,
 active_document_id TEXT,
 active_markdown_sha256 TEXT,
 active_generation INTEGER,
 active_retry INTEGER,
 active_namespace TEXT,
 CHECK ((open_sweep IS NULL) = (advanced_at IS NULL)),
 CHECK (open_sweep IS NOT NULL OR active_document_id IS NULL),
 CHECK ((active_document_id IS NULL) = (active_source_namespace IS NULL)
  AND (active_document_id IS NULL) = (active_markdown_sha256 IS NULL)
  AND (active_document_id IS NULL) = (active_generation IS NULL)
  AND (active_document_id IS NULL) = (active_retry IS NULL)
  AND (active_document_id IS NULL) = (active_namespace IS NULL))
);
INSERT INTO knowledge_ingest_chain (id, next_sweep) VALUES (1, 1);
-- P3 wave 2 (p3.md 8): identity judgments, their progress, summaries and the identity chain.
-- Links name two entity mentions in canonical order (entity_a < entity_b). A link lives and dies
-- with the two versions its mentions belong to: cleanup deletes it with either version.
CREATE TABLE knowledge_entity_links (
 entity_a INTEGER NOT NULL,
 entity_b INTEGER NOT NULL,
 version_a INTEGER NOT NULL,
 version_b INTEGER NOT NULL,
 decision TEXT NOT NULL CHECK (decision IN ('same','different','unsure')),
 model TEXT,
 instruction_id TEXT NOT NULL,
 instruction_version INTEGER NOT NULL CHECK (instruction_version >= 1),
 decided_at INTEGER NOT NULL,
 PRIMARY KEY (entity_a, entity_b),
 CHECK (entity_a < entity_b)
) WITHOUT ROWID;
CREATE INDEX knowledge_entity_links_b ON knowledge_entity_links(entity_b);
CREATE INDEX knowledge_entity_links_version_a ON knowledge_entity_links(version_a);
CREATE INDEX knowledge_entity_links_version_b ON knowledge_entity_links(version_b);
-- Per published version: how far its mentions were compared (in entity_id order). 'done' is the
-- mark "compared": every mention of the version was handled. A temporary failure sets not_before.
CREATE TABLE knowledge_link_versions (
 version_id INTEGER PRIMARY KEY,
 state TEXT NOT NULL CHECK (state IN ('partial','done')),
 cursor_entity_id INTEGER NOT NULL DEFAULT 0 CHECK (cursor_entity_id >= 0),
 failed_mentions INTEGER NOT NULL DEFAULT 0 CHECK (failed_mentions >= 0),
 not_before INTEGER NOT NULL DEFAULT 0 CHECK (not_before >= 0),
 transient_failures INTEGER NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
 -- Counts every recorded step of the comparison (a link that made progress is not made to wait).
 steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
 instruction_id TEXT NOT NULL,
 instruction_version INTEGER NOT NULL CHECK (instruction_version >= 1),
 updated_at INTEGER NOT NULL
);
-- One row per cluster anchor (the smallest entity id of the cluster). members_digest is the
-- digest of the sorted member ids the summary was made for; a different cluster never uses it.
-- 'failed': the answer was invalid (not retried for the same digest); 'waiting': a temporary failure.
CREATE TABLE knowledge_entity_summaries (
 anchor_entity_id INTEGER PRIMARY KEY,
 anchor_version_id INTEGER NOT NULL,
 members_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('ok','failed','waiting')),
 summary TEXT,
 model TEXT,
 instruction_id TEXT NOT NULL,
 instruction_version INTEGER NOT NULL CHECK (instruction_version >= 1),
 not_before INTEGER NOT NULL DEFAULT 0 CHECK (not_before >= 0),
 transient_failures INTEGER NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
 created_at INTEGER NOT NULL,
 CHECK ((status = 'ok') = (summary IS NOT NULL))
);
CREATE INDEX knowledge_entity_summaries_version ON knowledge_entity_summaries(anchor_version_id);
CREATE TABLE knowledge_link_chain (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 next_sweep INTEGER NOT NULL CHECK (next_sweep >= 1),
 open_sweep INTEGER,
 opened_at INTEGER,
 advanced_at INTEGER,
 active_kind TEXT CHECK (active_kind IS NULL OR active_kind IN ('version','summary')),
 active_id INTEGER,
 active_digest TEXT,
 -- Advances whenever the set of current mentions or of 'same' links may have changed. The
 -- summary search (a read of every link of the host) is skipped while it is unchanged since the
 -- last search that found nothing (summary_checked_key = generation and the search's limits;
 -- summary_recheck_at = when a waiting summary comes due, null: never).
 link_generation INTEGER NOT NULL DEFAULT 0 CHECK (link_generation >= 0),
 summary_checked_key TEXT,
 summary_recheck_at INTEGER,
 CHECK ((open_sweep IS NULL) = (advanced_at IS NULL)),
 CHECK (open_sweep IS NOT NULL OR active_kind IS NULL),
 CHECK ((active_kind IS NULL) = (active_id IS NULL))
);
INSERT INTO knowledge_link_chain (id, next_sweep) VALUES (1, 1);`,
	// KG2 G4: the identity key a model-free extractor gives a mention (kg2.md §3.3). Mentions of
	// one namespace with the same non-empty key are one entity when read; '' (a model's mention,
	// or a row written before this) joins nothing by key.
	`ALTER TABLE knowledge_entity_mentions ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
CREATE INDEX knowledge_entity_mentions_name_key ON knowledge_entity_mentions(name_key) WHERE name_key <> '';`,
	// KG2 G7: what extracted a version (`names:<tokenizer>@rules<n>`, `model:<instruction>`; ''
	// for a version written before this, never extracted again for it), when a failed
	// re-extraction may be tried again (epoch ms) and how many failed in a row (the wait doubles).
	// The index finds the published versions of another extractor without reading the others.
	`ALTER TABLE knowledge_versions ADD COLUMN extractor TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_versions ADD COLUMN reextract_not_before INTEGER NOT NULL DEFAULT 0 CHECK (reextract_not_before >= 0);
ALTER TABLE knowledge_versions ADD COLUMN reextract_failures INTEGER NOT NULL DEFAULT 0 CHECK (reextract_failures >= 0);
CREATE INDEX knowledge_versions_reextract ON knowledge_versions(extractor, version_id) WHERE state = 'published' AND extractor <> '';`,
	// KG2 G8: a graph reads the relations of the mentions it returns, found from their source.
	`CREATE INDEX knowledge_relation_mentions_source ON knowledge_relation_mentions(version_id, fragment_ordinal, source_local_id);`,
	// kg2.md §7.10: whether a published version lost a proper name at a fragment's limit
	// of names (`proper_over_limit`, from rules version 7). A version published before
	// this has none: a model's answer over the limits is invalid, never cut, and a model-free
	// version of an older rules version is extracted again (G7) and recorded then.
	`ALTER TABLE knowledge_versions ADD COLUMN extraction_truncated INTEGER NOT NULL DEFAULT 0 CHECK (extraction_truncated IN (0, 1));`,
];
