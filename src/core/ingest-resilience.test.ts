import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	createStagingVersionInTransaction,
	getChainInTransaction,
	getDocumentInTransaction,
	getPublishedVersionInSnapshot,
	observeDocumentInTransaction,
	readStatusInSnapshot,
} from "../sqlite/index.js";
import { listFragmentsInSnapshot } from "../sqlite/reads.js";
import {
	claimOf,
	docId,
	drain,
	makeDoc,
	makeEnv,
	rows,
	runJob,
	sha,
	syncAll,
	type Env,
} from "./harness.fixture.js";
import { DEFAULT_MAX_UNAPPLIED_ATTEMPTS } from "./index.js";

const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});
const MIN = 60 * 1000;
const once = { attempts: "once" } as const;

const scanPage0 = (env: Env) =>
	runJob(env.db, env.sync, { scanId: randomUUID(), cursor: null, page: 0 });

const status = (env: Env) =>
	readStatusInSnapshot(
		env.db,
		{ principal: "p", namespaces: ["wiki"] },
		env.clock.t,
		{ verifiedWithinMs: 1e12 },
	);

const sections = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `## 節${i}\n\n本文${i}。${"あ".repeat(40)}\n\n`,
	).join("");

/** Take the open chain job and run prepare; execute and settle are left to the test. */
function prepare(env: Env) {
	const job = env.sink.open.shift();
	if (!job) throw new Error("no open job");
	const claim = claimOf(env.ingest.kind, env.ingest.schema.parse(job.payload));
	const prepared = env.db.transaction(() =>
		env.ingest.prepareInTransaction(env.db, claim),
	)();
	if (prepared.status !== "ready") throw new Error("prepare was stale");
	return { claim, input: prepared.input };
}
const execute = (env: Env, p: ReturnType<typeof prepare>) =>
	env.ingest.execute(p.input, {
		signal: new AbortController().signal,
		jobId: p.claim.jobId,
		attempt: 1,
	});

describe("a port outage is not a failure of the documents", () => {
	test("no document reaches failed_documents during an outage; all are ingested after the wait", async () => {
		const env = makeEnv();
		for (let n = 1; n <= 5; n++) {
			env.source.put(makeDoc(n, `# d${n}\n\nbody of document ${n}\n`));
		}
		// The provider is down (a thrown error) and the host allows one attempt per job.
		env.inference.script = () => {
			throw new Error("provider down");
		};
		// Many scans and chains pass during the outage: still nothing counts against the documents.
		for (let round = 0; round < 6; round++) {
			await syncAll(env, undefined, once);
			expect(status(env).partialReasons).not.toContain("failed_documents");
			for (let n = 1; n <= 5; n++) {
				const row = getDocumentInTransaction(env.db, key(n))!;
				expect(row.state).toBe("stale");
				expect(row.ingestRetry).toBe(0);
			}
			env.clock.t += 61 * MIN; // past even the longest wait
		}
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		const waits = getDocumentInTransaction(env.db, key(1))!;
		expect(waits.transientFailures).toBe(6);
		expect(waits.ingestNotBefore - (env.clock.t - 61 * MIN)).toBe(60 * MIN);

		// The provider is back. A scan before the wait is over queues nothing ...
		env.inference.script = (request) => {
			const line = request.prompt.split("\n---Input---\n")[1]?.split("\n")[0];
			const text = (JSON.parse(line ?? "{}") as { text?: string }).text ?? "";
			return {
				ok: true,
				text: JSON.stringify({ entities: [], relations: [] }),
				model: text.length > 0 ? "m" : "m",
				usage: {
					inputTokens: null,
					cachedTokens: null,
					outputTokens: null,
					reasoningTokens: null,
					calls: null,
				},
				durationMs: 1,
			};
		};
		env.clock.t -= 30 * MIN;
		const callsBefore = env.inference.calls.length;
		await syncAll(env, undefined, once);
		expect(env.inference.calls.length).toBe(callsBefore);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");
		// ... and the first scan after it ingests all of them.
		env.clock.t += 30 * MIN;
		await syncAll(env, undefined, once);
		for (let n = 1; n <= 5; n++) {
			expect(getDocumentInTransaction(env.db, key(n))).toMatchObject({
				state: "current",
				transientFailures: 0,
				ingestNotBefore: 0,
				ingestRetry: 0,
			});
		}
		expect(status(env).partialReasons).not.toContain("failed_documents");
	});

	test("an embedding port failure is temporary too: nothing published, counted nothing", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# a\n\nbody\n"));
		env.embedding.onCall = () => {
			throw new Error("embedder down");
		};
		await syncAll(env, undefined, once);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			ingestRetry: 0,
			transientFailures: 1,
			publishedVersionId: null,
		});
		expect(rows(env.db, "SELECT 1 FROM knowledge_versions")).toHaveLength(0);
		expect(status(env).partialReasons).not.toContain("failed_documents");
	});

	test("a failure the content causes is still counted and ends in failed_documents", async () => {
		const env = makeEnv();
		const doc = makeDoc(1, "# a\n\nbody\n");
		env.source.put(doc);
		// The source's body does not match the digest it declared.
		env.source.docs.set(doc.documentId, {
			...doc,
			markdown: "# a\n\nbody changed\n",
		});
		for (let i = 0; i < DEFAULT_MAX_UNAPPLIED_ATTEMPTS; i++) {
			await syncAll(env, undefined, once);
		}
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			ingestRetry: DEFAULT_MAX_UNAPPLIED_ATTEMPTS,
			transientFailures: 0,
		});
		expect(status(env).partialReasons).toContain("failed_documents");
	});

	test("the retry delay is an option", async () => {
		const env = makeEnv({ transientRetryDelayMs: 1_000 });
		env.source.put(makeDoc(1, "# a\n\nbody\n"));
		env.embedding.onCall = () => {
			throw new Error("down");
		};
		await syncAll(env, undefined, once);
		expect(getDocumentInTransaction(env.db, key(1))!.ingestNotBefore).toBe(
			env.clock.t + 1_000,
		);
	});
});

