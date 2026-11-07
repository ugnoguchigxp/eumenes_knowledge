import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	KNOWLEDGE_JOB_KINDS,
	type FollowUpJob,
} from "../../src/contracts/index.js";
import type { EnqueueOptions } from "./runner.js";
import { createExampleTempDir, removeExampleTempDir } from "./store.js";
import {
	cleanupHosts,
	count,
	deferred,
	makeHost,
	newControl,
	syncPageJob,
	type TestHost,
} from "./test-support.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

function enqueue(t: TestHost, job: FollowUpJob, options?: EnqueueOptions) {
	return t.host.store.write((db) =>
		t.host.jobs.enqueueInTransaction(db, job, options),
	);
}

class CodedError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

describe("基本の流れ", () => {
	test("claim → prepare → execute → settle で完了し、次は idle", async () => {
		const t = makeHost();
		await t.host.ready;
		const id = await enqueue(t, syncPageJob());
		expect(id).not.toBeNull();
		const report = await t.host.runner.step();
		expect(report).toMatchObject({
			status: "processed",
			jobId: id,
			attempt: 1,
			result: "success",
			state: "completed",
		});
		expect(t.control.prepareCalls).toEqual([id as string]);
		expect(t.control.executeCalls).toEqual([id as string]);
		expect(t.control.settleCalls).toEqual([
			{ jobId: id as string, type: "success", inputNull: false },
		]);
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		expect(t.host.runner.getJob(id as string)?.state).toBe("completed");
	});

	test("prepare は write transaction の中で呼ばれ、execute は transaction の外で呼ばれる", async () => {
		const t = makeHost();
		let inWriteDuringPrepare = false;
		let writeAvailableDuringExecute = false;
		t.control.prepare = () => {
			// prepare 中の書込みは同じ transaction。別の write はまだ始まれない。
			inWriteDuringPrepare = true;
			return { status: "ready", input: "x" };
		};
		t.control.execute = async () => {
			// execute 中は writer が空いている。
			await t.host.store.write(() => {
				writeAvailableDuringExecute = true;
			});
			return "r";
		};
		await enqueue(t, syncPageJob());
		await t.host.runner.step();
		expect(inWriteDuringPrepare).toBe(true);
		expect(writeAvailableDuringExecute).toBe(true);
	});

	test("最古の実行可能なジョブから 1 件ずつ。runUntilIdle は idle まで進む", async () => {
		const t = makeHost();
		const ids = [];
		for (let page = 0; page < 3; page++)
			ids.push(await enqueue(t, syncPageJob(page)));
		const { reports, idle } = await t.host.runner.runUntilIdle();
		expect(idle).toBe(true);
		expect(
			reports.map((r) => (r.status === "processed" ? r.jobId : null)),
		).toEqual(ids);
	});

	test("runUntilIdle は maxSteps で止まり、idle ではないと報告する", async () => {
		const t = makeHost();
		for (let page = 0; page < 3; page++) await enqueue(t, syncPageJob(page));
		const first = await t.host.runner.runUntilIdle({ maxSteps: 2 });
		expect(first.idle).toBe(false);
		expect(first.reports).toHaveLength(2);
		const rest = await t.host.runner.runUntilIdle({ maxSteps: 2 });
		expect(rest).toMatchObject({ idle: true });
		expect(rest.reports).toHaveLength(1);
	});

	test("available_at が時計より先のジョブは claim されない", async () => {
		const t = makeHost();
		await enqueue(t, syncPageJob(), { availableAtMs: t.clock.now() + 500 });
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		t.clock.advance(500);
		expect((await t.host.runner.step()).status).toBe("processed");
	});

	test("後続ジョブは settle と同じ transaction で入り、同じ dedupe key は作らない", async () => {
		const t = makeHost();
		const scanId = crypto.randomUUID();
		t.control.followUps = () => [
			syncPageJob(1, scanId),
			syncPageJob(1, scanId),
		];
		await enqueue(t, syncPageJob(0, scanId));
		await t.host.runner.step();
		expect(count(t.host, "host_jobs")).toBe(2);
		const next = t.host.runner.listJobs()[1];
		expect(next?.state).toBe("queued");
	});
});

