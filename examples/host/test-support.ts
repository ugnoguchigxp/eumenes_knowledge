// ホストの試験用の偽物（偽の handler・偽の status・偽の source）。package の実装には依存しない。
import type { Database } from "bun:sqlite";
import {
	CONTRACT_VERSION,
	KNOWLEDGE_JOB_KINDS,
	SourceError,
	syncPageDedupeKey,
	syncPagePayloadSchema,
	type AccessContext,
	type DocumentSourcePort,
	type FollowUpJob,
	type HandlerDeps,
	type JobClaim,
	type KnowledgeStatus,
	type PrepareResult,
	type ReadScanInSnapshot,
	type ReadStatusInSnapshot,
	type SettleOutcome,
	type SettleResult,
	type SyncPagePayload,
} from "../../src/contracts/index.js";
import {
	createExampleHost,
	createTestClock,
	type ExampleHost,
	type ExampleHostOptions,
	type TestClock,
} from "./index.js";
import { removeExampleTempDir } from "./store.js";
import type { AnyJobHandler } from "./runner.js";

export const START_MS = Date.UTC(2026, 10, 7, 0, 0, 0);

export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 偽の package が持つ表（settle の記録と、走査の状態）。 */
export const FAKE_PACKAGE_SQL = [
	`CREATE TABLE fake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, outcome TEXT NOT NULL, input_null INTEGER NOT NULL);
	 CREATE TABLE fake_scans (scan_id TEXT PRIMARY KEY, state TEXT NOT NULL, pages INTEGER NOT NULL, queued INTEGER NOT NULL, error_code TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);`,
];

export type FakeControl = {
	recovery: "replay_safe" | "interrupt";
	prepare: (claim: JobClaim<SyncPagePayload>) => PrepareResult<string>;
	execute: (
		input: string,
		context: { signal: AbortSignal; jobId: string; attempt: number },
	) => Promise<string>;
	classify: (error: unknown) => "retry" | "fail";
	/** true の間、settle は書込みの後で例外を投げる。 */
	settleThrows: boolean;
	/** 0 より大きい間、settle は書込みの後で例外を投げ、呼ぶたびに 1 減る。 */
	settleThrowTimes: number;
	/** success の settle が後続として入れるジョブ。 */
	followUps: (claim: JobClaim<SyncPagePayload>) => FollowUpJob[];
	settleResult: SettleResult;
	prepareCalls: string[];
	executeCalls: string[];
	settleCalls: {
		jobId: string;
		type: SettleOutcome<string>["type"];
		inputNull: boolean;
	}[];
	cancelCalls: { jobId: string; reason: string }[];
};

export function newControl(): FakeControl {
	return {
		recovery: "replay_safe",
		prepare: () => ({ status: "ready", input: "input" }),
		execute: async () => "result",
		classify: () => "fail",
		settleThrows: false,
		settleThrowTimes: 0,
		followUps: () => [],
		settleResult: "applied",
		prepareCalls: [],
		executeCalls: [],
		settleCalls: [],
		cancelCalls: [],
	};
}

export function createFakeHandler(
	control: FakeControl,
	deps: HandlerDeps,
): AnyJobHandler {
	const handler = {
		kind: KNOWLEDGE_JOB_KINDS.syncPage,
		payloadVersions: [1],
		schema: syncPagePayloadSchema,
		get recovery() {
			return control.recovery;
		},
		prepareInTransaction(_tx: Database, claim: JobClaim<SyncPagePayload>) {
			control.prepareCalls.push(claim.jobId);
			return control.prepare(claim);
		},
		execute: (
			input: string,
			context: { signal: AbortSignal; jobId: string; attempt: number },
		) => {
			control.executeCalls.push(context.jobId);
			return control.execute(input, context);
		},
		classify: (error: unknown) => control.classify(error),
		settleInTransaction(
			tx: Database,
			claim: JobClaim<SyncPagePayload>,
			input: string | null,
			outcome: SettleOutcome<string>,
		): SettleResult {
			control.settleCalls.push({
				jobId: claim.jobId,
				type: outcome.type,
				inputNull: input === null,
			});
			tx.query(
				"INSERT INTO fake_log (job_id, outcome, input_null) VALUES (?, ?, ?)",
			).run(claim.jobId, outcome.type, input === null ? 1 : 0);
			if (outcome.type === "success")
				for (const job of control.followUps(claim))
					deps.jobs.enqueueInTransaction(tx, job);
			if (control.settleThrows) throw new Error("settle exploded");
			if (control.settleThrowTimes > 0) {
				control.settleThrowTimes -= 1;
				throw new Error("settle exploded");
			}
			return control.settleResult;
		},
		cancelInTransaction(
			tx: Database,
			job: { jobId: string; payload: SyncPagePayload },
			reason: string,
		) {
			control.cancelCalls.push({ jobId: job.jobId, reason });
			tx.query(
				"INSERT INTO fake_log (job_id, outcome, input_null) VALUES (?, 'cancel', 1)",
			).run(job.jobId);
		},
	};
	return handler as unknown as AnyJobHandler;
}

