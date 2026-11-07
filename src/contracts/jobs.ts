import { z } from "zod";
import {
	doclingDocumentIdSchema,
	sha256HexSchema,
	sourceNamespaceSchema,
} from "./documents.js";

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
	ingestDocument: "knowledge.ingest-document",
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

/** Ingest one document version observed by a listing. */
export const ingestDocumentPayloadSchema = z.strictObject({
	sourceNamespace: sourceNamespaceSchema,
	documentId: doclingDocumentIdSchema,
	markdownSha256: sha256HexSchema,
	/** The document's invalidation generation when the job was created (p0.md §2.2). */
	generation: z.number().int().min(0),
	/**
	 * The document's ingest retry counter when the job was created. Eumenes keeps a dedupe key
	 * unique for every job ever created (finished ones included), so a final failure of an
	 * ingest job advances this counter: a later scan then queues a fresh job for the same
	 * version, while a re-scan during a pending job still finds the same key.
	 */
	retry: z.number().int().min(0),
});
export type IngestDocumentPayload = z.infer<typeof ingestDocumentPayloadSchema>;

/**
 * Dedupe keys are derived from the payload, so the same observation never queues twice. A host
 * must treat a key as used once any job carried it (the Eumenes queue's semantics).
 */
export function syncPageDedupeKey(payload: SyncPagePayload): string {
	return `${KNOWLEDGE_JOB_KINDS.syncPage}:${payload.scanId}:${payload.page}`;
}
export function ingestDocumentDedupeKey(
	payload: IngestDocumentPayload,
): string {
	return `${KNOWLEDGE_JOB_KINDS.ingestDocument}:${payload.sourceNamespace}:${payload.documentId}:${payload.markdownSha256}:${payload.generation}:${payload.retry}`;
}
