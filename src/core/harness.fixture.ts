import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
	SourceError,
	type DocumentInput,
	type DocumentListPage,
	type DocumentSourcePort,
	type EmbeddingKind,
	type EmbeddingPort,
	type EmbeddingSpace,
	type FollowUpJob,
	type HostWriter,
	type InferencePort,
	type InferenceRequest,
	type InferenceResult,
	type IngestDeps,
	type IngestOptions,
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
	createIngestNextHandler,
	createSyncPageHandler,
	type IngestNextHandler,
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

const USAGE = {
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
};

export const inferenceOk = (text: string): InferenceResult => ({
	ok: true,
	text,
	model: "mock-model",
	usage: USAGE,
	durationMs: 1,
});

/** The fragment text a prompt built by `buildExtractionRequest` carries (the `---Input---` line). */
export function fragmentTextOf(request: InferenceRequest): string {
	const line = request.prompt.split("\n---Input---\n")[1]?.split("\n")[0];
	return (JSON.parse(line ?? "{}") as { text?: string }).text ?? "";
}

/** An answer with one entity (and, when the text is long enough, a second one and a relation). */
export function defaultAnswer(text: string): string {
	const chars = [...text];
	const quote1 = chars.slice(0, 3).join("");
	const quote2 = chars.slice(3, 6).join("");
	const entities = [
		{
			id: "e1",
			name: "N1",
			type: "thing",
			description: "d1",
			evidence: [quote1],
		},
		...(quote2.length > 0
			? [
					{
						id: "e2",
						name: "N2",
						type: "thing",
						description: "d2",
						evidence: [quote2],
					},
				]
			: []),
	];
	const relations =
		quote2.length > 0
			? [
					{
						id: "r1",
						source: "e1",
						target: "e2",
						directed: false,
						relation: "rel",
						description: "d",
						keywords: ["k"],
						qualifiers: {
							negated: false,
							condition: null,
							certainty: "stated",
						},
						evidence: [chars.slice(0, 6).join("")],
					},
				]
			: [];
	return JSON.stringify({
		entities: chars.length === 0 ? [] : entities,
		relations: chars.length === 0 ? [] : relations,
	});
}

/** A scripted `InferencePort`. */
export class FakeInference implements InferencePort {
	calls: InferenceRequest[] = [];
	/** Return a result, or throw. The default answers every fragment with `defaultAnswer`. */
	script: (
		request: InferenceRequest,
		call: number,
		signal: AbortSignal,
	) => InferenceResult | Promise<InferenceResult> = (request) =>
		inferenceOk(defaultAnswer(fragmentTextOf(request)));
	async complete(
		request: InferenceRequest,
		signal: AbortSignal,
	): Promise<InferenceResult> {
		this.calls.push(request);
		return this.script(request, this.calls.length, signal);
	}
}

export const SPACE: EmbeddingSpace = {
	modelId: "mock-embed",
	revision: "1",
	artifactDigest: "d".repeat(64),
	dimension: 4,
	queryPrefix: "query: ",
	passagePrefix: "passage: ",
};

/** A scripted `EmbeddingPort`: deterministic vectors, a space and hooks to break either. */
export class FakeEmbedding implements EmbeddingPort {
	calls: Array<{ texts: string[]; kind: EmbeddingKind }> = [];
	space: EmbeddingSpace = SPACE;
	/** Called before each answer (1-based call number); may throw, or change `space`. */
	onCall: ((call: number, signal: AbortSignal) => void | Promise<void>) | null =
		null;
	/** Rewrites the answer, for example to cut a vector short. */
	mutate:
		| ((
				answer: { vectors: number[][]; space: EmbeddingSpace },
				call: number,
		  ) => { vectors: number[][]; space: EmbeddingSpace })
		| null = null;
	async embed(
		texts: string[],
		kind: EmbeddingKind,
		signal: AbortSignal,
	): Promise<{ vectors: number[][]; space: EmbeddingSpace }> {
		this.calls.push({ texts: [...texts], kind });
		await this.onCall?.(this.calls.length, signal);
		const space = this.space;
		const vectors = texts.map((text) => {
			const digest = createHash("sha256").update(text).digest();
			return Array.from(
				{ length: space.dimension },
				(_, i) => (digest[i % digest.length]! + 1) / 256,
			);
		});
		const answer = { vectors, space };
		return this.mutate?.(answer, this.calls.length) ?? answer;
	}
}

