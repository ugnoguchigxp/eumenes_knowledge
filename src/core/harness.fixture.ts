import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	SourceError,
	type DocumentInput,
	type DocumentListPage,
	type DocumentSourcePort,
	type FollowUpJob,
	type HandlerDeps,
	type JobClaim,
	type JobSink,
	type KnowledgeJobHandler,
	type SettleOutcome,
	type SettleResult,
	type SourceErrorCode,
	type Tx,
} from "../contracts/index.js";
import { migrations } from "../sqlite/index.js";
import {
	createIngestDocumentHandler,
	createSyncPageHandler,
	type IngestDocumentOptions,
} from "./index.js";

export function sha(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function makeDb(): Database {
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	return db;
}

export const docId = (n: number): string =>
	`wiki-${n.toString(16).padStart(32, "0")}`;

export type FakeDoc = { summary: DocumentInput; markdown: string };

export function makeDoc(
	n: number,
	markdown: string,
	over: Partial<DocumentInput> = {},
): DocumentInput {
	const markdownSha256 = sha(Buffer.from(markdown, "utf8"));
	return {
		sourceNamespace: "docling",
		documentId: docId(n),
		namespace: "wiki",
		path: `notes/${n}.md`,
		title: `Doc ${n}`,
		etag: `"${sha(`etag-${n}-${markdown}`)}"`,
		markdownSha256,
		contentDigest: sha(`${markdownSha256}\nrecovery`),
		markdown,
		...over,
	};
}

/** A scripted `DocumentSourcePort`. */
export class FakeSource implements DocumentSourcePort {
	docs = new Map<string, DocumentInput>();
	/** What the listing says; defaults to the stored docs, may be overridden per id. */
	listed = new Map<string, DocumentInput>();
	namespaces: string[] = ["wiki"];
	pageSize = 100;
	currentBinding: string | null = "binding-1";
	listFailsAt: string | null = null;
	listFailCode: SourceErrorCode = "invalid_response";
	readErrors = new Map<string, SourceErrorCode>();
	readOverride = new Map<string, DocumentInput>();
	listCalls = 0;
	readCalls = 0;
	onList: (() => void) | null = null;

	put(doc: DocumentInput): void {
		this.docs.set(doc.documentId, doc);
		this.listed.set(doc.documentId, doc);
	}
	remove(documentId: string): void {
		this.docs.delete(documentId);
		this.listed.delete(documentId);
	}
	binding(): string | null {
		return this.currentBinding;
	}
	async list(cursor: string | null): Promise<DocumentListPage> {
		this.listCalls += 1;
		this.onList?.();
		if (cursor !== null && cursor === this.listFailsAt) {
			throw new SourceError(this.listFailCode);
		}
		const all = [...this.listed.values()].sort((a, b) =>
			a.documentId.localeCompare(b.documentId),
		);
		const from = cursor === null ? 0 : Number(cursor);
		const slice = all.slice(from, from + this.pageSize);
		const end = from + this.pageSize;
		return {
			documents: slice.map(({ markdown: _m, ...summary }) => summary),
			namespaces: this.namespaces,
			nextCursor: end < all.length ? String(end) : null,
		};
	}
	async read(documentId: string): Promise<DocumentInput> {
		this.readCalls += 1;
		const err = this.readErrors.get(documentId);
		if (err) throw new SourceError(err);
		const over = this.readOverride.get(documentId);
		if (over) return over;
		const doc = this.docs.get(documentId);
		if (!doc) throw new SourceError("not_found");
		return doc;
	}
}

/**
 * Records every enqueue. Like the host queue, a dedupe key is unique whatever became of its job:
 * a key that was ever enqueued creates nothing again.
 */
export class FakeJobSink implements JobSink {
	calls: FollowUpJob[] = [];
	open: FollowUpJob[] = [];
	used = new Set<string>();
	throwOn: ((job: FollowUpJob) => boolean) | null = null;
	enqueueInTransaction(_tx: Tx, job: FollowUpJob): void {
		if (this.throwOn?.(job)) throw new Error("sink exploded");
		this.calls.push(job);
		if (this.used.has(job.dedupeKey)) return;
		this.used.add(job.dedupeKey);
		this.open.push(job);
	}
}

export class FakeClock {
	t = 1_700_000_000_000;
	now(): number {
		return this.t;
	}
}

export type Env = {
	db: Database;
	source: FakeSource;
	sink: FakeJobSink;
	clock: FakeClock;
	sync: ReturnType<typeof createSyncPageHandler>;
	ingest: ReturnType<typeof createIngestDocumentHandler>;
	events: Array<{ type: string; fields?: unknown }>;
};

export function makeEnv(options: IngestDocumentOptions = {}): Env {
	const db = makeDb();
	const source = new FakeSource();
	const sink = new FakeJobSink();
	const clock = new FakeClock();
	const events: Env["events"] = [];
	const deps: HandlerDeps = {
		source,
		jobs: sink,
		clock,
		events: (e) => events.push(e),
	};
	return {
		db,
		source,
		sink,
		clock,
		sync: createSyncPageHandler(deps),
		ingest: createIngestDocumentHandler(deps, options),
		events,
	};
}

export function claimOf<P>(kind: JobClaim<P>["kind"], payload: P): JobClaim<P> {
	return {
		jobId: randomUUID(),
		kind,
		payloadVersion: 1,
		payload,
		attempt: 1,
		maxAttempts: 3,
		deadlineAtMs: null,
	};
}

export type StepLog<O> = {
	prepared: "ready" | "stale";
	outcome?: SettleOutcome<O>;
	settled?: SettleResult;
	error?: unknown;
};

/** prepare -> execute -> settle, each transactional step in its own transaction. */
export async function runJob<P, I, O>(
	db: Database,
	handler: KnowledgeJobHandler<P, I, O>,
	payload: P,
	between?: () => void,
): Promise<StepLog<O>> {
	const claim = claimOf(handler.kind, payload);
	const prepared = db.transaction(() =>
		handler.prepareInTransaction(db, claim),
	)();
	if (prepared.status === "stale") return { prepared: "stale" };
	let outcome: SettleOutcome<O>;
	try {
		const result = await handler.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId: claim.jobId,
			attempt: 1,
		});
		outcome = { type: "success", result };
	} catch (error) {
		const settled = db.transaction(() =>
			handler.settleInTransaction(
				db,
				claim,
				prepared.input,
				handler.classify(error) === "retry"
					? { type: "retry", errorCode: "x", availableAtMs: 0 }
					: { type: "failed", errorCode: "execute_failed" },
			),
		)();
		return { prepared: "ready", error, settled };
	}
	between?.();
	const settled = db.transaction(() =>
		handler.settleInTransaction(db, claim, prepared.input, outcome),
	)();
	return { prepared: "ready", outcome, settled };
}