describe("prepare", () => {
	test("stale は実行も settle もせずに cancelled（理由は errorCode）で終える", async () => {
		const t = makeHost();
		t.control.prepare = () => ({ status: "stale", reason: "superseded" });
		const id = (await enqueue(t, syncPageJob())) as string;
		const report = await t.host.runner.step();
		expect(report).toMatchObject({ result: "stale", state: "cancelled" });
		expect(t.control.executeCalls).toEqual([]);
		expect(t.control.settleCalls).toEqual([]);
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "cancelled",
			errorCode: "superseded",
		});
	});

	test("prepare が例外を投げたら巻き戻し、failed として settle する", async () => {
		const t = makeHost();
		t.control.prepare = () => {
			throw new Error("prepare exploded");
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const report = await t.host.runner.step();
		expect(report).toMatchObject({ result: "failed", state: "failed" });
		expect(t.host.runner.getJob(id)?.errorCode).toBe("prepare_failed");
		expect(t.control.settleCalls).toEqual([
			{ jobId: id, type: "failed", inputNull: true },
		]);
		expect(t.control.executeCalls).toEqual([]);
	});

	test("登録されていない kind は enqueue で拒否し、保存済みで handler が無くなったものは開始せず failed にする", async () => {
		const dir = createExampleTempDir();
		try {
			const a = makeHost({ dir });
			await a.host.ready;
			const foreign: FollowUpJob = {
				...syncPageJob(),
				kind: KNOWLEDGE_JOB_KINDS.ingestNext,
			};
			await expect(enqueue(a, foreign)).rejects.toThrow(
				"invalid_unknown_job_kind",
			);
			await expect(
				enqueue(a, { ...syncPageJob(), payload: { page: "x" } }),
			).rejects.toThrow("invalid_job_payload");
			await expect(
				enqueue(a, { ...syncPageJob(), payloadVersion: 9 }),
			).rejects.toThrow("invalid_payload_version");
			const id = (await enqueue(a, syncPageJob())) as string;
			await a.host.close();
			const b = makeHost({ dir, handlerFactories: [] });
			expect(await b.host.runner.step()).toMatchObject({
				result: "unclaimable",
				state: "failed",
			});
			expect(b.host.runner.getJob(id)?.errorCode).toBe(
				"handler_not_registered",
			);
		} finally {
			await cleanupHosts();
			removeExampleTempDir(dir);
		}
	});
});

