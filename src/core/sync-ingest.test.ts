import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	SourceError,
	ingestDocumentDedupeKey,
	type CreateIngestDocumentHandler,
	type CreateSyncPageHandler,
} from "../contracts/index.js";
import {
	beginScanInTransaction,
	failScanInTransaction,
	getDocumentInTransaction,
	observeDocumentInTransaction,
	readScanInSnapshot,
	retireDocumentInTransaction,
} from "../sqlite/index.js";
import { createIngestDocumentHandler, createSyncPageHandler } from "./index.js";
import {
	docId,
	drain,
	makeDoc,
	makeEnv,
	rows,
	runJob,
	syncAll,
} from "./harness.fixture.js";

// The creators keep the contract's types (the ingest one only adds an optional option).
const _sync: CreateSyncPageHandler = createSyncPageHandler;
const _ingest: CreateIngestDocumentHandler = createIngestDocumentHandler;
void _sync;
void _ingest;

const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});

describe("new document", () => {
	test("is stale with an ingest job, then current after ingest", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# Hello\n"));
		const first = await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(first.settled).toBe("applied");
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.appliedMarkdownSha256).toBeNull();
		expect(row.generation).toBe(0);
		expect(env.sink.calls).toHaveLength(1);
		const job = env.sink.calls[0]!;
		expect(job.kind).toBe("knowledge.ingest-document");
		expect(job.lane).toBe("background");
		expect(job.payloadVersion).toBe(1);
		expect(job.dedupeKey).toBe(ingestDocumentDedupeKey(job.payload as never));

		const { logs } = await drain(env);
		expect(logs[0]!.settled).toBe("applied");
		const done = getDocumentInTransaction(env.db, key(1))!;
		expect(done.state).toBe("current");
		expect(done.appliedMarkdownSha256).toBe(done.observedMarkdownSha256);
		expect(done.appliedByteLength).toBe(Buffer.byteLength("# Hello\n"));
		expect(done.lastVerifiedAt).toBe(env.clock.t);
		expect(done.generation).toBe(0);
	});

	test("re-observing the same version adds no row, job or generation", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# Hello\n"));
		env.source.put(makeDoc(2, "second"));
		await syncAll(env);
		const before = rows(
			env.db,
			"SELECT * FROM knowledge_documents ORDER BY document_id",
		);
		const calls = env.sink.calls.length;
		env.clock.t += 60_000;
		const again = await syncAll(env);
		expect(again.first.settled).toBe("applied");
		expect(env.sink.calls).toHaveLength(calls);
		const after = rows(
			env.db,
			"SELECT * FROM knowledge_documents ORDER BY document_id",
		);
		expect(after).toHaveLength(2);
		for (const [i, r] of after.entries()) {
			expect(r.generation).toBe(before[i]!.generation);
			expect(r.state).toBe("current");
			expect(r.last_verified_at).toBe(env.clock.t);
		}
		const scan = readScanInSnapshot(env.db, again.scanId)!;
		expect(scan.documentsQueued).toBe(0);
		expect(scan.state).toBe("complete");
	});

	test("a stale document re-observed unchanged asks again under the same key", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "x"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(env.sink.calls).toHaveLength(2);
		expect(env.sink.calls[0]!.dedupeKey).toBe(env.sink.calls[1]!.dedupeKey);
		expect(env.sink.open).toHaveLength(1);
		expect(getDocumentInTransaction(env.db, key(1))!.generation).toBe(0);
	});
});

