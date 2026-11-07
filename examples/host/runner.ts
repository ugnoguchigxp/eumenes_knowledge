// 試験用の最小ジョブ実行器。Eumenes の汎用 queue は再実装せず、`KnowledgeJobHandler` を
// 試験するのに必要な意味論（claim・prepare・execute・settle・取消・期限・再試行・再起動）だけを持つ。
// dedupe・上限・maxAttempts・settle の扱いは Eumenes の queue（api/domains/queue）に合わせる。
// 実時間のタイマーは使わない。時間は注入した Clock だけで進む。
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
	Clock,
	FollowUpJob,
	JobClaim,
	JobSink,
	KnowledgeJobHandler,
	SettleOutcome,
	SettleResult,
	Tx,
} from "../../src/contracts/index.js";
import type { ExampleStore, HostMigration } from "./store.js";

// ---------------------------------------------------------------------------
// 時計
// ---------------------------------------------------------------------------

export interface TestClock extends Clock {
	advance(ms: number): number;
	set(ms: number): void;
}

export function createTestClock(startMs: number): TestClock {
	let current = startMs;
	return {
		now: () => current,
		advance(ms) {
			if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid_advance");
			current += ms;
			return current;
		},
		set(ms) {
			current = ms;
		},
	};
}

// ---------------------------------------------------------------------------
// ホスト側 migration とジョブ表
// ---------------------------------------------------------------------------

export const JOBS_MIGRATION_ID = "example-host/0001-jobs";
/**
 * `(scope, kind, dedupe_key)` はジョブの状態にかかわらず一意（Eumenes の `queue_jobs` と同じ）。
 * 未完了は queued・running（retry 待ちは available_at を先に置いた queued）。
 */
export const jobsMigration: HostMigration = {
	id: JOBS_MIGRATION_ID,
	sql: `
CREATE TABLE host_jobs (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	scope TEXT NOT NULL,
	kind TEXT NOT NULL,
	payload_version INTEGER NOT NULL,
	dedupe_key TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	input_digest TEXT NOT NULL,
	lane TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','expired','interrupted','cancelled')),
	available_at_ms INTEGER NOT NULL,
	deadline_at_ms INTEGER,
	attempt INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL,
	owner TEXT,
	error_code TEXT,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	finished_at_ms INTEGER,
	UNIQUE (scope, kind, dedupe_key)
);
CREATE INDEX host_jobs_claimable ON host_jobs (state, available_at_ms, seq);
`,
};

export type JobState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "expired"
	| "interrupted"
	| "cancelled";

type JobRow = {
	seq: number;
	id: string;
	scope: string;
	kind: string;
	payload_version: number;
	dedupe_key: string;
	payload_json: string;
	input_digest: string;
	lane: string;
	state: JobState;
	available_at_ms: number;
	deadline_at_ms: number | null;
	attempt: number;
	max_attempts: number;
	owner: string | null;
	error_code: string | null;
	created_at_ms: number;
	updated_at_ms: number;
	finished_at_ms: number | null;
};

export type JobView = {
	id: string;
	scope: string;
	kind: string;
	lane: string;
	dedupeKey: string;
	payload: unknown;
	state: JobState;
	attempt: number;
	maxAttempts: number;
	availableAtMs: number;
	deadlineAtMs: number | null;
	/** 失敗・取消・retry 待ち・prepare の stale の理由。 */
	errorCode: string | null;
};

function toView(row: JobRow): JobView {
	return {
		id: row.id,
		scope: row.scope,
		kind: row.kind,
		lane: row.lane,
		dedupeKey: row.dedupe_key,
		payload: JSON.parse(row.payload_json) as unknown,
		state: row.state,
		attempt: row.attempt,
		maxAttempts: row.max_attempts,
		availableAtMs: row.available_at_ms,
		deadlineAtMs: row.deadline_at_ms,
		errorCode: row.error_code,
	};
}