describe("retry と failed", () => {
	test("retry は注入時計で固定の待ちを進めると再実行され、成功できる", async () => {
		const t = makeHost({ retryDelayMs: 2_000, maxAttempts: 3 });
		let calls = 0;
		t.control.classify = () => "retry";
		t.control.execute = async () => {
			calls++;
			if (calls === 1) throw new CodedError("source_unavailable");
			return "ok";
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const first = await t.host.runner.step();
		expect(first).toMatchObject({
			result: "retry",
			state: "queued",
			attempt: 1,
		});
		const queued = t.host.runner.getJob(id);
		expect(queued).toMatchObject({
			errorCode: "source_unavailable",
			availableAtMs: t.clock.now() + 2_000,
		});
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		t.clock.advance(1_999);
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		t.clock.advance(1);
		const second = await t.host.runner.step();
		expect(second).toMatchObject({ result: "success", attempt: 2 });
		expect(t.control.settleCalls.map((c) => c.type)).toEqual([
			"retry",
			"success",
		]);
	});

	test("maxAttempts を超えたら failed", async () => {
		const t = makeHost({ maxAttempts: 3 });
		t.control.classify = () => "retry";
		t.control.execute = async () => {
			throw new CodedError("source_unavailable");
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const results = [];
		for (let i = 0; i < 3; i++) {
			const report = await t.host.runner.step();
			results.push(report.status === "processed" ? report.result : "idle");
			t.clock.advance(1_000);
		}
		expect(results).toEqual(["retry", "retry", "failed"]);
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "failed",
			attempt: 3,
			errorCode: "source_unavailable",
		});
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
	});

	test("既定の maxAttempts は 1: retry と分類されても再試行せず failed", async () => {
		const t = makeHost();
		t.control.classify = () => "retry";
		t.control.execute = async () => {
			throw new CodedError("source_unavailable");
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({ result: "failed" });
		expect(t.host.runner.getJob(id)).toMatchObject({
			maxAttempts: 1,
			state: "failed",
		});
	});

	test("maxAttempts は 1〜3 に丸める", async () => {
		const t = makeHost();
		const ids = [];
		for (const [page, maxAttempts] of [
			[0, 0],
			[1, 2],
			[2, 99],
		] as const)
			ids.push(await enqueue(t, syncPageJob(page), { maxAttempts }));
		expect(
			ids.map((id) => t.host.runner.getJob(id as string)?.maxAttempts),
		).toEqual([1, 2, 3]);
	});

	test("コードにならない例外は handler_failed、Error でない throw は execution_failed", async () => {
		const t = makeHost();
		t.control.execute = async () => {
			throw new Error("Secret text must not become a code");
		};
		const first = (await enqueue(t, syncPageJob(0))) as string;
		await t.host.runner.step();
		expect(t.host.runner.getJob(first)?.errorCode).toBe("handler_failed");
		t.control.execute = () => Promise.reject("plain string");
		const second = (await enqueue(t, syncPageJob(1))) as string;
		await t.host.runner.step();
		expect(t.host.runner.getJob(second)?.errorCode).toBe("execution_failed");
	});

	test("settle が failed を返すとジョブも failed", async () => {
		const t = makeHost();
		t.control.settleResult = { status: "failed", errorCode: "digest_mismatch" };
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({ result: "failed" });
		expect(t.host.runner.getJob(id)?.errorCode).toBe("digest_mismatch");
		// handler の書込みは commit される
		expect(count(t.host, "fake_log")).toBe(1);
	});

	test("settle が stale を返すと handler の書込みは残り、ジョブは interrupted (stale_result)", async () => {
		const t = makeHost();
		t.control.settleResult = "stale";
		t.control.followUps = () => [syncPageJob(1)];
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "settle_stale",
			state: "interrupted",
		});
		expect(t.host.runner.getJob(id)?.errorCode).toBe("stale_result");
		// settle の書込み（記録と後続）が commit されている
		expect(
			t.host.store.read((db) =>
				db.query("SELECT job_id, outcome FROM fake_log").all(),
			),
		).toEqual([{ job_id: id, outcome: "success" }]);
		expect(count(t.host, "host_jobs")).toBe(2);
	});

	test("settle が 2 回とも例外なら、handler の書込みだけ巻き戻り、ジョブは interrupted (settle_failed) で再試行されない", async () => {
		const t = makeHost({ maxAttempts: 3 });
		t.control.classify = () => "retry";
		t.control.settleThrows = true;
		t.control.followUps = () => [syncPageJob(1)];
		const id = (await enqueue(t, syncPageJob())) as string;
		const report = await t.host.runner.step();
		expect(report).toMatchObject({
			result: "settle_failed",
			state: "interrupted",
		});
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "interrupted",
			errorCode: "settle_failed",
			attempt: 1,
		});
		// 1 回目（success）と、failed での呼び直しの 2 回。
		expect(t.control.settleCalls.map((c) => c.type)).toEqual([
			"success",
			"failed",
		]);
		// handler の書込み（記録と後続）は残らない。ジョブの終了状態は commit されている。
		expect(count(t.host, "fake_log")).toBe(0);
		expect(count(t.host, "host_jobs")).toBe(1);
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		// その後も他のジョブは動く
		t.control.settleThrows = false;
		await enqueue(t, syncPageJob(5));
		expect(await t.host.runner.step()).toMatchObject({ result: "success" });
	});

	test("settle が 1 回目だけ例外なら、1 回目の書込みは巻き戻り、failed で呼び直されて applied ならジョブは failed (settle_failed)", async () => {
		const t = makeHost({ maxAttempts: 3 });
		t.control.classify = () => "retry";
		t.control.settleThrowTimes = 1;
		t.control.followUps = () => [syncPageJob(1)];
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "failed",
			state: "failed",
		});
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "failed",
			errorCode: "settle_failed",
		});
		expect(t.control.settleCalls.map((c) => c.type)).toEqual([
			"success",
			"failed",
		]);
		// 1 回目の記録と後続は巻き戻り、2 回目（failed）の記録だけが残る。
		expect(
			t.host.store.read((db) =>
				db.query("SELECT job_id, outcome FROM fake_log").all(),
			),
		).toEqual([{ job_id: id, outcome: "failed" }]);
		expect(count(t.host, "host_jobs")).toBe(1);
	});

	test("呼び直した settle が stale・failed を返したら、通常の settle と同じに扱う", async () => {
		const t = makeHost();
		t.control.settleThrowTimes = 1;
		t.control.settleResult = "stale";
		const stale = (await enqueue(t, syncPageJob(0))) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "settle_stale",
			state: "interrupted",
		});
		expect(t.host.runner.getJob(stale)?.errorCode).toBe("stale_result");
		t.control.settleThrowTimes = 1;
		t.control.settleResult = { status: "failed", errorCode: "digest_mismatch" };
		const failed = (await enqueue(t, syncPageJob(1))) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "failed",
			state: "failed",
		});
		expect(t.host.runner.getJob(failed)?.errorCode).toBe("digest_mismatch");
	});

	test("settle 中の enqueue が queue_full になると 1 回目は巻き戻り、failed で handler が呼び直される（2 回目の書込みは残る）", async () => {
		// scope の上限 1: 実行中の自分自身が 1 件を占めるので、後続を入れる settle は queue_full になる。
		const t = makeHost({
			queueLimits: { total: 10, background: 10, scope: 1 },
		});
		t.control.followUps = () => [syncPageJob(1)];
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "failed",
			state: "failed",
		});
		expect(t.host.runner.getJob(id)?.errorCode).toBe("settle_failed");
		expect(
			t.host.store.read((db) =>
				db.query("SELECT job_id, outcome FROM fake_log").all(),
			),
		).toEqual([{ job_id: id, outcome: "failed" }]);
		expect(count(t.host, "host_jobs")).toBe(1);
	});

	test("settle 中の queue_full で、呼び直しの settle も例外なら interrupted (settle_failed)", async () => {
		const t = makeHost({
			queueLimits: { total: 10, background: 10, scope: 1 },
		});
		t.control.followUps = () => [syncPageJob(1)];
		// 1 回目は queue_full で投げる。呼び直し（failed）では後続を入れないので、ここで投げさせる。
		t.control.settleThrowTimes = 1;
		const id = (await enqueue(t, syncPageJob())) as string;
		expect(await t.host.runner.step()).toMatchObject({
			result: "settle_failed",
			state: "interrupted",
		});
		expect(t.host.runner.getJob(id)?.errorCode).toBe("settle_failed");
		expect(count(t.host, "fake_log")).toBe(0);
	});
});