describe("version changes", () => {
	test("a new markdownSha256 makes the document stale with generation +1", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await syncAll(env);
		env.source.put(makeDoc(1, "v2 body"));
		const second = await syncAll(env);
		const row = getDocumentInTransaction(env.db, key(1))!;
		// ingest already ran in syncAll; the point is the generation moved once.
		expect(row.generation).toBe(1);
		expect(row.state).toBe("current");
		expect(row.appliedByteLength).toBe(Buffer.byteLength("v2 body"));
		expect(readScanInSnapshot(env.db, second.scanId)!.documentsQueued).toBe(1);
	});

	test("between observation and ingest the row is stale and keeps its old applied version", async () => {
		const env = makeEnv();
		const v1 = makeDoc(1, "v1");
		env.source.put(v1);
		await syncAll(env);
		env.source.put(makeDoc(1, "v2 body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.generation).toBe(1);
		expect(row.appliedMarkdownSha256).toBe(v1.markdownSha256);
	});

	test("a recovery-only change (etag, contentDigest) does not re-ingest", async () => {
		const env = makeEnv();
		const doc = makeDoc(1, "same body");
		env.source.put(doc);
		await syncAll(env);
		const calls = env.sink.calls.length;
		env.source.put({
			...doc,
			etag: `"${"a".repeat(64)}"`,
			contentDigest: "b".repeat(64),
		});
		await syncAll(env);
		expect(env.sink.calls).toHaveLength(calls);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.generation).toBe(0);
		expect(row.observedEtag).toBe(`"${"a".repeat(64)}"`);
		expect(row.observedContentDigest).toBe("b".repeat(64));
	});

	test("a path or title change updates metadata only", async () => {
		const env = makeEnv();
		const doc = makeDoc(1, "same body");
		env.source.put(doc);
		await syncAll(env);
		const calls = env.sink.calls.length;
		env.source.put({ ...doc, path: "moved/new.md", title: "New title" });
		await syncAll(env);
		expect(env.sink.calls).toHaveLength(calls);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.path).toBe("moved/new.md");
		expect(row.title).toBe("New title");
		expect(row.state).toBe("current");
		expect(row.generation).toBe(0);
	});

	test("going back to the applied version while a newer one is pending restores current and invalidates the pending job", async () => {
		const env = makeEnv();
		const v1 = makeDoc(1, "v1");
		env.source.put(v1);
		await syncAll(env);
		env.source.put(makeDoc(1, "v2 body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const pending = env.sink.open.shift()!;
		env.source.put(v1);
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.generation).toBe(2);
		const stale = await runJob(
			env.db,
			env.ingest,
			env.ingest.schema.parse(pending.payload),
		);
		expect(stale.prepared).toBe("stale");
	});
});

describe("unavailable is not removal", () => {
	test("a namespace outside the allowed areas becomes unavailable and comes back", async () => {
		const env = makeEnv();
		const doc = makeDoc(1, "body", { namespace: "private" });
		env.source.put(doc);
		env.source.namespaces = ["wiki", "private"];
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");

		env.source.namespaces = ["wiki"];
		await syncAll(env);
		let row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("unavailable");
		expect(row.generation).toBe(1);
		// The applied version is kept: nothing was deleted.
		expect(row.appliedMarkdownSha256).toBe(doc.markdownSha256);

		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.generation).toBe(1);

		env.source.namespaces = ["wiki", "private"];
		await syncAll(env);
		row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.generation).toBe(2);
	});

	test("an unavailable document that returns with a new version is stale (+1) and gets a job", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body", { namespace: "private" }));
		env.source.namespaces = ["private"];
		await syncAll(env);
		env.source.namespaces = ["wiki"];
		await syncAll(env);
		env.source.put(makeDoc(1, "new body", { namespace: "private" }));
		env.source.namespaces = ["private"];
		const first = await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(first.settled).toBe("applied");
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.generation).toBe(2);
		expect(env.sink.open).toHaveLength(1);
	});

	test("a new document outside the allowed areas is unavailable and queues nothing", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body", { namespace: "secret" }));
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("unavailable");
		expect(env.sink.calls).toHaveLength(0);
	});

	for (const code of ["not_found", "forbidden"] as const) {
		test(`read ${code} marks the document unavailable (generation +1), not removed`, async () => {
			const env = makeEnv();
			env.source.put(makeDoc(1, "body"));
			await runJob(env.db, env.sync, {
				scanId: randomUUID(),
				cursor: null,
				page: 0,
			});
			env.source.readErrors.set(docId(1), code);
			const { logs } = await drain(env);
			expect(logs[0]!.outcome).toMatchObject({
				type: "success",
				result: { kind: "unavailable", reason: code },
			});
			const row = getDocumentInTransaction(env.db, key(1))!;
			expect(row.state).toBe("unavailable");
			expect(row.generation).toBe(1);
		});
	}

	test("documents missing from the listing are untouched", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "one"));
		env.source.put(makeDoc(2, "two"));
		await syncAll(env);
		const before = rows(
			env.db,
			"SELECT * FROM knowledge_documents WHERE document_id = ?",
			docId(2),
		);
		env.clock.t += 1000;
		env.source.remove(docId(2));
		const scan = await syncAll(env);
		expect(readScanInSnapshot(env.db, scan.scanId)!.state).toBe("complete");
		expect(
			rows(
				env.db,
				"SELECT * FROM knowledge_documents WHERE document_id = ?",
				docId(2),
			),
		).toEqual(before);
	});

	test("excluded and removed documents only get metadata updates", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "one"));
		env.source.put(makeDoc(2, "two"));
		await syncAll(env);
		retireDocumentInTransaction(env.db, key(1), "excluded", env.clock.t);
		retireDocumentInTransaction(env.db, key(2), "removed", env.clock.t);
		expect(getDocumentInTransaction(env.db, key(1))!.generation).toBe(1);
		const calls = env.sink.calls.length;
		env.source.put(makeDoc(1, "one changed", { title: "T1" }));
		env.source.put(makeDoc(2, "two changed", { title: "T2" }));
		await syncAll(env);
		expect(env.sink.calls).toHaveLength(calls);
		const a = getDocumentInTransaction(env.db, key(1))!;
		const b = getDocumentInTransaction(env.db, key(2))!;
		expect([a.state, b.state]).toEqual(["excluded", "removed"]);
		expect([a.generation, b.generation]).toEqual([1, 1]);
		expect([a.title, b.title]).toEqual(["T1", "T2"]);
	});
});