describe("a long ingest keeps its chain alive", () => {
	test("scans during an ingest that runs for hours open no second chain", async () => {
		const env = makeEnv({ maxFragmentBytes: 100 });
		env.source.put(makeDoc(1, `# t\n\n${sections(12)}`));
		await scanPage0(env);
		expect(
			env.sink.calls.filter((c) => c.kind === "knowledge.ingest-next"),
		).toHaveLength(1);
		const chains = () =>
			env.sink.calls.filter((c) => c.kind === "knowledge.ingest-next").length;

		// Every bundle written takes 25 minutes; a scan arrives before each one. The ingest runs
		// for well over an hour in all, yet no gap between two bundles reaches the hour.
		const startedAt = env.clock.t;
		env.writer.beforeWrite = async () => {
			env.clock.t += 25 * MIN;
			await scanPage0(env);
			expect(getChainInTransaction(env.db).openSweep).toBe(1);
		};
		const { logs } = await drain(env);
		env.writer.beforeWrite = null;

		expect(env.clock.t - startedAt).toBeGreaterThan(61 * MIN);
		// Only the one chain was ever opened for this document; it published.
		expect(chains()).toBe(1);
		expect(logs[0]).toMatchObject({ prepared: "ready", settled: "applied" });
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		expect(getPublishedVersionInSnapshot(env.db, key(1))).not.toBeNull();
	});

	test("a link that stops writing is still taken for lost after an hour", async () => {
		const env = makeEnv({ maxFragmentBytes: 100 });
		env.source.put(makeDoc(1, `# t\n\n${sections(3)}`));
		await scanPage0(env);
		const p = prepare(env);
		await execute(env, p);
		// The host lost the job; nothing writes any more.
		env.clock.t += 61 * MIN;
		await scanPage0(env);
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 2 }]);
	});
});