describe("取消", () => {
	test("実行中の取消は abort し、cancelInTransaction を呼び、遅れて返った結果を捨てる", async () => {
		const t = makeHost();
		const started = deferred();
		const gate = deferred<string>();
		let signal: AbortSignal | undefined;
		t.control.execute = async (_input, context) => {
			signal = context.signal;
			started.resolve();
			return gate.promise;
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const stepping = t.host.runner.step();
		await started.promise;
		expect(t.host.runner.activeCount()).toBe(1);
		expect(await t.host.runner.cancel(id, "user_cancelled")).toBe("cancelled");
		expect(signal?.aborted).toBe(true);
		expect(t.control.cancelCalls).toEqual([
			{ jobId: id, reason: "user_cancelled" },
		]);
		gate.resolve("late result");
		const report = await stepping;
		expect(report).toMatchObject({ result: "discarded", state: "cancelled" });
		expect(t.control.settleCalls).toEqual([]);
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "cancelled",
			errorCode: "user_cancelled",
		});
		expect(t.host.runner.activeCount()).toBe(0);
		// 取消の記録だけが残り、成功の記録は無い
		expect(
			t.host.store.read((db) => db.query("SELECT outcome FROM fake_log").all()),
		).toEqual([{ outcome: "cancel" }]);
	});

	test("待ちの取消、終わったジョブ、未知のジョブ", async () => {
		const t = makeHost();
		const queued = (await enqueue(t, syncPageJob(0))) as string;
		expect(await t.host.runner.cancel(queued, "user_cancelled")).toBe(
			"cancelled",
		);
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		expect(await t.host.runner.cancel(queued, "user_cancelled")).toBe(
			"not_open",
		);
		expect(await t.host.runner.cancel("missing", "user_cancelled")).toBe(
			"not_found",
		);
		await expect(t.host.runner.cancel(queued, "Not A Code!")).rejects.toThrow(
			"invalid_cancel_reason",
		);
	});

	test("cancelInTransaction が例外なら取消ごと巻き戻り、ジョブは実行中のまま", async () => {
		const t = makeHost();
		const started = deferred();
		const gate = deferred<string>();
		t.control.execute = async () => {
			started.resolve();
			return gate.promise;
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const stepping = t.host.runner.step();
		await started.promise;
		// 取消側の handler が失敗する状況を作る: cancelCalls の push 後に投げさせる
		const original = t.control.cancelCalls.push.bind(t.control.cancelCalls);
		t.control.cancelCalls.push = (...items) => {
			original(...items);
			throw new Error("cancel exploded");
		};
		await expect(t.host.runner.cancel(id, "user_cancelled")).rejects.toThrow(
			"cancel exploded",
		);
		expect(t.host.runner.getJob(id)?.state).toBe("running");
		expect(t.host.runner.activeCount()).toBe(1);
		gate.resolve("fine");
		expect(await stepping).toMatchObject({ result: "success" });
	});
});