describe("scans", () => {
	test("pages chain through the sink and the scan completes with the queued count", async () => {
		const env = makeEnv();
		env.source.pageSize = 2;
		for (let i = 1; i <= 5; i++) env.source.put(makeDoc(i, `body ${i}`));
		const { scanId, rest } = await syncAll(env);
		const scan = readScanInSnapshot(env.db, scanId)!;
		expect(scan).toMatchObject({
			state: "complete",
			pagesSettled: 3,
			documentsQueued: 5,
			errorCode: null,
		});
		expect(scan.finishedAt).not.toBeNull();
		expect(rest.logs.every((l) => l.settled === "applied")).toBe(true);
		expect(
			rows(env.db, "SELECT 1 FROM knowledge_documents WHERE state = 'current'"),
		).toHaveLength(5);
		const pageJobs = env.sink.calls.filter(
			(c) => c.kind === "knowledge.sync-page",
		);
		expect(pageJobs).toHaveLength(2);
	});

	test("a binding change between pages fails the scan and queues no next page", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		const scanId = randomUUID();
		await runJob(env.db, env.sync, { scanId, cursor: null, page: 0 });
		const next = env.sink.calls.find((c) => c.kind === "knowledge.sync-page")!;
		env.sink.open = env.sink.open.filter((j) => j !== next);
		const callsBefore = env.sink.calls.length;
		env.source.currentBinding = "binding-2";
		const log = await runJob(
			env.db,
			env.sync,
			env.sync.schema.parse(next.payload),
		);
		expect(log.prepared).toBe("stale");
		expect(readScanInSnapshot(env.db, scanId)).toMatchObject({
			state: "failed",
			errorCode: "binding_changed",
		});
		expect(env.sink.calls).toHaveLength(callsBefore);
		expect(env.source.listCalls).toBe(1);
	});

	test("a binding change during execute fails the scan at settle", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "a"));
		const scanId = randomUUID();
		env.source.onList = () => {
			env.source.currentBinding = "binding-2";
		};
		const log = await runJob(env.db, env.sync, {
			scanId,
			cursor: null,
			page: 0,
		});
		// execute notices the change itself and throws; settle sees a failed outcome.
		expect(log.error).toBeDefined();
		expect(readScanInSnapshot(env.db, scanId)!.state).toBe("failed");
		expect(rows(env.db, "SELECT 1 FROM knowledge_documents")).toHaveLength(0);
		expect(env.sink.calls).toHaveLength(0);
	});

	test("an unconfigured source makes prepare stale", async () => {
		const env = makeEnv();
		env.source.currentBinding = null;
		const log = await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(log.prepared).toBe("stale");
		const ing = await runJob(env.db, env.ingest, {
			sourceNamespace: "docling",
			documentId: docId(1),
			markdownSha256: "a".repeat(64),
			generation: 0,
			retry: 0,
		});
		expect(ing.prepared).toBe("stale");
	});

	test("a failure in the middle leaves existing documents unchanged", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		env.source.put(makeDoc(3, "c"));
		await syncAll(env);
		const before = rows(
			env.db,
			"SELECT * FROM knowledge_documents ORDER BY document_id",
		);
		env.clock.t += 5000;
		env.source.listFailsAt = "1";
		const failed = await syncAll(env);
		expect(failed.rest.logs.some((l) => l.error !== undefined)).toBe(true);
		const scan = readScanInSnapshot(env.db, failed.scanId)!;
		expect(scan.state).toBe("failed");
		expect(scan.pagesSettled).toBe(1);
		const after = rows(
			env.db,
			"SELECT * FROM knowledge_documents ORDER BY document_id",
		);
		expect(after).toHaveLength(3);
		// Page 0 re-verified doc 1; docs 2 and 3 were never seen, so they are exactly as before.
		expect(after.slice(1)).toEqual(before.slice(1));
		expect(after[0]!.state).toBe("current");
	});

	test("cancel fails a running scan with code cancelled", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		const scanId = randomUUID();
		await runJob(env.db, env.sync, { scanId, cursor: null, page: 0 });
		const next = env.sync.schema.parse(
			env.sink.calls.find((c) => c.kind === "knowledge.sync-page")!.payload,
		);
		env.db.transaction(() =>
			env.sync.cancelInTransaction(
				env.db,
				{ jobId: "j", payload: next },
				"user",
			),
		)();
		expect(readScanInSnapshot(env.db, scanId)).toMatchObject({
			state: "failed",
			errorCode: "cancelled",
		});
		const late = await runJob(env.db, env.sync, next);
		expect(late.prepared).toBe("stale");
	});

	test("failed, expired and interrupted outcomes fail the scan; retry does nothing", () => {
		const env = makeEnv();
		const mk = (page: number) => ({ scanId: randomUUID(), cursor: null, page });
		const settle = (
			payload: ReturnType<typeof mk>,
			outcome: Parameters<typeof env.sync.settleInTransaction>[3],
		) => {
			env.db.transaction(() =>
				env.sync.prepareInTransaction(env.db, {
					jobId: "j",
					kind: "knowledge.sync-page",
					payloadVersion: 1,
					payload,
					attempt: 1,
					maxAttempts: 3,
					deadlineAtMs: null,
				}),
			)();
			return env.db.transaction(() =>
				env.sync.settleInTransaction(
					env.db,
					{
						jobId: "j",
						kind: "knowledge.sync-page",
						payloadVersion: 1,
						payload,
						attempt: 1,
						maxAttempts: 3,
						deadlineAtMs: null,
					},
					null,
					outcome,
				),
			)();
		};
		const a = mk(0);
		expect(settle(a, { type: "retry", errorCode: "x", availableAtMs: 1 })).toBe(
			"applied",
		);
		expect(readScanInSnapshot(env.db, a.scanId)!.state).toBe("running");
		const b = mk(0);
		settle(b, { type: "failed", errorCode: "boom" });
		expect(readScanInSnapshot(env.db, b.scanId)).toMatchObject({
			state: "failed",
			errorCode: "boom",
		});
		const c = mk(0);
		settle(c, { type: "expired" });
		expect(readScanInSnapshot(env.db, c.scanId)).toMatchObject({
			state: "failed",
			errorCode: "expired",
		});
		const d = mk(0);
		settle(d, { type: "interrupted", errorCode: "restart" });
		expect(readScanInSnapshot(env.db, d.scanId)).toMatchObject({
			state: "failed",
			errorCode: "restart",
		});
	});

	test("a port answer that breaks the listing schema is refused", async () => {
		const env = makeEnv();
		env.source.list = async () =>
			({
				documents: [{ bogus: 1 }],
				namespaces: [],
				nextCursor: null,
			}) as never;
		const log = await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(log.error).toMatchObject({ code: "contract_mismatch" });
	});
});

