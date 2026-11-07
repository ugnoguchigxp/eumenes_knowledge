// examples ホストの組み立て。package の実装には依存せず、関数・migration を引数で受け取る。
import type { Hono } from "hono";
import type {
	AccessContext,
	Clock,
	DocumentSourcePort,
	EventSink,
	FollowUpJob,
	HandlerDeps,
	ReadScanInSnapshot,
	ReadStatusInSnapshot,
	StatusOptions,
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

export type HandlerFactory = (deps: HandlerDeps) => AnyJobHandler;

export type ExampleHostOptions = {
	/** 指定すると、その中に DB を作る（host は消さない）。省略すると専用の一時ディレクトリを作る。 */
	dir?: string;
	/** 自分で作った一時ディレクトリを close で残す（確認用）。 */
	keep?: boolean;
	source: DocumentSourcePort;
	principals: Readonly<Record<string, AccessContext>>;
	clock: Clock;
	handlerFactories: readonly HandlerFactory[];
	readStatusInSnapshot: ReadStatusInSnapshot;
	readScanInSnapshot: ReadScanInSnapshot;
	packageMigrations: readonly string[];
	statusOptions: StatusOptions;
	events?: EventSink;
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
	const ownsDir = options.dir === undefined;
	const dir = options.dir ?? createExampleTempDir();
	let store: ExampleStore | undefined;
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
	const { clock } = options;
	const jobs = createHostJobs({
		clock,
		deadlineFor: options.deadlineFor,
		maxAttempts: options.maxAttempts,
		limits: options.queueLimits,
	});
	const deps: HandlerDeps = {
		source: options.source,
		jobs: jobs.sink,
		clock,
		events: options.events,
	};
	const runner = createJobRunner({
		store: opened,
		clock,
		jobs,
		handlers: options.handlerFactories.map((create) => create(deps)),
		retryDelayMs: options.retryDelayMs,
	});
	const requests = createSyncRequests({
		store: opened,
		clock,
		jobs: jobs.sink,
		readScanInSnapshot: options.readScanInSnapshot,
	});
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
