// ホストが持つ受付記録。package は受付を持たない（plan §6）。明示した同期要求を 1 件ずつ記録し、
// 最初の sync-page ジョブを同じ transaction で JobSink へ入れる。requestId は principal ごとの範囲で、
// 別の principal が同じ requestId を使っても別の要求になる（存在の有無を区別しない。p0.md §4）。
// 未完了の sync-page ジョブを持つ走査があれば、新しい走査を始めずにその scanId に相乗りする。
// package は新しい走査の page 0 で実行中の他の走査を superseded にするので、重なる要求のたびに
// 走査を始めると、どの走査も完了しなくなる。
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	KNOWLEDGE_JOB_KINDS,
	syncPageDedupeKey,
	syncPagePayloadSchema,
	syncRequestSchema,
	type AccessContext,
	type Clock,
	type JobSink,
	type ReadScanInSnapshot,
	type SyncPagePayload,
	type SyncRequest,
} from "../../src/contracts/index.js";
import type { ExampleStore, HostMigration } from "./store.js";

export const SYNC_REQUESTS_MIGRATION_ID = "example-host/0002-sync-requests";
export const syncRequestsMigration: HostMigration = {
	id: SYNC_REQUESTS_MIGRATION_ID,
	sql: `
CREATE TABLE host_sync_requests (
	principal TEXT NOT NULL,
	request_id TEXT NOT NULL,
	scan_id TEXT NOT NULL,
	accepted_at_ms INTEGER NOT NULL,
	PRIMARY KEY (principal, request_id)
);
`,
};

type RequestRow = {
	request_id: string;
	principal: string;
	scan_id: string;
	accepted_at_ms: number;
};

export type SyncRequestRecord = {
	requestId: string;
	principal: string;
	scanId: string;
	acceptedAtMs: number;
};

export type RequestSyncResult =
	| { ok: true; created: boolean; record: SyncRequestRecord }
	/** requestId は principal ごとの範囲なので、この実装は返さない（HTTP 入口が受ける型として残す）。 */
	| { ok: false; error: "request_conflict" };

export interface SyncRequests {
	requestSync(
		access: AccessContext,
		requestId: string,
	): Promise<RequestSyncResult>;
	/** 本人の記録だけを返す。他人・未知は null。 */
	getSyncRequest(access: AccessContext, requestId: string): SyncRequest | null;
}

export type SyncRequestsOptions = {
	store: ExampleStore;
	clock: Clock;
	jobs: JobSink;
	readScanInSnapshot: ReadScanInSnapshot;
	newId?: () => string;
};

const toRecord = (row: RequestRow): SyncRequestRecord => ({
	requestId: row.request_id,
	principal: row.principal,
	scanId: row.scan_id,
	acceptedAtMs: row.accepted_at_ms,
});
const iso = (ms: number) => new Date(ms).toISOString();
/** API の schema と同じ形（コロンは不可）。合わないコードは handler_failed に丸める。 */
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]*$/;
const safeErrorCode = (code: string | null): string | null =>
	code === null || SAFE_ERROR_CODE.test(code) ? code : "handler_failed";