describe("期限", () => {
	test("prepare 前に期限を過ぎていれば prepare せず expired で settle する", async () => {
		const t = makeHost();
		const id = (await enqueue(t, syncPageJob(), {
			deadlineAtMs: t.clock.now() + 500,
		})) as string;
		t.clock.advance(500);
		const report = await t.host.runner.step();
		expect(report).toMatchObject({ result: "expired", state: "expired" });
		expect(t.control.prepareCalls).toEqual([]);
		expect(t.control.executeCalls).toEqual([]);
		expect(t.control.settleCalls).toEqual([
			{ jobId: id, type: "expired", inputNull: true },
		]);
		expect(t.host.runner.getJob(id)?.errorCode).toBe("deadline_exceeded");
	});

	test("settle 前に期限を過ぎていれば、成功した結果でも expired", async () => {
		const t = makeHost();
		const started = deferred();
		const gate = deferred<string>();
		t.control.execute = async () => {
			started.resolve();
			return gate.promise;
		};
		const id = (await enqueue(t, syncPageJob(), {
			deadlineAtMs: t.clock.now() + 1_000,
		})) as string;
		const stepping = t.host.runner.step();
		await started.promise;
		t.clock.advance(1_000);
		gate.resolve("late");
		expect(await stepping).toMatchObject({ result: "expired" });
		expect(t.control.settleCalls).toEqual([
			{ jobId: id, type: "expired", inputNull: false },
		]);
	});

	test("expireDue は期限を過ぎた実行中ジョブだけ abort し、戻った結果は expired として settle する", async () => {
		const t = makeHost();
		const started = deferred();
		let signal: AbortSignal | undefined;
		t.control.execute = (_input, context) => {
			signal = context.signal;
			started.resolve();
			return new Promise<string>((_resolve, reject) => {
				context.signal.addEventListener("abort", () =>
					reject(new CodedError("cancelled")),
				);
			});
		};
		const id = (await enqueue(t, syncPageJob(), {
			deadlineAtMs: t.clock.now() + 1_000,
		})) as string;
		const stepping = t.host.runner.step();
		await started.promise;
		expect(t.host.runner.expireDue()).toEqual([]);
		t.clock.advance(1_000);
		expect(t.host.runner.expireDue()).toEqual([id]);
		expect(t.host.runner.expireDue()).toEqual([]);
		expect(signal?.aborted).toBe(true);
		expect(await stepping).toMatchObject({
			result: "expired",
			state: "expired",
		});
		expect(t.host.runner.getJob(id)?.state).toBe("expired");
	});

	test("retry の待ちが期限を越えるなら retry せず failed", async () => {
		const t = makeHost();
		t.control.classify = () => "retry";
		t.control.execute = async () => {
			throw new CodedError("source_unavailable");
		};
		await enqueue(t, syncPageJob(), { deadlineAtMs: t.clock.now() + 500 });
		expect(await t.host.runner.step()).toMatchObject({ result: "failed" });
	});

	test("期限は enqueue 時にホストが与える（deadlineFor）。既定は期限なし", async () => {
		const none = makeHost();
		const id0 = (await enqueue(none, syncPageJob())) as string;
		expect(none.host.runner.getJob(id0)?.deadlineAtMs).toBeNull();
		const withDeadline = makeHost({ deadlineFor: (_job, now) => now + 300 });
		const id1 = (await enqueue(withDeadline, syncPageJob())) as string;
		expect(withDeadline.host.runner.getJob(id1)?.deadlineAtMs).toBe(
			withDeadline.clock.now() + 300,
		);
	});
});

