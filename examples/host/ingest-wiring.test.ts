// P2 の取り込みに必要な依存（IngestDeps・HostWriter・kind の登録）がホストで組み立てられることの試験。
// package のジョブは import せず、偽の handler で確かめる。
import { afterEach, describe, expect, test } from "bun:test";
import {
	apiPaths,
	ingestNextDedupeKey,
	KNOWLEDGE_JOB_KINDS,
	type FollowUpJob,
	type IngestDeps,
} from "../../src/contracts/index.js";
import { createMeaninglessHashEmbedding } from "../mocks/embedding.js";
import { createScriptedInference } from "../mocks/inference.js";
import {
	cleanupHosts,
	count,
	createFakeIngestNextHandler,
	makeHost,
	readFakeStatus,
	syncPageJob,
	TEST_EMBEDDING_SPACE,
	START_MS,
	type TestHost,
} from "./test-support.js";
import { createTestClock, type ExampleHostOptions } from "./index.js";

afterEach(async () => {
	expect(await cleanupHosts()).toEqual([]);
});

function ingestNextJob(sweep: number): FollowUpJob {
	const payload = { sweep };
	return {
		kind: KNOWLEDGE_JOB_KINDS.ingestNext,
		payloadVersion: 1,
		dedupeKey: ingestNextDedupeKey(payload),
		payload,
		lane: "background",
	};
}

function enqueue(t: TestHost, job: FollowUpJob) {
	return t.host.store.write((db) => t.host.jobs.enqueueInTransaction(db, job));
}

/** 渡された IngestDeps を取り出すホスト。 */
function makeCapturingHost(overrides: Partial<ExampleHostOptions> = {}) {
	const clock = createTestClock(START_MS);
	const inference = createScriptedInference({ scenarios: {}, clock }).port;
	const embedding = createMeaninglessHashEmbedding({
		space: TEST_EMBEDDING_SPACE,
	}).port;
	const captured: IngestDeps[] = [];
	const t = makeHost({
		clock,
		inference,
		embedding,
		handlerFactories: [
			(deps) => createFakeIngestNextHandler((d) => captured.push(d), deps),
		],
		...overrides,
	});
	return { t, inference, embedding, captured };
}

describe("IngestDeps", () => {
	test("handler の生成関数に source・jobs・clock・events・inference・embedding・writer が渡る", async () => {
		const events = () => {};
		const { t, inference, embedding, captured } = makeCapturingHost({ events });
		await t.host.ready;
		expect(captured).toHaveLength(1);
		const deps = captured[0] as IngestDeps;
		expect(Object.keys(deps).sort()).toEqual(
			[
				"clock",
				"embedding",
				"events",
				"inference",
				"jobs",
				"source",
				"writer",
			].sort(),
		);
		expect(deps.inference).toBe(inference);
		expect(deps.embedding).toBe(embedding);
		expect(deps.events).toBe(events);
		expect(deps.clock).toBe(t.host.clock);
		expect(deps.jobs).toBe(t.host.jobs.sink);
		expect(typeof deps.writer.write).toBe("function");
	});

	test("tokenizer は指定したときだけ deps に入る", async () => {
		const tokenizer = { id: "host-analyzer", tokenize: () => [] };
		const { t, captured } = makeCapturingHost({ tokenizer });
		await t.host.ready;
		expect((captured[0] as IngestDeps).tokenizer).toBe(tokenizer);
	});

	test("statusOptions は maxUnappliedAttempts を含めてそのまま status の読み取りに渡る", async () => {
		const seen: unknown[] = [];
		const t = makeHost({
			statusOptions: {
				verifiedWithinMs: 1234,
				maxUnappliedAttempts: 5,
				binding: "b",
			},
			readStatusInSnapshot: (db, access, now, options) => {
				seen.push(options);
				return readFakeStatus(db, access, now, options);
			},
		});
		await t.host.ready;
		const res = await t.host.app.request(apiPaths.status, {
			headers: { authorization: "Bearer token-alice" },
		});
		expect(res.status).toBe(200);
		expect(seen).toEqual([
			{ verifiedWithinMs: 1234, maxUnappliedAttempts: 5, binding: "b" },
		]);
	});
});