const SAFE_CODE = /^[a-z][a-z0-9_]*$/;
const OPEN = "('queued','running')";
export const DEFAULT_MAX_ATTEMPTS = 1;
export const MAX_ATTEMPTS_LIMIT = 3;
export const DEFAULT_RETRY_DELAY_MS = 1_000;
export const DEFAULT_SCOPE = "knowledge";
/** Eumenes の既定。未完了ジョブの件数の上限。 */
export const DEFAULT_QUEUE_LIMITS = {
	total: 1024,
	background: 768,
	scope: 128,
};
export type QueueLimits = typeof DEFAULT_QUEUE_LIMITS;

const clampAttempts = (n: number) =>
	Math.min(MAX_ATTEMPTS_LIMIT, Math.max(1, Math.trunc(n)));

function isThenable(value: unknown): boolean {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof (value as { then: unknown }).then === "function"
	);
}

/** キー順を固定した JSON（Eumenes の canonicalJson と同じ目的）。 */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// JobSink（package と同じ DB・同じ transaction へ書く）
// ---------------------------------------------------------------------------

export type AnyJobHandler = KnowledgeJobHandler<unknown, unknown, unknown>;

export type EnqueueOptions = {
	deadlineAtMs?: number | null;
	/** 1〜3 に丸める。 */
	maxAttempts?: number;
	availableAtMs?: number;
};

export type HostJobsOptions = {
	clock: Clock;
	/** enqueue 時にホストが与える期限。既定は期限なし。 */
	deadlineFor?: (job: FollowUpJob, nowMs: number) => number | null;
	/** 既定 1。1〜3 に丸める。 */
	maxAttempts?: number;
	/** 上限は scope ごと。既定は Eumenes と同じ total 1024・background 768・scope 128。 */
	limits?: QueueLimits;
	scope?: string;
	newId?: () => string;
};

export interface HostJobs {
	/** package へ渡す `JobSink`。 */
	readonly sink: JobSink;
	/**
	 * 同じ `(scope, kind, dedupeKey)` のジョブが状態にかかわらず既にあれば何も作らない（null）。
	 * ただし payload・lane などが違えば `request_conflict`。未完了が上限なら `queue_full`。
	 * 作ったら jobId。呼んだ transaction が巻き戻れば、ジョブも残らない。
	 */
	enqueueInTransaction(
		tx: Tx,
		job: FollowUpJob,
		options?: EnqueueOptions,
	): string | null;
	/** enqueue が kind・version・payload の検査に使う。runner が組み立て時に呼ぶ。 */
	registerHandlers(handlers: readonly AnyJobHandler[]): void;
}

export function createHostJobs(options: HostJobsOptions): HostJobs {
	const newId = options.newId ?? randomUUID;
	const limits = options.limits ?? DEFAULT_QUEUE_LIMITS;
	const scope = options.scope ?? DEFAULT_SCOPE;
	const registry = new Map<string, AnyJobHandler>();
	function enqueueInTransaction(
		tx: Tx,
		job: FollowUpJob,
		extra: EnqueueOptions = {},
	): string | null {
		const handler = registry.get(job.kind);
		if (!handler) throw new Error("invalid_unknown_job_kind");
		if (!handler.payloadVersions.includes(job.payloadVersion))
			throw new Error("invalid_payload_version");
		const parsed = handler.schema.safeParse(job.payload);
		if (!parsed.success) throw new Error("invalid_job_payload");
		const payloadJson = canonical(parsed.data);
		const maxAttempts = clampAttempts(
			extra.maxAttempts ?? options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		);
		const digest = createHash("sha256")
			.update(
				canonical({
					version: job.payloadVersion,
					payload: parsed.data,
					lane: job.lane,
					maxAttempts,
				}),
			)
			.digest("hex");
		const existing = tx
			.query(
				"SELECT input_digest FROM host_jobs WHERE scope = ? AND kind = ? AND dedupe_key = ?",
			)
			.get(scope, job.kind, job.dedupeKey) as { input_digest: string } | null;
		if (existing) {
			if (existing.input_digest !== digest) throw new Error("request_conflict");
			return null;
		}
		const counts = tx
			.query(
				`SELECT count(*) AS total, coalesce(sum(lane = 'background'), 0) AS background, coalesce(sum(scope = ?), 0) AS scoped FROM host_jobs WHERE state IN ${OPEN}`,
			)
			.get(scope) as { total: number; background: number; scoped: number };
		if (
			counts.total >= limits.total ||
			counts.scoped >= limits.scope ||
			(job.lane === "background" && counts.background >= limits.background)
		)
			throw new Error("queue_full");
		const now = options.clock.now();
		const id = newId();
		const deadline =
			extra.deadlineAtMs !== undefined
				? extra.deadlineAtMs
				: (options.deadlineFor?.(job, now) ?? null);
		tx.query(
			`INSERT INTO host_jobs
			 (id, scope, kind, payload_version, dedupe_key, payload_json, input_digest, lane, state, available_at_ms, deadline_at_ms, max_attempts, created_at_ms, updated_at_ms)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?11, ?12, ?12)`,
		).run(
			id,
			scope,
			job.kind,
			job.payloadVersion,
			job.dedupeKey,
			payloadJson,
			digest,
			job.lane,
			extra.availableAtMs ?? now,
			deadline,
			maxAttempts,
			now,
		);
		return id;
	}
	return {
		sink: {
			enqueueInTransaction: (tx, job) => {
				enqueueInTransaction(tx, job);
			},
		},
		enqueueInTransaction,
		registerHandlers(handlers) {
			registry.clear();
			for (const handler of handlers) registry.set(handler.kind, handler);
		},
	};
}