describe("late and rolled-back results", () => {
	test("a result prepared before a newer observation is stale and writes nothing", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		// Observe v2 between execute and settle.
		const env2 = makeEnv();
		env2.source.put(makeDoc(1, "v1"));
		await runJob(env2.db, env2.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const p2 = env2.ingest.schema.parse(env2.sink.open.shift()!.payload);
		const claim = {
			jobId: "i",
			kind: "knowledge.ingest-document" as const,
			payloadVersion: 1,
			payload: p2,
			attempt: 1,
			maxAttempts: 3,
			deadlineAtMs: null,
		};
		const input = env2.db.transaction(() =>
			env2.ingest.prepareInTransaction(env2.db, claim),
		)();
		expect(input.status).toBe("ready");
		if (input.status !== "ready") return;
		const result = await env2.ingest.execute(input.input, {
			signal: new AbortController().signal,
			jobId: "i",
			attempt: 1,
		});
		env2.source.put(makeDoc(1, "v2 changed"));
		await runJob(env2.db, env2.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(getDocumentInTransaction(env2.db, key(1))!.generation).toBe(1);
		const settled = env2.db.transaction(() =>
			env2.ingest.settleInTransaction(env2.db, claim, input.input, {
				type: "success",
				result,
			}),
		)();
		expect(settled).toBe("stale");
		const row = getDocumentInTransaction(env2.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.appliedMarkdownSha256).toBeNull();
	});

	test("a superseded read is not applied", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		// The source already holds v2 while the registry still waits for v1.
		env.source.docs.set(docId(1), makeDoc(1, "v2 changed"));
		const { logs } = await drain(env);
		expect(logs[0]!.outcome).toMatchObject({
			type: "success",
			result: { kind: "superseded" },
		});
		expect(logs[0]!.settled).toBe("stale");
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.appliedMarkdownSha256).toBeNull();
	});

	test("a binding change after prepare makes the ingest result stale", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const payload = env.ingest.schema.parse(env.sink.open.shift()!.payload);
		const log = await runJob(env.db, env.ingest, payload, () => {
			env.source.currentBinding = "binding-2";
		});
		expect(log.settled).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");
	});

	test("an exception while settling rolls the whole transaction back", async () => {
		const env = makeEnv();
		env.source.pageSize = 2;
		for (let i = 1; i <= 3; i++) env.source.put(makeDoc(i, `b${i}`));
		const scanId = randomUUID();
		// Fail on the second ingest job: the first insert and the first enqueue must be undone.
		let seen = 0;
		env.sink.throwOn = (job) =>
			job.kind === "knowledge.ingest-document" && ++seen === 2;
		const payload = { scanId, cursor: null, page: 0 };
		const claim = {
			jobId: "j",
			kind: "knowledge.sync-page" as const,
			payloadVersion: 1,
			payload,
			attempt: 1,
			maxAttempts: 1,
			deadlineAtMs: null,
		};
		const prepared = env.db.transaction(() =>
			env.sync.prepareInTransaction(env.db, claim),
		)();
		if (prepared.status !== "ready") throw new Error("not ready");
		const result = await env.sync.execute(prepared.input, {
			signal: new AbortController().signal,
			jobId: "j",
			attempt: 1,
		});
		expect(() =>
			env.db.transaction(() =>
				env.sync.settleInTransaction(env.db, claim, prepared.input, {
					type: "success",
					result,
				}),
			)(),
		).toThrow("sink exploded");
		expect(rows(env.db, "SELECT 1 FROM knowledge_documents")).toHaveLength(0);
		expect(rows(env.db, "SELECT 1 FROM knowledge_scan_pages")).toHaveLength(0);
		expect(readScanInSnapshot(env.db, scanId)).toMatchObject({
			state: "running",
			pagesSettled: 0,
			documentsQueued: 0,
		});
		// Re-running after the failure continues without duplicates.
		env.sink.throwOn = null;
		env.sink.open = [];
		const again = await runJob(env.db, env.sync, payload);
		expect(again.settled).toBe("applied");
		expect(rows(env.db, "SELECT 1 FROM knowledge_documents")).toHaveLength(2);
		expect(env.sink.open.map((j) => j.kind)).toContain("knowledge.sync-page");
	});
});