export function syncPageJob(
	page = 0,
	scanId = crypto.randomUUID(),
): FollowUpJob {
	const payload: SyncPagePayload = { scanId, cursor: null, page };
	return {
		kind: KNOWLEDGE_JOB_KINDS.syncPage,
		payloadVersion: 1,
		dedupeKey: syncPageDedupeKey(payload),
		payload,
		lane: "interactive",
	};
}

export const fakeSource: DocumentSourcePort = {
	list: () => Promise.reject(new SourceError("unavailable")),
	read: () => Promise.reject(new SourceError("unavailable")),
	binding: () => null,
};

export const readFakeStatus: ReadStatusInSnapshot = (db, access) => {
	const total = (
		db.query("SELECT count(*) AS c FROM fake_log").get() as { c: number }
	).c;
	// access の namespaces 数を total に足し、principal ごとに値が変わることを見られるようにする。
	const status: KnowledgeStatus = {
		contractVersion: CONTRACT_VERSION,
		documents: {
			total: total + access.namespaces.length,
			current: 0,
			unverified: 0,
			stale: 0,
			unavailable: 0,
			excluded: 0,
			removed: 0,
		},
		lastScanAt: null,
		lastCompleteScanAt: null,
		complete: false,
		partialReasons: ["no_complete_scan"],
	};
	return status;
};

export const readFakeScan: ReadScanInSnapshot = (db, scanId) => {
	const row = db
		.query("SELECT * FROM fake_scans WHERE scan_id = ?")
		.get(scanId) as {
		scan_id: string;
		state: "running" | "complete" | "failed";
		pages: number;
		queued: number;
		error_code: string | null;
		started_at: number;
		finished_at: number | null;
	} | null;
	if (!row) return null;
	return {
		scanId: row.scan_id,
		state: row.state,
		pagesSettled: row.pages,
		documentsQueued: row.queued,
		errorCode: row.error_code,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
	};
};

export const ALICE: AccessContext = {
	principal: "alice",
	namespaces: ["notes", "docs"],
};
export const BOB: AccessContext = { principal: "bob", namespaces: ["other"] };
export const TOKENS = { "token-alice": ALICE, "token-bob": BOB };

export type TestHost = {
	host: ExampleHost;
	clock: TestClock;
	control: FakeControl;
};

const created: string[] = [];
const hosts: ExampleHost[] = [];

export function makeHost(
	overrides: Partial<ExampleHostOptions> = {},
	control: FakeControl = newControl(),
): TestHost {
	const clock = createTestClock(START_MS);
	const host = createExampleHost({
		source: fakeSource,
		principals: TOKENS,
		clock,
		handlerFactories: [(deps) => createFakeHandler(control, deps)],
		readStatusInSnapshot: readFakeStatus,
		readScanInSnapshot: readFakeScan,
		packageMigrations: FAKE_PACKAGE_SQL,
		statusOptions: { verifiedWithinMs: 60_000 },
		...overrides,
	});
	if (overrides.dir === undefined) created.push(host.dir);
	hosts.push(host);
	return { host, clock, control };
}

/** 試験の後始末: 開いた host を閉じ、作った一時ディレクトリが残っていないことを返す。 */
export async function cleanupHosts(): Promise<string[]> {
	for (const host of hosts.splice(0)) await host.close();
	const leftovers: string[] = [];
	for (const dir of created.splice(0)) {
		if (removeExampleTempDir(dir)) leftovers.push(dir);
	}
	return leftovers;
}

export function count(host: ExampleHost, table: string): number {
	return host.store.read(
		(db) =>
			(db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c,
	);
}