export function createSyncRequests(options: SyncRequestsOptions): SyncRequests {
	const { store, clock, jobs, readScanInSnapshot } = options;
	const newId = options.newId ?? randomUUID;

	function loadRow(
		db: Database,
		principal: string,
		requestId: string,
	): RequestRow | null {
		return db
			.query(
				"SELECT * FROM host_sync_requests WHERE principal = ? AND request_id = ?",
			)
			.get(principal, requestId) as RequestRow | null;
	}

	/** 未完了（queued・running・retry 待ち）の sync-page ジョブを持つ、新しい方の走査。無ければ null。 */
	function findOpenScan(db: Database): string | null {
		const rows = db
			.query(
				"SELECT payload_json FROM host_jobs WHERE kind = ? AND state IN ('queued','running') ORDER BY seq DESC",
			)
			.all(KNOWLEDGE_JOB_KINDS.syncPage) as { payload_json: string }[];
		for (const row of rows) {
			let raw: unknown;
			try {
				raw = JSON.parse(row.payload_json);
			} catch {
				continue;
			}
			const payload = syncPagePayloadSchema.safeParse(raw);
			if (!payload.success) continue;
			// package が終えたと記録した走査（complete・failed）には相乗りしない。
			const scan = readScanInSnapshot(db, payload.data.scanId);
			if (scan === null || scan.state === "running") return payload.data.scanId;
		}
		return null;
	}

	function view(db: Database, record: SyncRequestRecord): SyncRequest {
		const base = {
			requestId: record.requestId,
			acceptedAt: iso(record.acceptedAtMs),
		};
		const scan = readScanInSnapshot(db, record.scanId);
		if (scan) {
			const state =
				scan.state === "complete"
					? "completed"
					: scan.state === "failed"
						? "failed"
						: "running";
			return syncRequestSchema.parse({
				...base,
				state,
				finishedAt: scan.finishedAt === null ? null : iso(scan.finishedAt),
				complete: scan.state === "complete",
				errorCode:
					scan.state === "failed" ? safeErrorCode(scan.errorCode) : null,
			});
		}
		// package がまだ走査を記録していない。最初のページのジョブの状態で決める。
		const first: SyncPagePayload = {
			scanId: record.scanId,
			cursor: null,
			page: 0,
		};
		const job = db
			.query(
				"SELECT state, error_code, finished_at_ms FROM host_jobs WHERE dedupe_key = ? ORDER BY seq DESC LIMIT 1",
			)
			.get(syncPageDedupeKey(first)) as {
			state: string;
			error_code: string | null;
			finished_at_ms: number | null;
		} | null;
		const fields = (
			state: SyncRequest["state"],
			errorCode: string | null,
		): SyncRequest =>
			syncRequestSchema.parse({
				...base,
				state,
				finishedAt:
					job?.finished_at_ms == null ? null : iso(job.finished_at_ms),
				complete: false,
				errorCode,
			});
		switch (job?.state) {
			case "running":
				return fields("running", null);
			case "cancelled":
				return fields("cancelled", null);
			case "failed":
			case "expired":
			case "interrupted":
				return fields(
					"failed",
					safeErrorCode(job.error_code ?? `job_${job.state}`),
				);
			case "completed":
				return fields("failed", "scan_not_recorded");
			default:
				return fields("accepted", null);
		}
	}

	return {
		requestSync: (access, requestId) =>
			store.write((db): RequestSyncResult => {
				const existing = loadRow(db, access.principal, requestId);
				if (existing)
					return { ok: true, created: false, record: toRecord(existing) };
				const now = clock.now();
				const joined = findOpenScan(db);
				const scanId = joined ?? newId();
				db.query(
					"INSERT INTO host_sync_requests (principal, request_id, scan_id, accepted_at_ms) VALUES (?, ?, ?, ?)",
				).run(access.principal, requestId, scanId, now);
				if (joined === null) {
					const payload = syncPagePayloadSchema.parse({
						scanId,
						cursor: null,
						page: 0,
					});
					jobs.enqueueInTransaction(db, {
						kind: KNOWLEDGE_JOB_KINDS.syncPage,
						payloadVersion: 1,
						dedupeKey: syncPageDedupeKey(payload),
						payload,
						lane: "interactive",
					});
				}
				return {
					ok: true,
					created: true,
					record: {
						requestId,
						principal: access.principal,
						scanId,
						acceptedAtMs: now,
					},
				};
			}),
		getSyncRequest: (access, requestId) =>
			store.readSnapshot((db) => {
				const row = loadRow(db, access.principal, requestId);
				return row ? view(db, toRecord(row)) : null;
			}),
	};
}
