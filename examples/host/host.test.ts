import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncRequestSchema } from "../../src/contracts/index.js";
import {
	EXAMPLE_TEMP_PREFIX,
	openExampleStore,
	removeExampleTempDir,
} from "./store.js";
import {
	ALICE,
	BOB,
	cleanupHosts,
	deferred,
	FAKE_PACKAGE_SQL,
	makeHost,
	START_MS,
} from "./test-support.js";
import { jobsMigration } from "./runner.js";
import { syncRequestsMigration } from "./sync-requests.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

async function request(t: ReturnType<typeof makeHost>, access = ALICE) {
	await t.host.ready;
	const requestId = crypto.randomUUID();
	const result = await t.host.requests.requestSync(access, requestId);
	if (!result.ok) throw new Error("unexpected conflict");
	return { requestId, scanId: result.record.scanId };
}
const get = (
	t: ReturnType<typeof makeHost>,
	requestId: string,
	access = ALICE,
) => t.host.requests.getSyncRequest(access, requestId);

function setScan(
	t: ReturnType<typeof makeHost>,
	scanId: string,
	row: {
		state: string;
		pages: number;
		queued: number;
		errorCode?: string | null;
		finishedAt?: number | null;
	},
) {
	return t.host.store.write((db) => {
		db.query(
			"INSERT OR REPLACE INTO fake_scans (scan_id, state, pages, queued, error_code, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			scanId,
			row.state,
			row.pages,
			row.queued,
			row.errorCode ?? null,
			START_MS,
			row.finishedAt ?? null,
		);
	});
}

describe("受付記録の状態", () => {
	test("最初のページが claim される前は accepted、claim されると running", async () => {
		const t = makeHost();
		const { requestId } = await request(t);
		expect(get(t, requestId)?.state).toBe("accepted");
		const started = deferred();
		const gate = deferred<string>();
		t.control.execute = async () => {
			started.resolve();
			return gate.promise;
		};
		const stepping = t.host.runner.step();
		await started.promise;
		expect(get(t, requestId)).toMatchObject({
			state: "running",
			complete: false,
		});
		gate.resolve("x");
		await stepping;
	});

	test("走査の状態に従って running / completed / failed になる", async () => {
		const t = makeHost();
		const { requestId, scanId } = await request(t);
		await setScan(t, scanId, { state: "running", pages: 2, queued: 5 });
		expect(get(t, requestId)).toMatchObject({
			state: "running",
			complete: false,
			finishedAt: null,
		});
		const finishedAt = START_MS + 9_000;
		await setScan(t, scanId, {
			state: "complete",
			pages: 3,
			queued: 7,
			finishedAt,
		});
		expect(get(t, requestId)).toMatchObject({
			state: "completed",
			complete: true,
			finishedAt: new Date(finishedAt).toISOString(),
			errorCode: null,
		});
		await setScan(t, scanId, {
			state: "failed",
			pages: 1,
			queued: 0,
			errorCode: "binding_changed",
			finishedAt,
		});
		expect(get(t, requestId)).toMatchObject({
			state: "failed",
			complete: false,
			errorCode: "binding_changed",
		});
		syncRequestSchema.parse(get(t, requestId));
	});

	test("走査が記録される前に最初のジョブが失敗・取消されたら、accepted のままにしない", async () => {
		const t = makeHost();
		const failing = await request(t);
		t.control.execute = async () => {
			throw new Error("Boom!");
		};
		await t.host.runner.step();
		expect(get(t, failing.requestId)).toMatchObject({
			state: "failed",
			errorCode: "handler_failed",
		});
		const cancelled = await request(t);
		const job = t.host.runner.listJobs().find((j) => j.state === "queued");
		await t.host.runner.cancel(job?.id as string, "user_cancelled");
		expect(get(t, cancelled.requestId)?.state).toBe("cancelled");
	});

	test("本人の記録だけを返す（他人・未知は null）", async () => {
		const t = makeHost();
		const { requestId } = await request(t);
		expect(get(t, requestId, BOB)).toBeNull();
		expect(get(t, crypto.randomUUID())).toBeNull();
	});

	test("requestSync は同じ principal なら同じ記録。別 principal の同じ requestId は別の要求（conflict にしない）", async () => {
		const t = makeHost();
		await t.host.ready;
		const requestId = crypto.randomUUID();
		const first = await t.host.requests.requestSync(ALICE, requestId);
		const again = await t.host.requests.requestSync(ALICE, requestId);
		const other = await t.host.requests.requestSync(BOB, requestId);
		expect(first).toMatchObject({ ok: true, created: true });
		expect(again).toMatchObject({ ok: true, created: false });
		expect(again.ok && first.ok && again.record).toEqual(
			first.ok && first.record,
		);
		expect(other).toMatchObject({ ok: true, created: true });
		expect(other.ok && other.record.principal).toBe("bob");
		// 新規の要求は最初のページを入れる。2 件目は未完了の走査に相乗りするので入れない。
		expect(t.host.runner.listJobs()).toHaveLength(1);
		expect(t.host.requests.getSyncRequest(BOB, requestId)).not.toBeNull();
	});

	test("未完了の sync-page ジョブがある間は同じ走査に相乗りし、2 つの principal とも completed になる", async () => {
		const t = makeHost();
		const a = await request(t, ALICE);
		const b = await request(t, BOB);
		expect(b.scanId).toBe(a.scanId);
		expect(t.host.runner.listJobs()).toHaveLength(1);
		await t.host.runner.runUntilIdle();
		await setScan(t, a.scanId, {
			state: "complete",
			pages: 1,
			queued: 0,
			finishedAt: START_MS + 1_000,
		});
		expect(get(t, a.requestId, ALICE)).toMatchObject({
			state: "completed",
			complete: true,
		});
		expect(get(t, b.requestId, BOB)).toMatchObject({
			state: "completed",
			complete: true,
		});
	});

	test("未完了のジョブが無ければ新しい走査を始める", async () => {
		const t = makeHost();
		const a = await request(t, ALICE);
		await t.host.runner.runUntilIdle();
		const b = await request(t, BOB);
		expect(b.scanId).not.toBe(a.scanId);
		expect(t.host.runner.listJobs()).toHaveLength(2);
	});

	test("package が終えたと記録した走査には相乗りしない", async () => {
		const t = makeHost();
		const a = await request(t, ALICE);
		await setScan(t, a.scanId, {
			state: "failed",
			pages: 1,
			queued: 0,
			errorCode: "superseded",
			finishedAt: START_MS,
		});
		const b = await request(t, BOB);
		expect(b.scanId).not.toBe(a.scanId);
	});

	test("受付の errorCode は API の schema に合うコードだけ。合わなければ handler_failed", async () => {
		const t = makeHost();
		const a = await request(t, ALICE);
		t.control.execute = async () => {
			throw new Error("source:unavailable");
		};
		await t.host.runner.step();
		// ジョブの errorCode にコロンが入り得る（runner は `a:b` を許す）が、受付には出さない。
		expect(t.host.runner.listJobs()[0]?.errorCode).toBe("source:unavailable");
		const view = get(t, a.requestId, ALICE);
		expect(view).toMatchObject({
			state: "failed",
			errorCode: "handler_failed",
		});
		syncRequestSchema.parse(view);
	});
});

