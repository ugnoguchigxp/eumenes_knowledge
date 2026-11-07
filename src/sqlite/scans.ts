import type { Tx } from "../contracts/index.js";

export type ScanRow = {
	scanId: string;
	binding: string;
	state: "running" | "complete" | "failed";
	pagesSettled: number;
	documentsQueued: number;
	errorCode: string | null;
	startedAt: number;
	finishedAt: number | null;
};

type RawScan = {
	scan_id: string;
	binding: string;
	state: ScanRow["state"];
	pages_settled: number;
	documents_queued: number;
	error_code: string | null;
	started_at: number;
	finished_at: number | null;
};

export function getScanInTransaction(db: Tx, scanId: string): ScanRow | null {
	const r = db
		.query<RawScan>("SELECT * FROM knowledge_scans WHERE scan_id = ?")
		.get(scanId);
	if (!r) return null;
	return {
		scanId: r.scan_id,
		binding: r.binding,
		state: r.state,
		pagesSettled: r.pages_settled,
		documentsQueued: r.documents_queued,
		errorCode: r.error_code,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
	};
}

/** Record a scan and fix its binding. A scan that already exists is left unchanged. */
export function beginScanInTransaction(
	db: Tx,
	scanId: string,
	binding: string,
	now: number,
): ScanRow {
	db.query(
		"INSERT OR IGNORE INTO knowledge_scans (scan_id, binding, state, started_at) VALUES (?, ?, 'running', ?)",
	).run(scanId, binding, now);
	return getScanInTransaction(db, scanId) as ScanRow;
}

export function isScanPageSettledInTransaction(
	db: Tx,
	scanId: string,
	page: number,
): boolean {
	return (
		db
			.query<{ one: number }>(
				"SELECT 1 AS one FROM knowledge_scan_pages WHERE scan_id = ? AND page = ?",
			)
			.get(scanId, page) !== null
	);
}

/** A newer scan began: every other scan still running can no longer finish, so it fails. */
export function supersedeRunningScansInTransaction(
	db: Tx,
	newScanId: string,
	now: number,
): void {
	db.query(
		"UPDATE knowledge_scans SET state = 'failed', error_code = 'superseded', finished_at = ? WHERE state = 'running' AND scan_id <> ?",
	).run(now, newScanId);
}

/** The status API accepts only this shape of error code (no colon, unlike the host's). */
const SCAN_ERROR_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Fail a running scan with a safe code; a code that is not `[a-z][a-z0-9_]*` is stored as
 * `handler_failed`. Nothing else is touched (no document is deleted).
 */
export function failScanInTransaction(
	db: Tx,
	scanId: string,
	rawErrorCode: string,
	now: number,
): void {
	const errorCode = SCAN_ERROR_CODE.test(rawErrorCode)
		? rawErrorCode
		: "handler_failed";
	db.query(
		"UPDATE knowledge_scans SET state = 'failed', error_code = ?, finished_at = ? WHERE scan_id = ? AND state = 'running'",
	).run(errorCode, now, scanId);
}

/** Record one settled page; the scan is complete when its last page settled. */
export function settleScanPageInTransaction(
	db: Tx,
	scanId: string,
	page: number,
	queued: number,
	last: boolean,
	now: number,
): void {
	db.query(
		"INSERT INTO knowledge_scan_pages (scan_id, page, settled_at) VALUES (?, ?, ?)",
	).run(scanId, page, now);
	db.query(
		`UPDATE knowledge_scans SET
 pages_settled = pages_settled + 1, documents_queued = documents_queued + ?,
 state = CASE WHEN ? THEN 'complete' ELSE state END,
 finished_at = CASE WHEN ? THEN ? ELSE finished_at END
WHERE scan_id = ?`,
	).run(queued, last ? 1 : 0, last ? 1 : 0, now, scanId);
}