describe("enqueue と dedupe", () => {
	test("enqueue した transaction が巻き戻ればジョブも残らない", async () => {
		const t = makeHost();
		await expect(
			t.host.store.write((db) => {
				t.host.jobs.sink.enqueueInTransaction(db, syncPageJob());
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(count(t.host, "host_jobs")).toBe(0);
	});

	test("同じ dedupe key は完了・失敗済みでも新しいジョブを作らない", async () => {
		const t = makeHost();
		const job = syncPageJob();
		expect(await enqueue(t, job)).not.toBeNull();
		expect(await enqueue(t, job)).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(1);
		await t.host.runner.step();
		expect(t.host.runner.listJobs()[0]?.state).toBe("completed");
		expect(await enqueue(t, job)).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(1);
		// 失敗済みも同じ
		t.control.execute = async () => {
			throw new CodedError("source_unavailable");
		};
		const failing = syncPageJob(1);
		await enqueue(t, failing);
		await t.host.runner.step();
		expect(t.host.runner.listJobs()[1]?.state).toBe("failed");
		expect(await enqueue(t, failing)).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(2);
		// 取消済みも同じ
		const cancelled = syncPageJob(2);
		const id = (await enqueue(t, cancelled)) as string;
		await t.host.runner.cancel(id, "user_cancelled");
		expect(await enqueue(t, cancelled)).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(3);
	});

	test("同じ key で payload・lane が違えば request_conflict。キーの順序だけの違いは同じ", async () => {
		const t = makeHost();
		const job = syncPageJob();
		await enqueue(t, job);
		const payload = job.payload as {
			scanId: string;
			cursor: null;
			page: number;
		};
		await expect(
			enqueue(t, { ...job, payload: { ...payload, cursor: "next" } }),
		).rejects.toThrow("request_conflict");
		await expect(enqueue(t, { ...job, lane: "background" })).rejects.toThrow(
			"request_conflict",
		);
		await expect(
			enqueue(t, { ...job, payloadVersion: 1 }, { maxAttempts: 2 }),
		).rejects.toThrow("request_conflict");
		const reordered = {
			page: payload.page,
			cursor: payload.cursor,
			scanId: payload.scanId,
		};
		expect(await enqueue(t, { ...job, payload: reordered })).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(1);
	});

	test("未完了ジョブが上限に達すると queue_full。終わると入る", async () => {
		const t = makeHost({
			queueLimits: { total: 2, background: 10, scope: 10 },
		});
		const first = syncPageJob(0);
		await enqueue(t, first);
		await enqueue(t, syncPageJob(1));
		await expect(enqueue(t, syncPageJob(2))).rejects.toThrow("queue_full");
		// 既存の key は上限でも重複として扱う（queue_full ではない）
		expect(await enqueue(t, first)).toBeNull();
		expect(count(t.host, "host_jobs")).toBe(2);
		await t.host.runner.step();
		expect(await enqueue(t, syncPageJob(2))).not.toBeNull();
	});

	test("background と scope の上限もそれぞれ数える", async () => {
		const t = makeHost({
			queueLimits: { total: 10, background: 1, scope: 3 },
		});
		await enqueue(t, { ...syncPageJob(0), lane: "background" });
		await expect(
			enqueue(t, { ...syncPageJob(1), lane: "background" }),
		).rejects.toThrow("queue_full");
		// interactive は background の上限に掛からないが、scope の上限には掛かる
		await enqueue(t, syncPageJob(2));
		await enqueue(t, syncPageJob(3));
		await expect(enqueue(t, syncPageJob(4))).rejects.toThrow("queue_full");
	});

	test("実行中のジョブと同じ key も作らない", async () => {
		const t = makeHost();
		const started = deferred();
		const gate = deferred<string>();
		t.control.execute = async () => {
			started.resolve();
			return gate.promise;
		};
		const job = syncPageJob();
		await enqueue(t, job);
		const stepping = t.host.runner.step();
		await started.promise;
		expect(await enqueue(t, job)).toBeNull();
		gate.resolve("x");
		await stepping;
	});
});

describe("再起動", () => {
	async function crashWhileRunning(
		recovery: "replay_safe" | "interrupt",
		maxAttempts = 3,
	) {
		const dir = createExampleTempDir();
		const first = newControl();
		first.recovery = recovery;
		const started = deferred();
		const gate = deferred<string>();
		first.execute = async () => {
			started.resolve();
			return gate.promise;
		};
		const a = makeHost({ dir, maxAttempts }, first);
		await a.host.ready;
		const id = (await enqueue(a, syncPageJob())) as string;
		const stepping = a.host.runner.step();
		await started.promise;
		// プロセスが落ちた: store が閉じ、実行中の結果は誰にも届かない。
		await a.host.store.close();
		gate.resolve("lost");
		await expect(stepping).rejects.toThrow("database_closing");
		await a.host.close();
		return { dir, id };
	}

	test("replay_safe の実行中ジョブは、開き直すと queued に戻り、重複なく完了する", async () => {
		const { dir, id } = await crashWhileRunning("replay_safe");
		try {
			const second = newControl();
			const b = makeHost({ dir }, second);
			expect(b.host.runner.getJob(id)?.state).toBe("running"); // 回復前
			const recovered = await b.host.runner.ready;
			expect(recovered).toEqual({
				requeued: [id],
				interrupted: [],
				failed: [],
			});
			await b.host.ready;
			expect(b.host.runner.getJob(id)).toMatchObject({
				state: "queued",
				errorCode: "backend_restarted",
				attempt: 1,
			});
			expect(second.settleCalls).toEqual([
				{ jobId: id, type: "retry", inputNull: true },
			]);
			expect(await b.host.runner.step()).toMatchObject({
				result: "success",
				attempt: 2,
			});
			expect(count(b.host, "host_jobs")).toBe(1);
		} finally {
			await cleanupHosts();
			removeExampleTempDir(dir);
		}
	});

	test("interrupt の実行中ジョブは interrupted で settle され、再実行しない", async () => {
		const { dir, id } = await crashWhileRunning("interrupt");
		try {
			const second = newControl();
			second.recovery = "interrupt";
			const b = makeHost({ dir }, second);
			const recovered = await b.host.runner.ready;
			expect(recovered).toEqual({
				requeued: [],
				interrupted: [id],
				failed: [],
			});
			expect(b.host.runner.getJob(id)).toMatchObject({
				state: "interrupted",
				errorCode: "backend_restarted",
			});
			expect(second.settleCalls).toEqual([
				{ jobId: id, type: "interrupted", inputNull: true },
			]);
			expect(await b.host.runner.step()).toEqual({ status: "idle" });
		} finally {
			await cleanupHosts();
			removeExampleTempDir(dir);
		}
	});

	test("試行回数を使い切った replay_safe は再実行せず interrupted", async () => {
		const dir = createExampleTempDir();
		try {
			const a = makeHost({ dir, maxAttempts: 1 });
			await a.host.ready;
			const id = (await enqueue(a, syncPageJob())) as string;
			await a.host.store.write((db) => {
				db.query(
					"UPDATE host_jobs SET state = 'running', attempt = 1, owner = 'dead'",
				).run();
			});
			await a.host.close();
			const b = makeHost({ dir, maxAttempts: 1 });
			await b.host.runner.ready;
			expect(b.host.runner.getJob(id)?.state).toBe("interrupted");
		} finally {
			await cleanupHosts();
			removeExampleTempDir(dir);
		}
	});
});

describe("close", () => {
	test("実行中を abort して interrupted で settle し、以後の step は idle", async () => {
		const t = makeHost();
		const started = deferred();
		t.control.execute = (_input, context) => {
			started.resolve();
			return new Promise<string>((_resolve, reject) => {
				context.signal.addEventListener("abort", () =>
					reject(new CodedError("cancelled")),
				);
			});
		};
		const id = (await enqueue(t, syncPageJob())) as string;
		const stepping = t.host.runner.step();
		await started.promise;
		await t.host.runner.close();
		expect(await stepping).toMatchObject({ result: "interrupted" });
		expect(t.host.runner.getJob(id)).toMatchObject({
			state: "interrupted",
			errorCode: "shutdown",
		});
		expect(await t.host.runner.step()).toEqual({ status: "idle" });
		expect(existsSync(t.host.dir)).toBe(true);
	});
});
