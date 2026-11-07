import { KnowledgeError, type Tx } from "../contracts/index.js";
import {
	getDocumentInTransaction,
	type DocumentRow,
	type IngestExpectation,
} from "./documents.js";

/**
 * The ingest chain (p2.md §3): one open `knowledge.ingest-next` link at a time. The registry
 * hands out sweep numbers, strictly increasing and never reused, because the host keeps every
 * job's dedupe key unique for good.
 */

const invalid = (): never => {
	throw new KnowledgeError("invalid_input");
};

export type ChainState = {
	/** The number the next opened link gets. */
	nextSweep: number;
	/** The link that is open, or null when the chain is stopped. */
	openSweep: number | null;
	openedAt: number | null;
	advancedAt: number | null;
};

export function getChainInTransaction(db: Tx): ChainState {
	const r = db
		.query<{
			next_sweep: number;
			open_sweep: number | null;
			opened_at: number | null;
			advanced_at: number | null;
		}>(
			"SELECT next_sweep, open_sweep, opened_at, advanced_at FROM knowledge_ingest_chain WHERE id = 1",
		)
		.get();
	if (!r) return invalid();
	return {
		nextSweep: r.next_sweep,
		openSweep: r.open_sweep,
		openedAt: r.opened_at,
		advancedAt: r.advanced_at,
	};
}

export function isChainOpenInTransaction(db: Tx): boolean {
	return getChainInTransaction(db).openSweep !== null;
}

function takeNext(db: Tx, now: number, keepOpenedAt: boolean): number {
	const c = getChainInTransaction(db);
	db.query(
		`UPDATE knowledge_ingest_chain SET next_sweep = next_sweep + 1, open_sweep = ?1,
 opened_at = CASE WHEN ?3 = 1 THEN opened_at ELSE ?2 END, advanced_at = ?2,
 active_source_namespace = NULL, active_document_id = NULL, active_markdown_sha256 = NULL,
 active_generation = NULL, active_retry = NULL, active_namespace = NULL
WHERE id = 1`,
	).run(c.nextSweep, now, keepOpenedAt ? 1 : 0);
	return c.nextSweep;
}

/**
 * Start the chain. Returns the new sweep number when the chain is stopped, or when it is open
 * but did not advance for `staleAfterMs` or more (its job was lost); the number of the lost
 * link is never handed out again. Returns null when a live link is open.
 */
export function openChainInTransaction(
	db: Tx,
	now: number,
	staleAfterMs: number,
): number | null {
	if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs)) return invalid();
	const c = getChainInTransaction(db);
	if (
		c.openSweep !== null &&
		c.advancedAt !== null &&
		now - c.advancedAt < staleAfterMs
	) {
		return null;
	}
	return takeNext(db, now, false);
}

/**
 * Move from link `sweep` to the next one and return its number. Returns null (nothing
 * written) when `sweep` is not the open link: the chain was stopped or restarted meanwhile,
 * so the caller must not enqueue a second link.
 */
export function advanceChainInTransaction(
	db: Tx,
	sweep: number,
	now: number,
): number | null {
	if (!Number.isFinite(now)) return invalid();
	if (getChainInTransaction(db).openSweep !== sweep) return null;
	return takeNext(db, now, true);
}

/** Stop the chain if `sweep` is the open link. False when it is not. */
export function closeChainInTransaction(db: Tx, sweep: number): boolean {
	return (
		db
			.query(
				`UPDATE knowledge_ingest_chain SET open_sweep = NULL, advanced_at = NULL,
 active_source_namespace = NULL, active_document_id = NULL, active_markdown_sha256 = NULL,
 active_generation = NULL, active_retry = NULL, active_namespace = NULL
WHERE id = 1 AND open_sweep = ?`,
			)
			.run(sweep).changes === 1
	);
}

/**
 * Record which document the open link `sweep` is ingesting (the tuple its prepare fixed), or
 * `null` when it only cleans up. A cancel gets nothing but the payload's sweep, so this is how
 * it finds the document. Cleared by `advance`, `close` and `open`. False (nothing written) when
 * `sweep` is not the open link.
 */