describe("後片付け", () => {
	test("close は runner を止め、DB 接続を閉じ、自分で作った一時ディレクトリを消す", async () => {
		const t = makeHost();
		await t.host.ready;
		const { dir, store } = t.host;
		expect(existsSync(dir)).toBe(true);
		await t.host.close();
		await t.host.close();
		expect(existsSync(dir)).toBe(false);
		expect(() => store.read((db) => db)).toThrow("database_closing");
		expect(t.host.runner.activeCount()).toBe(0);
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
	});

	test("keep のときは残し、lock は解放されて開き直せる。残したものは自分で消す", async () => {
		const t = makeHost({ keep: true });
		await t.host.ready;
		const dir = t.host.dir;
		await t.host.close();
		try {
			expect(existsSync(dir)).toBe(true);
			const reopened = openExampleStore(dir, {
				packageMigrations: FAKE_PACKAGE_SQL,
				hostMigrations: [jobsMigration, syncRequestsMigration],
			});
			await reopened.close();
		} finally {
			removeExampleTempDir(dir);
		}
		expect(existsSync(dir)).toBe(false);
	});

	test("dir を渡した場合は消さない", async () => {
		const first = makeHost();
		await first.host.ready;
		const dir = first.host.dir;
		const second = makeHost({ dir: `${dir}/inner` });
		await second.host.ready;
		await second.host.close();
		expect(existsSync(`${dir}/inner`)).toBe(true);
	});

	test("開くのに失敗したら一時ディレクトリを残さない", async () => {
		const listing = () =>
			new Set(
				readdirSync(tmpdir()).filter((name) =>
					name.startsWith(EXAMPLE_TEMP_PREFIX),
				),
			);
		const before = listing();
		expect(() =>
			makeHost({
				packageMigrations: ["CREATE TABLE a(x); SELECT * FROM nonexistent"],
			}),
		).toThrow();
		expect([...listing()].filter((name) => !before.has(name))).toEqual([]);
	});
});