describe("ジョブの kind の登録", () => {
	test("登録される kind は渡された handler の kind に従う", async () => {
		const { t } = makeCapturingHost();
		await t.host.ready;
		const id = await enqueue(t, ingestNextJob(0));
		expect(id).not.toBeNull();
		// 同じ dedupe key は一度きり。
		expect(await enqueue(t, ingestNextJob(0))).toBeNull();
		await expect(enqueue(t, syncPageJob())).rejects.toThrow(
			"invalid_unknown_job_kind",
		);
		await expect(
			enqueue(t, {
				...ingestNextJob(1),
				payload: { sweep: "x" },
			}),
		).rejects.toThrow("invalid_job_payload");
	});

	test("ingest-next のジョブは偽の handler で claim から settle まで進む", async () => {
		const { t } = makeCapturingHost();
		await t.host.ready;
		const id = (await enqueue(t, ingestNextJob(0))) as string;
		const report = await t.host.runner.step();
		expect(report).toMatchObject({ jobId: id, status: "processed" });
		expect(t.host.runner.getJob(id)?.kind).toBe(KNOWLEDGE_JOB_KINDS.ingestNext);
	});
});

describe("HostWriter", () => {
	async function writer() {
		const { t, captured } = makeCapturingHost();
		await t.host.ready;
		t.host.store.read((db) => {
			db.exec("SELECT 1");
		});
		await t.host.store.write((db) => {
			db.exec("CREATE TABLE writer_probe (n INTEGER NOT NULL)");
		});
		return { t, writer: (captured[0] as IngestDeps).writer };
	}

	test("1 回の呼出しが 1 つの transaction で commit され、戻り値が返る", async () => {
		const { t, writer: w } = await writer();
		const commits: number[] = [];
		t.host.store.onCommit(() => commits.push(1));
		const result = await w.write((tx) => {
			tx.query("INSERT INTO writer_probe (n) VALUES (?)").run(1);
			tx.query("INSERT INTO writer_probe (n) VALUES (?)").run(2);
			return "done";
		});
		expect(result).toBe("done");
		expect(count(t.host, "writer_probe")).toBe(2);
		expect(commits).toHaveLength(1);
	});

	test("例外は巻き戻し、その呼出しの書込みは残らない。前の呼出しの書込みは残る", async () => {
		const { t, writer: w } = await writer();
		await w.write((tx) => {
			tx.query("INSERT INTO writer_probe (n) VALUES (1)").run();
		});
		await expect(
			w.write((tx) => {
				tx.query("INSERT INTO writer_probe (n) VALUES (2)").run();
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(count(t.host, "writer_probe")).toBe(1);
		// 失敗の後も次の呼出しは通る。
		await w.write((tx) => {
			tx.query("INSERT INTO writer_probe (n) VALUES (3)").run();
		});
		expect(count(t.host, "writer_probe")).toBe(2);
	});

	test("Promise を返す callback は拒否され、書込みは巻き戻る", async () => {
		const { t, writer: w } = await writer();
		await expect(
			w.write(((tx: {
				query(sql: string): { run(...p: never[]): unknown };
			}) => {
				tx.query("INSERT INTO writer_probe (n) VALUES (1)").run();
				return Promise.resolve("late");
			}) as never),
		).rejects.toThrow("async_write_callback");
		expect(count(t.host, "writer_probe")).toBe(0);
	});

	test("同時の呼出しは直列に実行され、callback が重ならない", async () => {
		const { t, writer: w } = await writer();
		const order: string[] = [];
		const calls = [0, 1, 2].map((n) =>
			w.write((tx) => {
				order.push(`start${n}`);
				tx.query("INSERT INTO writer_probe (n) VALUES (?)").run(n);
				order.push(`end${n}`);
				return n;
			}),
		);
		expect(await Promise.all(calls)).toEqual([0, 1, 2]);
		expect(order).toEqual([
			"start0",
			"end0",
			"start1",
			"end1",
			"start2",
			"end2",
		]);
		expect(count(t.host, "writer_probe")).toBe(3);
	});

	test("close の後の呼出しは database_closing で拒否される", async () => {
		const { t, writer: w } = await writer();
		await t.host.close();
		await expect(w.write(() => 1)).rejects.toThrow("database_closing");
	});
});