/** The host's writer over the test database: one `db.transaction` per call. */
export class FakeWriter implements HostWriter {
	writes = 0;
	/** Runs before each write (1-based); may throw, or change what the next write sees. */
	beforeWrite: ((call: number) => void | Promise<void>) | null = null;
	constructor(private readonly db: Database) {}
	async write<T>(operation: (tx: Tx) => T): Promise<T> {
		this.writes += 1;
		await this.beforeWrite?.(this.writes);
		return this.db.transaction(() => operation(this.db))();
	}
}

export type Env = {
	db: Database;
	source: FakeSource;
	sink: FakeJobSink;
	clock: FakeClock;
	inference: FakeInference;
	embedding: FakeEmbedding;
	writer: FakeWriter;
	sync: ReturnType<typeof createSyncPageHandler>;
	ingest: IngestNextHandler;
	events: Array<{ type: string; fields?: unknown }>;
};

export function makeEnv(options: IngestOptions = {}): Env {
	const db = makeDb();
	const source = new FakeSource();
	const sink = new FakeJobSink();
	const clock = new FakeClock();
	const inference = new FakeInference();
	const embedding = new FakeEmbedding();
	const writer = new FakeWriter(db);
	const events: Env["events"] = [];
	const deps: IngestDeps = {
		source,
		jobs: sink,
		clock,
		events: (e) => events.push(e),
		inference,
		embedding,
		writer,
	};
	return {
		db,
		source,
		sink,
		clock,
		inference,
		embedding,
		writer,
		sync: createSyncPageHandler(deps, {
			maxUnappliedAttempts: options.maxUnappliedAttempts,
		}),
		// The contract types the handler's input and output as `unknown`; the tests look inside.
		ingest: createIngestNextHandler(deps, options) as IngestNextHandler,
		events,
	};
}

export function claimOf<P>(
	kind: JobClaim<P>["kind"],
	payload: P,
	deadlineAtMs: number | null = null,
): JobClaim<P> {
	return {
		jobId: randomUUID(),
		kind,
		payloadVersion: 1,
		payload,
		attempt: 1,
		maxAttempts: 3,
		deadlineAtMs,
	};
}

/** The host's error code of a thrown error: its message when that is a safe code. */
export function errorCodeOf(error: unknown): string {
	if (!(error instanceof Error) || !error.message) return "execution_failed";
	return /^[a-z][a-z0-9_:]{0,100}$/.test(error.message)
		? error.message
		: "handler_failed";
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
	opts: {
		signal?: AbortSignal;
		deadlineAtMs?: number | null;
		/**
		 * `once`: the host registers the job with one attempt (the Eumenes default), so an error
		 * the handler would retry is settled as `failed` at once.
		 */
		attempts?: "once";
	} = {},
): Promise<StepLog<O>> {
	const claim = claimOf(handler.kind, payload, opts.deadlineAtMs ?? null);
	const prepared = db.transaction(() =>
		handler.prepareInTransaction(db, claim),
	)();
	if (prepared.status === "stale") return { prepared: "stale" };
	let outcome: SettleOutcome<O>;
	try {
		const result = await handler.execute(prepared.input, {
			signal: opts.signal ?? new AbortController().signal,
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
				handler.classify(error) === "retry" && opts.attempts !== "once"
					? { type: "retry", errorCode: "x", availableAtMs: 0 }
					: { type: "failed", errorCode: errorCodeOf(error) },
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
	jobOptions: { attempts?: "once" } = {},
): Promise<{ ran: number; logs: StepLog<unknown>[] }> {
	const logs: StepLog<unknown>[] = [];
	let ran = 0;
	while (env.sink.open.length > 0 && ran < 1000) {
		const job = env.sink.open.shift() as FollowUpJob;
		ran += 1;
		if (job.kind === "knowledge.sync-page") {
			const p = env.sync.schema.parse(job.payload);
			logs.push(await runJob(env.db, env.sync, p, undefined, jobOptions));
		} else {
			const p = env.ingest.schema.parse(job.payload);
			logs.push(await runJob(env.db, env.ingest, p, undefined, jobOptions));
		}
	}
	return { ran, logs };
}

/** Start a scan at page 0 and drain everything it caused. */
export async function syncAll(
	env: Env,
	scanId: string = randomUUID(),
	jobOptions: { attempts?: "once" } = {},
) {
	const first = await runJob(
		env.db,
		env.sync,
		{
			scanId,
			cursor: null,
			page: 0,
		},
		undefined,
		jobOptions,
	);
	const rest = await drain(env, jobOptions);
	return { scanId, first, rest };
}

export type Row = Record<string, unknown>;
export const rows = (
	db: Database,
	sql: string,
	...params: (string | number)[]
): Row[] => db.query<Row, (string | number)[]>(sql).all(...params);