describe("limits on fragments and on bodies", () => {
	test("a document over maxFragmentsPerDocument is refused as document_too_large before anything is staged", async () => {
		const env = makeEnv({ maxFragmentBytes: 100, maxFragmentsPerDocument: 5 });
		env.source.put(makeDoc(1, `# t\n\n${sections(12)}`));
		await scanPage0(env);
		const p = prepare(env);
		await expect(execute(env, p)).rejects.toMatchObject({
			code: "document_too_large",
		});
		expect(rows(env.db, "SELECT 1 FROM knowledge_versions")).toHaveLength(0);
		expect(env.inference.calls).toHaveLength(0);
		expect(env.embedding.calls).toHaveLength(0);
		expect(env.writer.writes).toBe(0);
		// As a host settles it, the content's fault counts.
		const settled = env.db.transaction(() =>
			env.ingest.settleInTransaction(env.db, p.claim, p.input, {
				type: "failed",
				errorCode: "document_too_large",
			}),
		)();
		expect(settled).toBe("applied");
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			ingestRetry: 1,
			transientFailures: 0,
		});
	});

	test("a document at the limit is accepted; the default limit is 10,000", async () => {
		const env = makeEnv({ maxFragmentBytes: 100 });
		env.source.put(makeDoc(1, `# t\n\n${sections(12)}`));
		await syncAll(env);
		const v = getPublishedVersionInSnapshot(env.db, key(1))!;
		const n = listFragmentsInSnapshot(env.db, v.versionId).length;
		const exact = makeEnv({
			maxFragmentBytes: 100,
			maxFragmentsPerDocument: n,
		});
		exact.source.put(makeDoc(1, `# t\n\n${sections(12)}`));
		await syncAll(exact);
		expect(getDocumentInTransaction(exact.db, key(1))!.state).toBe("current");
	});

	test("the published fragments together may not pass maxIndexedFragments; nothing is staged or published", async () => {
		const probe = makeEnv({ maxFragmentBytes: 100 });
		probe.source.put(makeDoc(1, `# t\n\n${sections(6)}`));
		await syncAll(probe);
		const n = listFragmentsInSnapshot(
			probe.db,
			getPublishedVersionInSnapshot(probe.db, key(1))!.versionId,
		).length;

		// Room for exactly one such document.
		const env = makeEnv({ maxFragmentBytes: 100, maxIndexedFragments: n });
		env.source.put(makeDoc(1, `# t\n\n${sections(6)}`));
		await syncAll(env, undefined, once);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");

		env.source.put(makeDoc(2, `# t\n\n${sections(6)}`));
		const writesBefore = env.writer.writes;
		const callsBefore = env.inference.calls.length;
		await syncAll(env, undefined, once);
		expect(getDocumentInTransaction(env.db, key(2))).toMatchObject({
			state: "stale",
			publishedVersionId: null,
			ingestRetry: DEFAULT_MAX_UNAPPLIED_ATTEMPTS, // the content-caused kind: counted up to the limit
		});
		expect(env.inference.calls.length).toBe(callsBefore);
		expect(env.writer.writes - writesBefore).toBeGreaterThan(0); // the check ran in a write
		expect(
			rows(
				env.db,
				"SELECT version_id FROM knowledge_versions WHERE document_id = ?",
				docId(2),
			),
		).toHaveLength(0);

		// Document 1's own new version replaces its old one, so it is not counted twice.
		env.source.put(makeDoc(1, `# t2\n\n${sections(6)}`));
		await syncAll(env, undefined, once);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.appliedMarkdownSha256).toBe(sha(`# t2\n\n${sections(6)}`));
	});

	test("the size limit is checked before the digest", async () => {
		const env = makeEnv({ maxDocumentBytes: 10 });
		const doc = makeDoc(1, "x".repeat(100));
		env.source.put(doc);
		// The digest would not match either; the size is what is refused.
		env.source.docs.set(doc.documentId, { ...doc, markdown: "y".repeat(100) });
		await scanPage0(env);
		await expect(execute(env, prepare(env))).rejects.toMatchObject({
			code: "document_too_large",
		});
	});
});

describe("housekeeping through the chain", () => {
	test("a settle deletes an orphan staging version after orphanStagingAfterMs", async () => {
		const env = makeEnv({ orphanStagingAfterMs: 1_000 });
		env.source.put(makeDoc(1, "# one\n\nbody\n"));
		// A foreign document with a staging version nobody works on (a crashed earlier run).
		const other = makeDoc(2, "# two\n\nbody\n");
		const { markdown: _m, ...summary } = other;
		env.db.transaction(() => {
			observeDocumentInTransaction(env.db, summary, ["wiki"], env.clock.t);
			createStagingVersionInTransaction(
				env.db,
				{
					...key(2),
					markdownSha256: summary.markdownSha256,
					generation: 0,
					retry: 0,
					namespace: "wiki",
					byteLength: 5,
					expectedFragments: 1,
					instructionDigest: "i".repeat(64),
				},
				env.clock.t,
			);
		})();
		expect(rows(env.db, "SELECT 1 FROM knowledge_versions")).toHaveLength(1);
		// Document 2 waits (it is not picked), so only the cleanup can remove its staging version.
		env.db
			.query(
				"UPDATE knowledge_documents SET ingest_not_before = ? WHERE document_id = ?",
			)
			.run(env.clock.t + 1_000_000, docId(2));
		await scanPage0(env);
		env.clock.t += 2_000;
		await drain(env);
		const versions = rows(
			env.db,
			"SELECT version_id, document_id, state FROM knowledge_versions",
		);
		expect(versions).toEqual([
			expect.objectContaining({ document_id: docId(1), state: "published" }),
		]);
	});
});

describe("one default for the attempt limit", () => {
	test("the core exports the constant the jobs and the status share", async () => {
		expect(DEFAULT_MAX_UNAPPLIED_ATTEMPTS).toBe(3);
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		env.db.query("UPDATE knowledge_documents SET ingest_retry = 2").run();
		expect(status(env).partialReasons).not.toContain("failed_documents");
		env.db.query("UPDATE knowledge_documents SET ingest_retry = 3").run();
		expect(status(env).partialReasons).toContain("failed_documents");
		// The sync-page job skips a document at the same count.
		const calls = env.sink.calls.length;
		env.sink.open = [];
		env.db
			.query(
				"UPDATE knowledge_ingest_chain SET open_sweep = NULL, advanced_at = NULL",
			)
			.run();
		await scanPage0(env);
		expect(env.sink.calls).toHaveLength(calls);
	});
});