// ---------------------------------------------------------------------------
// ランナー
// ---------------------------------------------------------------------------

export type StepResult =
	/** prepare が stale と答え、実行せずに cancelled で終えた（理由は errorCode）。 */
	| "stale"
	| "success"
	| "retry"
	| "failed"
	| "expired"
	| "interrupted"
	/** settle が stale と答えた（handler の書込みは commit され、ジョブは interrupted）。 */
	| "settle_stale"
	/** handler の書込みだけ巻き戻して interrupted（settle_failed）にした（通常の settle の 2 回目も例外、または回復・sweep の経路）。 */
	| "settle_failed"
	/** 取消などでジョブの状態が変わっていたため、遅れた結果を捨てた。 */
	| "discarded"
	/** handler が無い・payload が不正で、開始できなかった。 */
	| "unclaimable";

export type StepReport =
	| { status: "idle" }
	| {
			status: "processed";
			jobId: string;
			kind: string;
			attempt: number;
			result: StepResult;
			/** step の終わりにジョブが置かれた状態。 */
			state: JobState;
	  };

export type RecoverReport = {
	requeued: string[];
	interrupted: string[];
	failed: string[];
};

export type CancelResult = "cancelled" | "not_found" | "not_open";

export type JobRunnerOptions = {
	store: ExampleStore;
	clock: Clock;
	jobs: HostJobs;
	handlers: readonly AnyJobHandler[];
	/** retry の待ち（固定）。既定 1000ms。 */
	retryDelayMs?: number;
};

export interface JobRunner {
	/** 起動時の回復が終わると解決する。`step` などはこれを待つ。 */
	readonly ready: Promise<RecoverReport>;
	step(): Promise<StepReport>;
	runUntilIdle(options?: {
		maxSteps?: number;
	}): Promise<{ reports: StepReport[]; idle: boolean }>;
	cancel(jobId: string, reason: string): Promise<CancelResult>;
	/** 期限を過ぎた実行中ジョブを abort する。abort した jobId を返す。 */
	expireDue(): string[];
	getJob(jobId: string): JobView | null;
	listJobs(): JobView[];
	/** 実行中の件数。 */
	activeCount(): number;
	/** 実行中を abort（interrupted/shutdown）し、進行中の step の終了を待つ。 */
	close(): Promise<void>;
}

type Active = {
	controller: AbortController;
	claim: JobClaim<unknown>;
	handler: AnyJobHandler;
	deadlineHit: boolean;
	cancelled: boolean;
	shutdown: boolean;
};

type Parsed = { handler: AnyJobHandler; claim: JobClaim<unknown> };
type Settled = { result: StepResult; state: JobState };

function getRow(db: Database, id: string): JobRow | null {
	return db
		.query("SELECT * FROM host_jobs WHERE id = ?")
		.get(id) as JobRow | null;
}

