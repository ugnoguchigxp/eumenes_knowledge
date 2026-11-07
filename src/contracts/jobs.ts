import { z } from "zod";

/**
 * Job definitions in the shape of Eumenes' queue `HandlerDefinition` (structural; nothing is
 * imported from Eumenes). The three transactional callbacks are synchronous and run inside the
 * host's single writer transaction; a thrown error rolls that transaction back. `execute` runs
 * outside any transaction and must honour the signal. The package never opens a connection,
 * starts a transaction, schedules a timer or enqueues on its own: follow-up work goes to the
 * host's `JobSink` inside the settling transaction.
 */
/** A value SQLite accepts as a bound parameter. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** The part of a `bun:sqlite` prepared statement the package uses. */
export interface SqlStatement<Row> {
	get(...params: SqlValue[]): Row | null;
	all(...params: SqlValue[]): Row[];
	run(...params: SqlValue[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	};
}

/**
 * The host's connection, as far as the package uses it. Structural, so the published types do
 * not depend on bun-types (p0/distribution.md §4); a `bun:sqlite` `Database` satisfies it. The
 * package never calls `transaction`, `exec` or `close`: the host owns the transaction.
 */
export interface Tx {
	query<Row = unknown>(sql: string): SqlStatement<Row>;
}

export const KNOWLEDGE_JOB_KINDS = {
	syncPage: "knowledge.sync-page",
	/** P2: the single chain that ingests the registry's stale documents one by one (p2.md §3). */
	ingestNext: "knowledge.ingest-next",
	/** P3: the single chain that compares newly published mentions for identity, then summarizes (p3.md §8). */
	linkNext: "knowledge.link-next",
} as const;
export type KnowledgeJobKind =
	(typeof KNOWLEDGE_JOB_KINDS)[keyof typeof KNOWLEDGE_JOB_KINDS];

export type JobLane = "interactive" | "background";

export type JobClaim<P> = {
	jobId: string;
	kind: KnowledgeJobKind;
	payloadVersion: number;
	payload: P;
	attempt: number;
	maxAttempts: number;
	/** Epoch milliseconds, or null without a deadline. */
	deadlineAtMs: number | null;
};

export type PrepareResult<I> =
	| { status: "ready"; input: I }
	/** Nothing to do any more (superseded, cancelled, withdrawn). The host finishes the job without running it. */
	| { status: "stale"; reason: string };

export type SettleOutcome<O> =
	| { type: "success"; result: O }
	| { type: "retry"; errorCode: string; availableAtMs: number }
	| { type: "failed"; errorCode: string }
	| { type: "expired" }
	| { type: "interrupted"; errorCode: string };

export type SettleResult =
	| "applied"
	/** The result no longer matches the committed state (version, generation, binding): nothing was written. */
	| "stale"
	| { status: "failed"; errorCode: string };

/** A job the package asks the host to enqueue, inside the transaction that settles the current one. */
export type FollowUpJob = {
	kind: KnowledgeJobKind;
	payloadVersion: number;
	/** The host must not create a second open job with the same key. */
	dedupeKey: string;
	payload: unknown;
	lane: JobLane;
};

export interface JobSink {
	enqueueInTransaction(tx: Tx, job: FollowUpJob): void;
}

/**
 * The host's serialized writer, for work that must not hold one long transaction (p0.md #13,
 * p2.md §5). Each call is one short transaction on the host's single writer; the callback is
 * synchronous and a thrown error rolls that call back. Only `execute` uses it, to stage a
 * version in bounded batches; the transactional callbacks get their `tx` from the host.
 */
export interface HostWriter {
	write<T>(operation: (tx: Tx) => T): Promise<T>;
}

export interface KnowledgeJobHandler<P, I, O> {
	kind: KnowledgeJobKind;
	payloadVersions: readonly number[];
	schema: z.ZodType<P>;
	/** `replay_safe`: running again after a crash is harmless, because settle re-checks everything. */
	recovery: "replay_safe" | "interrupt";
	prepareInTransaction(tx: Tx, claim: JobClaim<P>): PrepareResult<I>;
	execute(
		input: I,
		context: { signal: AbortSignal; jobId: string; attempt: number },
	): Promise<O>;
	/** Whether an error thrown by `execute` is worth another attempt. */
	classify(error: unknown): "retry" | "fail";
	settleInTransaction(
		tx: Tx,
		claim: JobClaim<P>,
		input: I | null,
		outcome: SettleOutcome<O>,
	): SettleResult;
	cancelInTransaction(
		tx: Tx,
		job: { jobId: string; payload: P },
		reason: string,
	): void;
}

// ---------------------------------------------------------------------------
// Payloads (version 1)
// ---------------------------------------------------------------------------

/** One page of a listing scan. A scan is complete only when its last page settled under one binding. */
export const syncPagePayloadSchema = z.strictObject({
	scanId: z.uuid(),
	cursor: z.string().min(1).nullable(),
	/** 0 for the first page. */
	page: z.number().int().min(0).max(100_000),
});
export type SyncPagePayload = z.infer<typeof syncPagePayloadSchema>;

/**
 * Dedupe keys are derived from the payload, so the same observation never queues twice. A host
 * must treat a key as used once any job carried it (the Eumenes queue's semantics).
 */
export function syncPageDedupeKey(payload: SyncPagePayload): string {
	return `${KNOWLEDGE_JOB_KINDS.syncPage}:${payload.scanId}:${payload.page}`;
}

/**
 * One link of the ingest chain (p2.md §3). The registry hands out the sweep numbers, strictly
 * increasing, so every key is used once: at most one link is open at any time.
 */
export const ingestNextPayloadSchema = z.strictObject({
	sweep: z.number().int().min(0),
});
export type IngestNextPayload = z.infer<typeof ingestNextPayloadSchema>;
export function ingestNextDedupeKey(payload: IngestNextPayload): string {
	return `${KNOWLEDGE_JOB_KINDS.ingestNext}:${payload.sweep}`;
}

/** One link of the identity chain (p3.md §8). Same numbering rule as the ingest chain. */
export const linkNextPayloadSchema = z.strictObject({
	sweep: z.number().int().min(0),
});
export type LinkNextPayload = z.infer<typeof linkNextPayloadSchema>;
export function linkNextDedupeKey(payload: LinkNextPayload): string {
	return `${KNOWLEDGE_JOB_KINDS.linkNext}:${payload.sweep}`;
}
