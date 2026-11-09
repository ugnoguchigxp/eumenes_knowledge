// examples ホストの組み立て。package の実装には依存せず、関数・migration を引数で受け取る。
import type { Hono } from "hono";
import type {
	AccessContext,
	Clock,
	DocumentSourcePort,
	EmbeddingPort,
	EventSink,
	FollowUpJob,
	HostWriter,
	InferencePort,
	IngestDeps,
	ReadEvidence,
	ReadGraph,
	ReadRelated,
	ReadScanInSnapshot,
	ReadStatusInSnapshot,
	Search,
	SearchOptions,
	SnapshotReader,
	StatusOptions,
	TokenizerPort,
	VectorIndex,
} from "../../src/contracts/index.js";
import { createExampleApp } from "./app.js";
import {
	createHostJobs,
	createJobRunner,
	jobsMigration,
	type AnyJobHandler,
	type HostJobs,
	type JobRunner,
	type QueueLimits,
} from "./runner.js";
import {
	createExampleTempDir,
	openExampleStore,
	removeExampleTempDir,
	type ExampleStore,
} from "./store.js";
import {
	createSyncRequests,
	syncRequestsMigration,
	type SyncRequests,
} from "./sync-requests.js";

/** handler の生成関数。P1 の依存に推論・埋め込み・HostWriter を足した `IngestDeps` を受ける。 */
export type HandlerFactory = (deps: IngestDeps) => AnyJobHandler;

export type ExampleHostOptions = {
	/** 指定すると、その中に DB を作る（host は消さない）。省略すると専用の一時ディレクトリを作る。 */
	dir?: string;
	/** 自分で作った一時ディレクトリを close で残す（確認用）。 */
	keep?: boolean;
	source: DocumentSourcePort;
	principals: Readonly<Record<string, AccessContext>>;
	clock: Clock;
	/** 取り込みが使う推論。必須。 */
	inference: InferencePort;
	/** 取り込みが使う埋め込み。必須。 */
	embedding: EmbeddingPort;
	/**
	 * モデルを使わない抽出（ingest の `extractor: "names"`）が使う tokenizer。省略すると package の
	 * 辞書なし tokenizer（charclass）。
	 */
	tokenizer?: TokenizerPort;
	handlerFactories: readonly HandlerFactory[];
	readStatusInSnapshot: ReadStatusInSnapshot;
	readScanInSnapshot: ReadScanInSnapshot;
	packageMigrations: readonly string[];
	statusOptions: StatusOptions;
	events?: EventSink;
	/**
	 * 検索 API の実装（package の `search`）。省略すると `/search` を持たない。
	 * 指定するときは `createVectorIndex` と `searchOptions` も要る。
	 */
	search?: Search;
	/** 根拠確認 API の実装（package の `readEvidence`）。省略すると `/evidence` を持たない。 */
	readEvidence?: ReadEvidence;
	/** 関連文書 API の実装（package の `readRelated`）。省略すると `/related` を持たない。`searchOptions` が要る。 */
	readRelated?: ReadRelated;
	/** 知識グラフ API の実装（package の `readGraph`）。省略すると `/graph` を持たない。`searchOptions` が要る。 */
	readGraph?: ReadGraph;
	/** host 1 つにつき 1 回だけ呼んで `VectorIndex` を作る（package の `createVectorIndex`）。 */
	createVectorIndex?: () => VectorIndex;
	/** 検索・根拠確認・関連文書へ `options` として渡す。 */
	searchOptions?: SearchOptions;
	/** enqueue 時にホストが与える期限。既定なし。 */
	deadlineFor?: (job: FollowUpJob, nowMs: number) => number | null;
	retryDelayMs?: number;
	/** 既定 1。1〜3 に丸める。 */
	maxAttempts?: number;
	/** 未完了ジョブの上限。既定は Eumenes と同じ。試験で小さくする。 */
	queueLimits?: QueueLimits;
};

export type ExampleHost = {
	app: Hono<{ Variables: { access: AccessContext } }>;
	store: ExampleStore;
	runner: JobRunner;
	jobs: HostJobs;
	/** ホストの受付記録。 */
	requests: SyncRequests;
	clock: Clock;
	/** 起動時の回復が終わると解決する。それまで API は 503 `server_starting`。 */
	ready: Promise<void>;
	/** 一時ディレクトリの絶対パス（自分で作った場合）。 */
	dir: string;
	close(): Promise<void>;
};