/** 機械可読なコードだけを保存する。自由文は provider の出力を含み得るので使わない（Eumenes と同じ）。 */
function toErrorCode(error: unknown): string {
	if (!(error instanceof Error) || !error.message) return "execution_failed";
	return /^[a-z][a-z0-9_:]{0,100}$/.test(error.message)
		? error.message
		: "handler_failed";
}

type Finish = {
	state: Exclude<JobState, "queued" | "running">;
	errorCode: string | null;
};

export function createJobRunner(options: JobRunnerOptions): JobRunner {
	const { store, clock } = options;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const runnerId = randomUUID();
	const handlers = new Map<string, AnyJobHandler>();
	for (const handler of options.handlers) {
		if (handlers.has(handler.kind)) throw new Error("duplicate_job_handler");
		handlers.set(handler.kind, handler);
	}
	options.jobs.registerHandlers(options.handlers);
	const active = new Map<string, Active>();
	const inflight = new Set<Promise<unknown>>();
	let closing = false;

	// -- 行の更新 -----------------------------------------------------------

	function finishRow(
		db: Database,
		id: string,
		finish: Finish,
		now: number,
	): void {
		db.query(
			`UPDATE host_jobs SET state = ?, error_code = ?, owner = NULL, updated_at_ms = ?, finished_at_ms = ? WHERE id = ?`,
		).run(finish.state, finish.errorCode, now, now, id);
	}
	function requeueRow(
		db: Database,
		id: string,
		errorCode: string,
		availableAtMs: number,
		now: number,
	): void {
		db.query(
			`UPDATE host_jobs SET state = 'queued', error_code = ?, owner = NULL, available_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
		).run(errorCode, availableAtMs, now, id);
	}

	function parseClaim(row: JobRow): Parsed | string {
		const handler = handlers.get(row.kind);
		if (!handler) return "handler_not_registered";
		if (!handler.payloadVersions.includes(row.payload_version))
			return "unsupported_payload_version";
		let raw: unknown;
		try {
			raw = JSON.parse(row.payload_json);
		} catch {
			return "invalid_payload";
		}
		const payload = handler.schema.safeParse(raw);
		if (!payload.success) return "invalid_payload";
		return {
			handler,
			claim: {
				jobId: row.id,
				kind: row.kind as JobClaim<unknown>["kind"],
				payloadVersion: row.payload_version,
				payload: payload.data,
				attempt: row.attempt,
				maxAttempts: row.max_attempts,
				deadlineAtMs: row.deadline_at_ms,
			},
		};
	}

	/**
	 * handler の settle を呼び、その結果と行の確定を一緒に書く。`stale`・`failed` の settle でも
	 * handler の書込みは残す。例外を投げる場合は呼び元で巻き戻す（`settleIsolated`）。
	 */
	function applyOutcome(
		db: Database,
		a: Parsed,
		input: unknown,
		outcome: SettleOutcome<unknown>,
		now: number,
	): Settled {
		const settled: SettleResult = a.handler.settleInTransaction(
			db,
			a.claim,
			input,
			outcome,
		);
		if (isThenable(settled)) throw new Error("async_transaction_callback");
		const id = a.claim.jobId;
		if (settled === "stale") {
			finishRow(
				db,
				id,
				{ state: "interrupted", errorCode: "stale_result" },
				now,
			);
			return { result: "settle_stale", state: "interrupted" };
		}
		if (typeof settled === "object") {
			finishRow(db, id, { state: "failed", errorCode: settled.errorCode }, now);
			return { result: "failed", state: "failed" };
		}
		switch (outcome.type) {
			case "success":
				finishRow(db, id, { state: "completed", errorCode: null }, now);
				return { result: "success", state: "completed" };
			case "retry":
				requeueRow(db, id, outcome.errorCode, outcome.availableAtMs, now);
				return { result: "retry", state: "queued" };
			case "failed":
				finishRow(
					db,
					id,
					{ state: "failed", errorCode: outcome.errorCode },
					now,
				);
				return { result: "failed", state: "failed" };
			case "expired":
				finishRow(
					db,
					id,
					{ state: "expired", errorCode: "deadline_exceeded" },
					now,
				);
				return { result: "expired", state: "expired" };
			case "interrupted":
				finishRow(
					db,
					id,
					{ state: "interrupted", errorCode: outcome.errorCode },
					now,
				);
				return { result: "interrupted", state: "interrupted" };
		}
	}

	/**
	 * `applyOutcome` を SAVEPOINT の中で行う。handler の settle が例外を投げたら（`queue_full`
	 * を含む）handler の書込みだけを巻き戻し、ジョブは interrupted（settle_failed）で終える。
	 * handler を呼び直さない。回復・期限切れ・prepare 失敗の経路と、通常の settle の 2 回目
	 * （failed で呼び直した後）で使う。この終了状態は呼び元の transaction で commit される。
	 */
	function settleIsolated(
		db: Database,
		a: Parsed,
		input: unknown,
		outcome: SettleOutcome<unknown>,
		now: number,
	): Settled {
		db.exec("SAVEPOINT host_settle");
		try {
			const applied = applyOutcome(db, a, input, outcome, now);
			db.exec("RELEASE host_settle");
			return applied;
		} catch {
			db.exec("ROLLBACK TO host_settle");
			db.exec("RELEASE host_settle");
			finishRow(
				db,
				a.claim.jobId,
				{ state: "interrupted", errorCode: "settle_failed" },
				now,
			);
			return { result: "settle_failed", state: "interrupted" };
		}
	}

	/** 自分が claim した、まだ running の行か。 */
	function ownedRunning(row: JobRow | null, claim: JobClaim<unknown>): boolean {
		return (
			row !== null &&
			row.state === "running" &&
			row.owner === runnerId &&
			row.attempt === claim.attempt
		);
	}

	// -- 起動時の回復 ---------------------------------------------------------

	function recoverTx(db: Database): RecoverReport {
		const now = clock.now();
		const report: RecoverReport = {
			requeued: [],
			interrupted: [],
			failed: [],
		};
		const rows = db
			.query("SELECT * FROM host_jobs WHERE state = 'running' ORDER BY seq")
			.all() as JobRow[];
		for (const row of rows) {
			const parsed = parseClaim(row);
			if (typeof parsed === "string") {
				finishRow(db, row.id, { state: "failed", errorCode: parsed }, now);
				report.failed.push(row.id);
				continue;
			}
			const replay =
				parsed.handler.recovery === "replay_safe" &&
				row.attempt < row.max_attempts &&
				(row.deadline_at_ms === null || now < row.deadline_at_ms);
			const outcome: SettleOutcome<unknown> = replay
				? { type: "retry", errorCode: "backend_restarted", availableAtMs: now }
				: { type: "interrupted", errorCode: "backend_restarted" };
			const applied = settleIsolated(db, parsed, null, outcome, now);
			if (applied.result === "retry") report.requeued.push(row.id);
			else if (applied.result === "failed") report.failed.push(row.id);
			else report.interrupted.push(row.id);
		}
		return report;
	}

	const ready = store.write(recoverTx);
	// 回復の失敗は ready を待つ側へ伝わる。待つ者がいなくても unhandled にしない。
	ready.catch(() => {});

	// -- step ---------------------------------------------------------------

	type Claimed =
		| { type: "none" }
		| { type: "done"; report: StepReport }
		| { type: "run"; a: Active; input: unknown; attempt: number };

	/**
	 * 1 つの write transaction で、最古の実行可能なジョブを claim し、期限を確かめ、prepare する
	 * （Eumenes の claimOne と同じ）。開始できない claim は failClaim と同じく failed にする。
	 */
	function claimNext(db: Database): Claimed {
		const now = clock.now();
		const candidate = db
			.query(
				`SELECT * FROM host_jobs WHERE state = 'queued' AND available_at_ms <= ? ORDER BY seq LIMIT 1`,
			)
			.get(now) as JobRow | null;
		if (!candidate) return { type: "none" };
		db.query(
			`UPDATE host_jobs SET state = 'running', attempt = attempt + 1, owner = ?, updated_at_ms = ? WHERE id = ?`,
		).run(runnerId, now, candidate.id);
		const row = getRow(db, candidate.id) as JobRow;
		const done = (result: StepResult, state: JobState): Claimed => ({
			type: "done",
			report: {
				status: "processed",
				jobId: row.id,
				kind: row.kind,
				attempt: row.attempt,
				result,
				state,
			},
		});
		const parsed = parseClaim(row);
		if (typeof parsed === "string") {
			finishRow(db, row.id, { state: "failed", errorCode: parsed }, now);
			return done("unclaimable", "failed");
		}
		const { handler, claim } = parsed;
		if (claim.deadlineAtMs !== null && now >= claim.deadlineAtMs) {
			const settled = settleIsolated(
				db,
				parsed,
				null,
				{ type: "expired" },
				now,
			);
			return done(settled.result, settled.state);
		}
		db.exec("SAVEPOINT host_prepare");
		let prepared: ReturnType<AnyJobHandler["prepareInTransaction"]>;
		try {
			prepared = handler.prepareInTransaction(db, claim);
			if (isThenable(prepared)) throw new Error("async_transaction_callback");
			db.exec("RELEASE host_prepare");
		} catch {
			db.exec("ROLLBACK TO host_prepare");
			db.exec("RELEASE host_prepare");
			const settled = settleIsolated(
				db,
				parsed,
				null,
				{ type: "failed", errorCode: "prepare_failed" },
				now,
			);
			return done(settled.result, settled.state);
		}
		if (prepared.status === "stale") {
			finishRow(
				db,
				row.id,
				{
					state: "cancelled",
					errorCode: SAFE_CODE.test(prepared.reason)
						? prepared.reason
						: "stale_prepare",
				},
				now,
			);
			return done("stale", "cancelled");
		}
		const a: Active = {
			controller: new AbortController(),
			claim,
			handler,
			deadlineHit: false,
			cancelled: false,
			shutdown: closing,
		};
		// transaction の中で登録する。取消の write はこの後ろに並ぶので、取り逃がさない。
		active.set(row.id, a);
		return { type: "run", a, input: prepared.input, attempt: row.attempt };
	}

	/** 結果を決める。期限は注入時計で判定する。 */
	function pickOutcome(
		a: Active,
		result: { ok: true; value: unknown } | { ok: false; error: unknown },
	): (row: JobRow, now: number) => SettleOutcome<unknown> {
		return (row, now) => {
			const late = row.deadline_at_ms !== null && now >= row.deadline_at_ms;
			if (result.ok)
				return late || a.deadlineHit
					? { type: "expired" }
					: { type: "success", result: result.value };
			if (a.shutdown) return { type: "interrupted", errorCode: "shutdown" };
			if (a.deadlineHit || late) return { type: "expired" };
			const errorCode = toErrorCode(result.error);
			let verdict: "retry" | "fail" = "fail";
			try {
				verdict = a.handler.classify(result.error);
			} catch {
				verdict = "fail";
			}
			if (verdict !== "retry" || row.attempt >= row.max_attempts)
				return { type: "failed", errorCode };
			const availableAtMs = now + retryDelayMs;
			if (row.deadline_at_ms !== null && availableAtMs >= row.deadline_at_ms)
				return { type: "failed", errorCode };
			return { type: "retry", errorCode, availableAtMs };
		};
	}

	async function runClaimed(
		claimed: Extract<Claimed, { type: "run" }>,
	): Promise<StepReport> {
		const { a, input, attempt } = claimed;
		const jobId = a.claim.jobId;
		const report = (result: StepResult, state: JobState): StepReport => ({
			status: "processed",
			jobId,
			kind: a.claim.kind,
			attempt,
			result,
			state,
		});
		try {
			if (closing) a.controller.abort();
			let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
			if (a.controller.signal.aborted) {
				outcome = { ok: false, error: new Error("aborted") };
			} else {
				try {
					outcome = {
						ok: true,
						value: await a.handler.execute(input, {
							signal: a.controller.signal,
							jobId,
							attempt,
						}),
					};
				} catch (error) {
					outcome = { ok: false, error };
				}
			}
			// 取消されたなら、遅れて返った結果は捨てる。
			if (a.cancelled) return report("discarded", "cancelled");
			const pick = pickOutcome(a, outcome);
			// 通常の settle（Eumenes の settle.ts と同じ）。業務の settle が例外を投げたらその write
			// transaction ごと巻き戻し、別の write transaction で failed (settle_failed) として
			// もう一度 handler を呼ぶ。2 回目も例外なら recovery と同じ扱い（settleIsolated）で終える。
			const first = await store.write((db): Settled | "threw" => {
				const now = clock.now();
				const row = getRow(db, jobId);
				if (!ownedRunning(row, a.claim))
					return { result: "discarded", state: row?.state ?? "cancelled" };
				db.exec("SAVEPOINT host_settle_first");
				try {
					const applied = applyOutcome(
						db,
						a,
						input,
						pick(row as JobRow, now),
						now,
					);
					db.exec("RELEASE host_settle_first");
					return applied;
				} catch {
					db.exec("ROLLBACK TO host_settle_first");
					db.exec("RELEASE host_settle_first");
					return "threw";
				}
			});
			if (first !== "threw") return report(first.result, first.state);
			const settled = await store.write((db): Settled => {
				const now = clock.now();
				const row = getRow(db, jobId);
				if (!ownedRunning(row, a.claim))
					return { result: "discarded", state: row?.state ?? "cancelled" };
				return settleIsolated(
					db,
					a,
					input,
					{ type: "failed", errorCode: "settle_failed" },
					now,
				);
			});
			return report(settled.result, settled.state);
		} finally {
			active.delete(jobId);
		}
	}

	function track<T>(promise: Promise<T>): Promise<T> {
		inflight.add(promise);
		const done = () => {
			inflight.delete(promise);
		};
		promise.then(done, done);
		return promise;
	}

	async function step(): Promise<StepReport> {
		await ready;
		if (closing) return { status: "idle" };
		let claimed: Claimed;
		let registered: string | null = null;
		try {
			claimed = await store.write((db) => {
				const result = claimNext(db);
				if (result.type === "run") registered = result.a.claim.jobId;
				return result;
			});
		} catch (error) {
			// commit されなかった claim の Active を残さない。
			if (registered !== null) active.delete(registered);
			throw error;
		}
		if (claimed.type === "none") return { status: "idle" };
		if (claimed.type === "done") return claimed.report;
		return runClaimed(claimed);
	}

	return {
		ready,
		step: () => track(step()),
		async runUntilIdle(opts = {}) {
			const maxSteps = opts.maxSteps ?? 100;
			const reports: StepReport[] = [];
			for (let i = 0; i < maxSteps; i++) {
				const report = await track(step());
				if (report.status === "idle") return { reports, idle: true };
				reports.push(report);
			}
			return { reports, idle: false };
		},
		async cancel(jobId, reason) {
			if (!SAFE_CODE.test(reason)) throw new Error("invalid_cancel_reason");
			await ready;
			const result = await store.write((db): CancelResult => {
				const row = getRow(db, jobId);
				if (!row) return "not_found";
				if (row.state !== "queued" && row.state !== "running")
					return "not_open";
				const parsed = parseClaim(row);
				if (typeof parsed !== "string")
					parsed.handler.cancelInTransaction(
						db,
						{ jobId, payload: parsed.claim.payload },
						reason,
					);
				finishRow(
					db,
					jobId,
					{ state: "cancelled", errorCode: reason },
					clock.now(),
				);
				return "cancelled";
			});
			if (result === "cancelled") {
				const a = active.get(jobId);
				if (a) {
					a.cancelled = true;
					a.controller.abort();
				}
			}
			return result;
		},
		expireDue() {
			const now = clock.now();
			const expired: string[] = [];
			for (const [jobId, a] of active) {
				if (
					a.claim.deadlineAtMs !== null &&
					now >= a.claim.deadlineAtMs &&
					!a.deadlineHit
				) {
					a.deadlineHit = true;
					a.controller.abort();
					expired.push(jobId);
				}
			}
			return expired;
		},
		getJob(jobId) {
			const row = store.read((db) => getRow(db, jobId));
			return row ? toView(row) : null;
		},
		listJobs() {
			return store
				.read(
					(db) =>
						db.query("SELECT * FROM host_jobs ORDER BY seq").all() as JobRow[],
				)
				.map(toView);
		},
		activeCount: () => active.size,
		async close() {
			closing = true;
			for (const a of active.values()) {
				a.shutdown = true;
				a.controller.abort();
			}
			await Promise.allSettled(inflight);
		},
	};
}