describe("ingest retry counter", () => {
	const payloadOf = (job: { payload: unknown }) =>
		job.payload as {
			retry: number;
			generation: number;
		};

	test("a final failure moves the next scan to a new key; an unfinished one keeps the key", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const first = env.sink.calls[0]!;
		expect(payloadOf(first).retry).toBe(0);

		// Re-scan while the ingest is still open: same payload, same key.
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(env.sink.calls[1]!.dedupeKey).toBe(first.dedupeKey);
		expect(env.sink.open).toHaveLength(1);

		// The ingest fails for good.
		env.source.readErrors.set(docId(1), "invalid_response");
		const { logs } = await drain(env);
		expect(logs[0]!.error).toBeInstanceOf(SourceError);
		expect(logs[0]!.settled).toBe("applied");
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.ingestRetry).toBe(1);
		expect(row.state).toBe("stale");
		expect(row.generation).toBe(0);

		// The next scan queues the same version under a new key.
		env.source.readErrors.clear();
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const again = env.sink.calls.at(-1)!;
		expect(payloadOf(again).retry).toBe(1);
		expect(again.dedupeKey).not.toBe(first.dedupeKey);
		await drain(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("a job with an old counter is stale at prepare", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const old = env.ingest.schema.parse(env.sink.open.shift()!.payload);
		env.source.readErrors.set(docId(1), "invalid_response");
		await runJob(env.db, env.ingest, old);
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(1);
		env.source.readErrors.clear();
		const log = await runJob(env.db, env.ingest, old);
		expect(log.prepared).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");
	});

	test("a retry outcome does not advance the counter", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		env.source.readErrors.set(docId(1), "unavailable");
		await drain(env);
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
	});

	for (const outcome of [
		{ type: "expired" },
		{ type: "interrupted", errorCode: "restart" },
		{ type: "failed", errorCode: "boom" },
	] as const) {
		test(`${outcome.type} advances only while the row still matches`, async () => {
			const env = makeEnv();
			env.source.put(makeDoc(1, "body"));
			await runJob(env.db, env.sync, {
				scanId: randomUUID(),
				cursor: null,
				page: 0,
			});
			const payload = env.ingest.schema.parse(env.sink.open.shift()!.payload);
			const claim = {
				jobId: "i",
				kind: "knowledge.ingest-document" as const,
				payloadVersion: 1,
				payload,
				attempt: 1,
				maxAttempts: 3,
				deadlineAtMs: null,
			};
			const settle = () =>
				env.db.transaction(() =>
					env.ingest.settleInTransaction(env.db, claim, null, outcome),
				)();
			// The version moved on first: nothing is counted.
			env.source.put(makeDoc(1, "newer body"));
			await runJob(env.db, env.sync, {
				scanId: randomUUID(),
				cursor: null,
				page: 0,
			});
			expect(settle()).toBe("applied");
			expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
			// A job for the current generation is counted.
			const fresh = env.ingest.schema.parse(env.sink.open.at(-1)!.payload);
			env.db.transaction(() =>
				env.ingest.settleInTransaction(
					env.db,
					{ ...claim, payload: fresh },
					null,
					outcome,
				),
			)();
			expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(1);
		});
	}
});