export function createExampleHost(options: ExampleHostOptions): ExampleHost {
	const { clock } = options;
	const { search, readEvidence, readRelated, readGraph, searchOptions } =
		options;
	if (
		(search || readEvidence || readRelated || readGraph) &&
		(searchOptions === undefined ||
			(search && options.createVectorIndex === undefined))
	) {
		throw new Error("search_wiring_required");
	}
	const jobs = createHostJobs({
		clock,
		deadlineFor: options.deadlineFor,
		maxAttempts: options.maxAttempts,
		limits: options.queueLimits,
	});
	// The store is opened below; the writer reaches it only when a job runs.
	let store: ExampleStore | undefined;
	// 1 回の呼出しが store の直列 writer の 1 つの短い transaction。callback は同期のみで、
	// Promise を返すと store が拒否して巻き戻す。
	const writer: HostWriter = {
		// store 側が Promise を返す callback を実行時に拒否する。型は T を素通しにする。
		write: (operation) => {
			if (!store) return Promise.reject(new Error("database_closing"));
			return store.write((db) => operation(db) as never);
		},
	};
	const deps: IngestDeps = {
		source: options.source,
		jobs: jobs.sink,
		clock,
		events: options.events,
		inference: options.inference,
		embedding: options.embedding,
		writer,
		// 指定したときだけ渡す（省略時は package 側の既定）。
		...(options.tokenizer ? { tokenizer: options.tokenizer } : {}),
	};
	// Build the handlers before creating anything on disk: a factory that throws leaves nothing.
	const handlers = options.handlerFactories.map((create) => create(deps));

	const ownsDir = options.dir === undefined;
	const dir = options.dir ?? createExampleTempDir();
	try {
		store = openExampleStore(dir, {
			packageMigrations: options.packageMigrations,
			hostMigrations: [jobsMigration, syncRequestsMigration],
		});
	} catch (error) {
		if (ownsDir) removeExampleTempDir(dir);
		throw error;
	}
	const opened = store;
	let runner: JobRunner;
	try {
		runner = createJobRunner({
			store: opened,
			clock,
			jobs,
			handlers,
			retryDelayMs: options.retryDelayMs,
		});
	} catch (error) {
		// Nothing has run yet: close the store, then remove the directory this host created.
		void opened.close().finally(() => {
			if (ownsDir) removeExampleTempDir(dir);
		});
		throw error;
	}
	const requests = createSyncRequests({
		store: opened,
		clock,
		jobs: jobs.sink,
		readScanInSnapshot: options.readScanInSnapshot,
	});
	// store 側が Promise を返す callback を実行時に拒否する。型は T を素通しにする。
	const readSnapshot: SnapshotReader = (operation) =>
		opened.readSnapshot((db) => operation(db) as never);
	const vectors = search ? options.createVectorIndex?.() : undefined;
	let starting = true;
	const ready = runner.ready.then(() => {
		starting = false;
	});
	// 回復に失敗したら starting のまま（全経路 503）にする。待つ者がいなくても unhandled にしない。
	ready.catch(() => {});
	const app = createExampleApp({
		principals: options.principals,
		isStarting: () => starting,
		readStatus: (access) =>
			opened.readSnapshot((db) =>
				options.readStatusInSnapshot(
					db,
					access,
					clock.now(),
					options.statusOptions,
				),
			),
		requestSync: requests.requestSync,
		getSyncRequest: requests.getSyncRequest,
		...(search && vectors && searchOptions
			? {
					search: (access, request, signal) =>
						search(
							{
								read: readSnapshot,
								embedding: options.embedding,
								vectors,
								clock,
								events: options.events,
								options: searchOptions,
							},
							access,
							request,
							signal,
						),
				}
			: {}),
		...(readEvidence && searchOptions
			? {
					readEvidence: (access, request) =>
						readEvidence(
							{
								read: readSnapshot,
								clock,
								options: searchOptions,
							},
							access,
							request,
						),
				}
			: {}),
		...(readRelated && searchOptions
			? {
					readRelated: (access, request) =>
						readRelated(
							{
								read: readSnapshot,
								clock,
								options: searchOptions,
							},
							access,
							request,
						),
				}
			: {}),
		...(readGraph && searchOptions
			? {
					readGraph: (access, request) =>
						readGraph(
							{
								read: readSnapshot,
								clock,
								options: searchOptions,
							},
							access,
							request,
						),
				}
			: {}),
	});
	let closed: Promise<void> | undefined;
	return {
		app,
		store: opened,
		runner,
		jobs,
		requests,
		clock,
		ready,
		dir,
		close() {
			closed ??= (async () => {
				try {
					await runner.close();
				} finally {
					try {
						await opened.close();
					} finally {
						if (ownsDir && options.keep !== true) removeExampleTempDir(dir);
					}
				}
			})();
			return closed;
		},
	};
}

export * from "./runner.js";
export * from "./store.js";
export * from "./sync-requests.js";
export { createExampleApp, MAX_BODY_BYTES } from "./app.js";
export type { ExampleAppOptions } from "./app.js";