/**
 * Run every open job to the end, oldest first. Returns the number of jobs run and every step log,
 * with a safety bound so a bug cannot loop forever.
 */
export async function drain(
	env: Env,
): Promise<{ ran: number; logs: StepLog<unknown>[] }> {
	const logs: StepLog<unknown>[] = [];
	let ran = 0;
	while (env.sink.open.length > 0 && ran < 1000) {
		const job = env.sink.open.shift() as FollowUpJob;
		ran += 1;
		if (job.kind === "knowledge.sync-page") {
			const p = env.sync.schema.parse(job.payload);
			logs.push(await runJob(env.db, env.sync, p));
		} else {
			const p = env.ingest.schema.parse(job.payload);
			logs.push(await runJob(env.db, env.ingest, p));
		}
	}
	return { ran, logs };
}

/** Start a scan at page 0 and drain everything it caused. */
export async function syncAll(env: Env, scanId: string = randomUUID()) {
	const first = await runJob(env.db, env.sync, {
		scanId,
		cursor: null,
		page: 0,
	});
	const rest = await drain(env);
	return { scanId, first, rest };
}

export type Row = Record<string, unknown>;
export const rows = (
	db: Database,
	sql: string,
	...params: (string | number)[]
): Row[] => db.query<Row, (string | number)[]>(sql).all(...params);
