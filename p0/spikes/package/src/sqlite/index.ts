/**
 * SQL for the host's single writer. Plain strings, positional like the other
 * Eumenes packages: the host assigns `<owner>/<4-digit>` ids and `after`.
 * Never changed once released; append a new entry instead.
 */
export const migrations: readonly string[] = [
	`CREATE TABLE knowledge_documents (
	source TEXT NOT NULL,
	document_id TEXT NOT NULL,
	version TEXT NOT NULL,
	digest TEXT NOT NULL,
	PRIMARY KEY (source, document_id, version)
)`,
	`CREATE INDEX knowledge_documents_digest ON knowledge_documents (digest)`,
];

/** Structural handle so this entry never imports `bun:sqlite`. */
export interface HostDatabase {
	query(sql: string): { all(...params: unknown[]): unknown[] };
}

export function countDocuments(db: HostDatabase): number {
	const rows = db.query("SELECT count(*) AS n FROM knowledge_documents").all();
	return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}