describe("superseding scans", () => {
	test("a new scan's page 0 fails older running scans", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		const oldScan = randomUUID();
		await runJob(env.db, env.sync, { scanId: oldScan, cursor: null, page: 0 });
		const orphan = env.sync.schema.parse(
			env.sink.calls.find((c) => c.kind === "knowledge.sync-page")!.payload,
		);
		expect(readScanInSnapshot(env.db, oldScan)!.state).toBe("running");

		const newScan = randomUUID();
		const log = await runJob(env.db, env.sync, {
			scanId: newScan,
			cursor: null,
			page: 0,
		});
		expect(log.prepared).toBe("ready");
		expect(readScanInSnapshot(env.db, oldScan)).toMatchObject({
			state: "failed",
			errorCode: "superseded",
		});
		expect(readScanInSnapshot(env.db, newScan)!.state).toBe("running");
		// The old scan's remaining page no longer runs.
		const late = await runJob(env.db, env.sync, orphan);
		expect(late.prepared).toBe("stale");
	});

	test("a scan whose page 0 is merely retried supersedes nothing else twice", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.put(makeDoc(1, "a"));
		env.source.put(makeDoc(2, "b"));
		const a = randomUUID();
		const b = randomUUID();
		await runJob(env.db, env.sync, { scanId: a, cursor: null, page: 0 });
		await runJob(env.db, env.sync, { scanId: b, cursor: null, page: 0 });
		// Re-preparing a (already failed) does not revive it, and b stays running.
		const again = await runJob(env.db, env.sync, {
			scanId: a,
			cursor: null,
			page: 0,
		});
		expect(again.prepared).toBe("stale");
		expect(readScanInSnapshot(env.db, b)!.state).toBe("running");
	});
});