export function setActiveIngestInTransaction(
	db: Tx,
	sweep: number,
	active: IngestExpectation | null,
): boolean {
	return (
		db
			.query(
				`UPDATE knowledge_ingest_chain SET
 active_source_namespace = ?2, active_document_id = ?3, active_markdown_sha256 = ?4,
 active_generation = ?5, active_retry = ?6, active_namespace = ?7
WHERE id = 1 AND open_sweep = ?1`,
			)
			.run(
				sweep,
				active?.sourceNamespace ?? null,
				active?.documentId ?? null,
				active?.markdownSha256 ?? null,
				active?.generation ?? null,
				active?.retry ?? null,
				active?.namespace ?? null,
			).changes === 1
	);
}

/** The tuple `setActiveIngestInTransaction` recorded for the open link `sweep`; null otherwise. */
export function getActiveIngestInTransaction(
	db: Tx,
	sweep: number,
): IngestExpectation | null {
	const r = db
		.query<{
			active_source_namespace: string | null;
			active_document_id: string | null;
			active_markdown_sha256: string | null;
			active_generation: number | null;
			active_retry: number | null;
			active_namespace: string | null;
		}>(
			`SELECT active_source_namespace, active_document_id, active_markdown_sha256,
 active_generation, active_retry, active_namespace
FROM knowledge_ingest_chain WHERE id = 1 AND open_sweep = ?`,
		)
		.get(sweep);
	if (
		!r ||
		r.active_source_namespace === null ||
		r.active_document_id === null ||
		r.active_markdown_sha256 === null ||
		r.active_generation === null ||
		r.active_retry === null ||
		r.active_namespace === null
	) {
		return null;
	}
	return {
		sourceNamespace: r.active_source_namespace,
		documentId: r.active_document_id,
		markdownSha256: r.active_markdown_sha256,
		generation: r.active_generation,
		retry: r.active_retry,
		namespace: r.active_namespace,
	};
}

/**
 * The link `sweep` is alive: it wrote (or is about to write) a staging bundle, so the chain's
 * `advanced_at` moves to `now`. Otherwise a long ingest would look lost to the restart rule of
 * `openChainInTransaction`. Only the open link moves it; false (nothing written) otherwise.
 */
export function touchChainInTransaction(
	db: Tx,
	sweep: number,
	now: number,
): boolean {
	if (!Number.isFinite(now)) return invalid();
	return (
		db
			.query(
				"UPDATE knowledge_ingest_chain SET advanced_at = ? WHERE id = 1 AND open_sweep = ?",
			)
			.run(now, sweep).changes === 1
	);
}

/**
 * The next document to ingest: `stale`, with fewer than `maxUnappliedAttempts` unapplied
 * attempts, not waiting for a retry time that is still ahead of `now`, and not marked superseded
 * since its last observation (a mark made at or after the observation's time skips it; an
 * observation also clears the mark); fewest attempts first, then longest unobserved, then document id.
 * Null if none.
 */
export function pickNextDocumentInTransaction(
	db: Tx,
	options: { maxUnappliedAttempts: number; now: number },
): DocumentRow | null {
	if (
		!Number.isFinite(options.maxUnappliedAttempts) ||
		!Number.isFinite(options.now)
	) {
		return invalid();
	}
	const r = db
		.query<{ source_namespace: string; document_id: string }>(
			`SELECT source_namespace, document_id FROM knowledge_documents
WHERE state = 'stale' AND ingest_retry < ?1 AND ingest_not_before <= ?2
 AND (superseded_at IS NULL OR superseded_at < last_observed_at)
ORDER BY ingest_retry, last_observed_at, document_id, source_namespace
LIMIT 1`,
		)
		.get(options.maxUnappliedAttempts, options.now);
	if (!r) return null;
	return getDocumentInTransaction(db, {
		sourceNamespace: r.source_namespace,
		documentId: r.document_id,
	});
}
