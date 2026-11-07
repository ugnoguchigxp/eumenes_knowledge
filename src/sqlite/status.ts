import {
	CONTRACT_VERSION,
	type AccessContext,
	type KnowledgeStatus,
	type ReadScanInSnapshot,
	type ReadStatusInSnapshot,
} from "../contracts/index.js";
import { getScanInTransaction } from "./scans.js";

type PartialReason = KnowledgeStatus["partialReasons"][number];

const iso = (ms: number | null): string | null =>
	ms === null ? null : new Date(ms).toISOString();

/**
 * Count the documents of `access.namespaces` and decide `partialReasons` from the registry alone.
 * `unverified` is derived here: a current document whose last verification is older than
 * `now - verifiedWithinMs`. Writes nothing.
 */
export const readStatusInSnapshot: ReadStatusInSnapshot = (
	db,
	access: AccessContext,
	now,
	options,
) => {
	const rows = db
		.query<{ state: string; n: number; old: number }>(
			`SELECT state, COUNT(*) AS n,
 COALESCE(SUM(CASE WHEN state = 'current' AND (last_verified_at IS NULL OR last_verified_at < ?) THEN 1 ELSE 0 END), 0) AS old
FROM knowledge_documents
WHERE namespace IN (SELECT value FROM json_each(?))
GROUP BY state`,
		)
		.all(now - options.verifiedWithinMs, JSON.stringify(access.namespaces));
	const documents = {
		total: 0,
		current: 0,
		unverified: 0,
		stale: 0,
		unavailable: 0,
		excluded: 0,
		removed: 0,
	};
	for (const r of rows) {
		documents.total += r.n;
		if (r.state === "current") {
			documents.current += r.n - r.old;
			documents.unverified += r.old;
		} else if (
			r.state === "stale" ||
			r.state === "unavailable" ||
			r.state === "excluded" ||
			r.state === "removed"
		) {
			documents[r.state] += r.n;
		}
	}

	const scan = db
		.query<{
			last_scan: number | null;
			last_complete: number | null;
			running: number;
			latest_finished_state: string | null;
		}>(
			`SELECT
 (SELECT MAX(COALESCE(finished_at, started_at)) FROM knowledge_scans) AS last_scan,
 (SELECT MAX(finished_at) FROM knowledge_scans WHERE state = 'complete' AND (?1 = 0 OR binding = ?2)) AS last_complete,
 EXISTS (SELECT 1 FROM knowledge_scans WHERE state = 'running') AS running,
 (SELECT state FROM knowledge_scans WHERE state <> 'running' ORDER BY finished_at DESC, rowid DESC LIMIT 1) AS latest_finished_state`,
		)
		// ?1 = 1 filters complete scans by binding ?2; a null binding matches no scan (the column is NOT NULL).
		.get(options.binding === undefined ? 0 : 1, options.binding ?? null) ?? {
		last_scan: null,
		last_complete: null,
		running: 0,
		latest_finished_state: null,
	};

	const partialReasons: PartialReason[] = [];
	// No complete scan yet, or the newest finished scan failed: the last listing was not whole.
	if (scan.last_complete === null || scan.latest_finished_state === "failed") {
		partialReasons.push("no_complete_scan");
	}
	if (scan.running === 1) partialReasons.push("scan_in_progress");
	if (documents.stale > 0) partialReasons.push("stale_documents");
	if (documents.unverified > 0) partialReasons.push("unverified_documents");
	if (documents.unavailable > 0) partialReasons.push("unavailable_documents");

	return {
		contractVersion: CONTRACT_VERSION,
		documents,
		lastScanAt: iso(scan.last_scan),
		lastCompleteScanAt: iso(scan.last_complete),
		complete: partialReasons.length === 0,
		partialReasons,
	};
};

export const readScanInSnapshot: ReadScanInSnapshot = (db, scanId) => {
	const s = getScanInTransaction(db, scanId);
	if (!s) return null;
	return {
		scanId: s.scanId,
		state: s.state,
		pagesSettled: s.pagesSettled,
		documentsQueued: s.documentsQueued,
		errorCode: s.errorCode,
		startedAt: s.startedAt,
		finishedAt: s.finishedAt,
	};
};