describe("integration findings (p1.md §6 scenarios)", () => {
	test("a cancelled ingest advances the retry counter, so the next scan can queue the version again", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# v1\n"));
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const queued = env.sink.calls.at(-1)!;
		env.db.transaction(() =>
			env.ingest.cancelInTransaction(
				env.db,
				{ jobId: "job-1", payload: queued.payload as never },
				"user_cancelled",
			),
		)();
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.ingestRetry).toBe(1);
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const next = env.sink.calls.at(-1)!;
		expect(next.dedupeKey).not.toBe(queued.dedupeKey);
		expect((next.payload as { retry: number }).retry).toBe(1);
	});

	test("documents in a namespace the listing no longer allows become unavailable, with a new generation", async () => {
		const env = makeEnv();
		env.source.namespaces = ["wiki", "other"];
		env.source.put(makeDoc(1, "# kept\n"));
		env.source.put(makeDoc(2, "# moved out\n", { namespace: "other" }));
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
		const generation = getDocumentInTransaction(env.db, key(2))!.generation;

		// The credential loses the namespace: the document leaves the listing and the allowed list.
		env.source.namespaces = ["wiki"];
		env.source.listed.delete(docId(2));
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		const moved = getDocumentInTransaction(env.db, key(2))!;
		expect(moved.state).toBe("unavailable");
		expect(moved.generation).toBe(generation + 1);
		expect(moved.appliedMarkdownSha256).not.toBeNull();

		// Allowed again and listed again with the same version: current again.
		env.source.namespaces = ["wiki", "other"];
		env.source.listed.set(docId(2), env.source.docs.get(docId(2))!);
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
	});
});

describe("an ingest that ends without applying moves the next scan to a new key", () => {
	const scanPage0 = (env: ReturnType<typeof makeEnv>) =>
		runJob(env.db, env.sync, { scanId: randomUUID(), cursor: null, page: 0 });
	const takeIngest = (env: ReturnType<typeof makeEnv>) =>
		env.ingest.schema.parse(env.sink.open.shift()!.payload);

	test("a binding change at settle", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		const first = env.sink.calls.at(-1)!;
		const payload = takeIngest(env);
		const log = await runJob(env.db, env.ingest, payload, () => {
			env.source.currentBinding = "binding-2";
		});
		expect(log.settled).toBe("stale");
		env.source.currentBinding = "binding-1";
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			ingestRetry: 1,
			generation: 0,
		});
		await syncAll(env);
		expect(env.sink.calls.at(-1)!.dedupeKey).not.toBe(first.dedupeKey);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("superseded: the source already holds a newer version, then the listing shows it", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await scanPage0(env);
		const first = env.sink.calls.at(-1)!;
		env.source.docs.set(docId(1), makeDoc(1, "v2 changed"));
		const { logs } = await drain(env);
		expect(logs[0]!.settled).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(1);
		// The listing now shows the new version.
		env.source.put(makeDoc(1, "v2 changed"));
		await syncAll(env);
		expect(env.sink.calls.at(-1)!.dedupeKey).not.toBe(first.dedupeKey);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.generation).toBe(1);
	});

	test("a document read from another namespace than the registry row", async () => {
		const env = makeEnv();
		env.source.namespaces = ["wiki", "other"];
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		const first = env.sink.calls.at(-1)!;
		env.source.docs.set(docId(1), makeDoc(1, "body", { namespace: "other" }));
		const log = await runJob(env.db, env.ingest, takeIngest(env));
		expect(log.settled).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			namespace: "wiki",
			ingestRetry: 1,
		});
		env.source.docs.set(docId(1), makeDoc(1, "body"));
		await syncAll(env);
		expect(env.sink.calls.at(-1)!.dedupeKey).not.toBe(first.dedupeKey);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("prepare is stale because the source is unconfigured while the row still matches", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		const first = env.sink.calls.at(-1)!;
		const payload = takeIngest(env);
		env.source.currentBinding = null;
		const log = await runJob(env.db, env.ingest, payload);
		expect(log.prepared).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(1);
		env.source.currentBinding = "binding-1";
		await syncAll(env);
		expect(env.sink.calls.at(-1)!.dedupeKey).not.toBe(first.dedupeKey);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("a row that moved on is not counted (settle and prepare)", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "v1"));
		await scanPage0(env);
		const old = takeIngest(env);
		// A newer version is observed between execute and settle.
		const { markdown: _m, ...v2 } = makeDoc(1, "v2 changed");
		const log = await runJob(env.db, env.ingest, old, () => {
			env.db.transaction(() =>
				observeDocumentInTransaction(env.db, v2, ["wiki"], env.clock.now()),
			)();
		});
		expect(log.settled).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			generation: 1,
			ingestRetry: 0,
		});
		// The old job's prepare is superseded and writes nothing either.
		env.source.currentBinding = null;
		const again = await runJob(env.db, env.ingest, old);
		expect(again.prepared).toBe("stale");
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
	});

	test("an applied ingest does not advance the counter", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "current",
			ingestRetry: 0,
		});
		env.source.put(makeDoc(2, "gone"));
		await scanPage0(env);
		env.source.readErrors.set(docId(2), "not_found");
		await drain(env);
		expect(getDocumentInTransaction(env.db, key(2))).toMatchObject({
			state: "unavailable",
			ingestRetry: 0,
		});
	});
});

describe("scan error codes and the allowed-area check", () => {
	test("a code outside [a-z][a-z0-9_]* is stored as handler_failed", async () => {
		const env = makeEnv();
		const codes: Array<[string, string]> = [
			["boom", "boom"],
			["queue:thing", "handler_failed"],
			["Upper", "handler_failed"],
			["", "handler_failed"],
			["a-b", "handler_failed"],
		];
		for (const [given, stored] of codes) {
			const scanId = randomUUID();
			env.db.transaction(() =>
				beginScanInTransaction(env.db, scanId, "binding-1", env.clock.now()),
			)();
			env.db.transaction(() =>
				failScanInTransaction(env.db, scanId, given, env.clock.now()),
			)();
			expect(readScanInSnapshot(env.db, scanId)).toMatchObject({
				state: "failed",
				errorCode: stored,
			});
		}
	});

	test("a failed outcome's error code is checked too", async () => {
		const env = makeEnv();
		const scanId = randomUUID();
		const payload = { scanId, cursor: null, page: 0 };
		const claim = {
			jobId: "j",
			kind: "knowledge.sync-page" as const,
			payloadVersion: 1,
			payload,
			attempt: 1,
			maxAttempts: 3,
			deadlineAtMs: null,
		};
		env.db.transaction(() => env.sync.prepareInTransaction(env.db, claim))();
		env.db.transaction(() =>
			env.sync.settleInTransaction(env.db, claim, null, {
				type: "interrupted",
				errorCode: "stale:result",
			}),
		)();
		expect(readScanInSnapshot(env.db, scanId)).toMatchObject({
			state: "failed",
			errorCode: "handler_failed",
		});
	});

	test("documents outside the allowed areas are checked on page 0 only", async () => {
		const env = makeEnv();
		env.source.pageSize = 1;
		env.source.namespaces = ["wiki", "other"];
		env.source.put(makeDoc(1, "one"));
		env.source.put(makeDoc(2, "two", { namespace: "other" }));
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");

		// Only page 1 (document 2) is told that the allowed areas shrank.
		env.source.namespaces = ["wiki", "other"];
		let calls = 0;
		env.source.onList = () => {
			calls += 1;
			env.source.namespaces = calls === 1 ? ["wiki", "other"] : ["other"];
		};
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		env.source.onList = null;

		// A scan whose page 0 says so applies it to the whole registry.
		env.source.namespaces = ["other"];
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("unavailable");
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
	});
});
