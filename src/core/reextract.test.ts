import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
	FollowUpJob,
	IngestDeps,
	IngestOptions,
	NameToken,
	TokenizerPort,
} from "../contracts/index.js";
import { getPublishedVersionInSnapshot } from "../sqlite/index.js";
import { pickVersionToCompareInTransaction } from "../sqlite/links.js";
import { createCharclassTokenizer } from "./extract/index.js";
import {
	claimOf,
	docId,
	makeDoc,
	makeEnv,
	rows,
	runJob,
	type Env,
} from "./harness.fixture.js";
import { createIngestNextHandler, createSyncPageHandler } from "./index.js";
import { makeLinkEnv, putDoc, scanAndDrain } from "./link/link.fixture.js";

const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});

/** charclass, renamed, with サーバ normalized to サーバー (as a dictionary would). */
function longVowel(id = "long-vowel"): TokenizerPort {
	const base = createCharclassTokenizer();
	return {
		id,
		tokenize: (text) =>
			base
				.tokenize(text)
				.map((t): NameToken =>
					t.surface.endsWith("サーバ") ? { ...t, norm: `${t.surface}ー` } : t,
				),
	};
}

/** Handlers on the same database, source and queue, with another tokenizer or extractor. */
function handlersOf(
	env: Env,
	options: IngestOptions,
	tokenizer?: TokenizerPort,
) {
	const deps: IngestDeps = {
		source: env.source,
		jobs: env.sink,
		clock: env.clock,
		events: (e) => env.events.push(e),
		inference: env.inference,
		embedding: env.embedding,
		writer: env.writer,
		...(tokenizer ? { tokenizer } : {}),
	};
	return {
		sync: createSyncPageHandler(deps, { extractor: options.extractor }),
		ingest: createIngestNextHandler(deps, options),
	};
}

/** A scan with these handlers, and every sync and ingest job it causes (identity jobs left). */
async function scanWith(
	env: Env,
	h: ReturnType<typeof handlersOf>,
	attempts: "once" | undefined = undefined,
) {
	const opts = attempts ? { attempts } : {};
	await runJob(
		env.db,
		h.sync,
		{ scanId: randomUUID(), cursor: null, page: 0 },
		undefined,
		opts,
	);
	const ran: FollowUpJob[] = [];
	for (let i = 0; i < 200; i++) {
		const at = env.sink.open.findIndex((j) => j.kind !== "knowledge.link-next");
		if (at < 0) break;
		const [job] = env.sink.open.splice(at, 1) as [FollowUpJob];
		ran.push(job);
		if (job.kind === "knowledge.sync-page")
			await runJob(
				env.db,
				h.sync,
				h.sync.schema.parse(job.payload),
				undefined,
				opts,
			);
		else
			await runJob(
				env.db,
				h.ingest,
				h.ingest.schema.parse(job.payload),
				undefined,
				opts,
			);
	}
	return ran;
}

const BODY =
	"# 設定\n\nサーバの設定を Lantern で見る。\n\n## 続き\n\nサーバを止める。\n";

const extractorOf = (env: Env, n: number): string =>
	rows(
		env.db,
		`SELECT v.extractor FROM knowledge_versions v
JOIN knowledge_documents d ON d.published_version_id = v.version_id WHERE d.document_id = ?`,
		docId(n),
	)[0]?.extractor as string;

const keysOf = (env: Env, n: number): string[] =>
	rows(
		env.db,
		`SELECT m.name_key FROM knowledge_entity_mentions m
JOIN knowledge_documents d ON d.published_version_id = m.version_id
WHERE d.document_id = ? ORDER BY m.name_key`,
		docId(n),
	).map((r) => r.name_key as string);

describe("the defaults of KG2 G7", () => {
	test("without options the model-free extractor is used: no model call, the version records it", async () => {
		const env = makeEnv();
		const h = handlersOf(env, {});
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, h);
		expect(env.inference.calls).toHaveLength(0);
		expect(getPublishedVersionInSnapshot(env.db, key(1))).not.toBeNull();
		expect(extractorOf(env, 1)).toBe("names:charclass@rules8");
	});

	test("without `summaries` the identity chain asks the model for no summary", async () => {
		const env = makeLinkEnv({ summaryMinMentions: 2, summaries: false });
		putDoc(env, 1, "Alpha Corp opens.");
		putDoc(env, 2, "Alpha Corp returns.");
		await scanAndDrain(env);
		// The model's extraction and identity were asked for (the fixture's choice), summaries not.
		expect(env.calls.link).toBeGreaterThan(0);
		expect(env.calls.summarize).toBe(0);
		expect(rows(env.db, "SELECT 1 FROM knowledge_entity_summaries")).toEqual(
			[],
		);
	});
});

describe("re-extraction when the extractor changes (kg2.md G7)", () => {
	test("another tokenizer re-extracts the stored fragments in place: no source read, no embedding", async () => {
		const env = makeEnv();
		const first = handlersOf(env, { extractor: "names" });
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, first);
		const before = getPublishedVersionInSnapshot(env.db, key(1));
		expect(keysOf(env, 1)).toContain("サーバ");
		const reads = env.source.readCalls;
		const embeds = env.embedding.calls.length;
		const texts = (v: number) =>
			rows(
				env.db,
				"SELECT text FROM knowledge_fragments WHERE version_id = ? ORDER BY ordinal",
				v,
			).map((r) => r.text);
		const vectors = (v: number) =>
			rows(
				env.db,
				"SELECT hex(vector) AS h FROM knowledge_vectors WHERE version_id = ? ORDER BY ordinal",
				v,
			).map((r) => r.h);
		// The old version's rows are cleaned up after it retires: keep what to compare with.
		const oldTexts = texts(before?.versionId as number);
		const oldVectors = vectors(before?.versionId as number);
		expect(oldTexts.length).toBeGreaterThan(0);

		const second = handlersOf(env, { extractor: "names" }, longVowel());
		await scanWith(env, second);
		const after = getPublishedVersionInSnapshot(env.db, key(1));
		expect(after?.versionId).not.toBe(before?.versionId);
		expect(extractorOf(env, 1)).toBe("names:long-vowel@rules8");
		expect(keysOf(env, 1)).toContain("サーバー");
		expect(keysOf(env, 1)).not.toContain("サーバ");
		// The body was neither read nor embedded again; fragments and vectors are the same.
		expect(env.source.readCalls).toBe(reads);
		expect(env.embedding.calls.length).toBe(embeds);
		expect(texts(after?.versionId as number)).toEqual(oldTexts);
		expect(vectors(after?.versionId as number)).toEqual(oldVectors);
		// The document stayed current; the old version is retired (then cleaned up).
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			),
		).toEqual([{ state: "current" }]);
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_versions WHERE version_id = ?",
				before?.versionId as number,
			).map((r) => r.state),
		).not.toContain("published");
		// Nothing is left to do: a scan with the same handlers re-extracts nothing more.
		const again = await scanWith(env, second);
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).toBe(
			after?.versionId,
		);
		expect(again.filter((j) => j.kind === "knowledge.ingest-next")).toEqual([]);
	});

	test("the model's extractor re-extracts nothing; a version without a record is left alone", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		env.source.put(makeDoc(2, "Lantern の別の文書。"));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		// Document 2's version predates the record.
		env.db.run(
			`UPDATE knowledge_versions SET extractor = '' WHERE version_id =
 (SELECT published_version_id FROM knowledge_documents WHERE document_id = ?)`,
			[docId(2)],
		);
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))?.versionId;
		const v2 = getPublishedVersionInSnapshot(env.db, key(2))?.versionId;
		await scanWith(env, handlersOf(env, { extractor: "model" }));
		expect(
			rows(
				env.db,
				"SELECT published_version_id AS v FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			)[0]?.v,
		).toBe(v1);
		await scanWith(env, handlersOf(env, { extractor: "names" }, longVowel()));
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).not.toBe(
			v1,
		);
		expect(getPublishedVersionInSnapshot(env.db, key(2))?.versionId).toBe(v2);
		expect(env.inference.calls).toHaveLength(0);
	});

	test("a tokenizer that fails keeps the old version and waits; the chain does not spin", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))?.versionId;
		const broken: TokenizerPort = {
			id: "broken",
			tokenize: () => {
				throw new Error("dictionary missing");
			},
		};
		const ran = await scanWith(
			env,
			handlersOf(env, { extractor: "names" }, broken),
			"once",
		);
		// One link that fails, and one that cleans its staging up: then the chain stops.
		expect(
			ran.filter((j) => j.kind === "knowledge.ingest-next").length,
		).toBeLessThanOrEqual(2);
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).toBe(v1);
		expect(
			rows(
				env.db,
				"SELECT reextract_not_before AS t FROM knowledge_versions WHERE version_id = ?",
				v1 as number,
			)[0]?.t,
		).toBeGreaterThan(env.clock.t);
		// Once the wait has passed and the tokenizer works, the version is re-extracted.
		env.clock.t += 60 * 60 * 1000;
		await scanWith(env, handlersOf(env, { extractor: "names" }, longVowel()));
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).not.toBe(
			v1,
		);
	});

	test("a document whose body changed is ingested from the source, not re-extracted", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		env.source.put(makeDoc(1, `${BODY}\n追記のサーバ。\n`));
		const reads = env.source.readCalls;
		await scanWith(env, handlersOf(env, { extractor: "names" }, longVowel()));
		// Read once (the new body), extracted with the new tokenizer.
		expect(env.source.readCalls).toBe(reads + 1);
		expect(extractorOf(env, 1)).toBe("names:long-vowel@rules8");
		expect(keysOf(env, 1)).toContain("サーバー");
	});

	test("a version without fragments (an empty body) is never chosen: nothing spins", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, ""));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))?.versionId;
		const ran = await scanWith(
			env,
			handlersOf(env, { extractor: "names" }, longVowel()),
		);
		expect(ran.filter((j) => j.kind === "knowledge.ingest-next")).toEqual([]);
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).toBe(v1);
	});

	test("a version that cannot be copied (its vectors are gone) waits; the wait doubles", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))
			?.versionId as number;
		env.db.run("DELETE FROM knowledge_vectors WHERE version_id = ?", [v1]);
		const second = handlersOf(env, { extractor: "names" }, longVowel());
		const wait = () =>
			rows(
				env.db,
				"SELECT reextract_not_before AS t, reextract_failures AS f FROM knowledge_versions WHERE version_id = ?",
				v1,
			)[0] as { t: number; f: number };
		const ran = await scanWith(env, second);
		expect(ran.filter((j) => j.kind === "knowledge.ingest-next").length).toBe(
			1,
		);
		const first = wait();
		expect(first.f).toBe(1);
		const base = first.t - env.clock.t;
		expect(base).toBeGreaterThan(0);
		// Before the wait has passed, nothing is tried.
		expect(
			(await scanWith(env, second)).filter(
				(j) => j.kind === "knowledge.ingest-next",
			),
		).toEqual([]);
		env.clock.t = first.t;
		await scanWith(env, second);
		expect(wait()).toEqual({ t: env.clock.t + 2 * base, f: 2 });
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).toBe(v1);
	});

	test("a document that changes during its re-extraction keeps its state; the copy is given up", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))?.versionId;
		const second = handlersOf(env, { extractor: "names" }, longVowel());
		await runJob(env.db, second.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const job = env.sink.open.find((j) => j.kind === "knowledge.ingest-next");
		expect(job).toBeDefined();
		env.sink.open.splice(env.sink.open.indexOf(job as FollowUpJob), 1);
		const log = await runJob(
			env.db,
			second.ingest,
			second.ingest.schema.parse((job as FollowUpJob).payload),
			// What a scan does when the body changed, between execute and settle.
			() =>
				env.db.run(
					"UPDATE knowledge_documents SET state = 'stale', generation = generation + 1, observed_markdown_sha256 = ? WHERE document_id = ?",
					["f".repeat(64), docId(1)],
				),
		);
		expect(log.settled).toBe("stale");
		// Still the old version, still stale (not made current again); the copy was abandoned.
		expect(
			rows(
				env.db,
				"SELECT published_version_id AS v FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			)[0]?.v,
		).toBe(v1);
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_documents WHERE document_id = ?",
				docId(1),
			),
		).toEqual([{ state: "stale" }]);
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_versions WHERE version_id <> ? AND state IN ('staging', 'published')",
				v1 as number,
			),
		).toEqual([]);
	});

	test("a cancelled re-extraction gives up its copy and makes the version wait", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, BODY));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		const v1 = getPublishedVersionInSnapshot(env.db, key(1))
			?.versionId as number;
		const second = handlersOf(env, { extractor: "names" }, longVowel());
		await runJob(env.db, second.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const job = env.sink.open.find(
			(j) => j.kind === "knowledge.ingest-next",
		) as FollowUpJob;
		const payload = second.ingest.schema.parse(job.payload);
		const claim = claimOf(second.ingest.kind, payload);
		const prepared = env.db.transaction(() =>
			second.ingest.prepareInTransaction(env.db, claim),
		)();
		expect(prepared.status).toBe("ready");
		if (prepared.status === "ready") {
			expect((prepared.input as { mode: string }).mode).toBe("reextract");
			await second.ingest.execute(prepared.input, {
				signal: new AbortController().signal,
				jobId: claim.jobId,
				attempt: 1,
			});
		}
		env.db.transaction(() =>
			second.ingest.cancelInTransaction(
				env.db,
				{ jobId: claim.jobId, payload },
				"user",
			),
		)();
		expect(getPublishedVersionInSnapshot(env.db, key(1))?.versionId).toBe(v1);
		expect(
			rows(
				env.db,
				"SELECT reextract_not_before AS t FROM knowledge_versions WHERE version_id = ?",
				v1,
			)[0]?.t,
		).toBeGreaterThan(env.clock.t);
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_versions WHERE version_id <> ?",
				v1,
			).map((r) => r.state),
		).toEqual(["abandoned"]);
	});

	test("every document is re-extracted in one scan, and the identity chain is opened", async () => {
		const env = makeEnv();
		for (let n = 1; n <= 3; n++)
			env.source.put(makeDoc(n, `${BODY}\n文書 ${n}。\n`));
		await scanWith(env, handlersOf(env, { extractor: "names" }));
		env.sink.open.splice(0);
		const before = [1, 2, 3].map(
			(n) => getPublishedVersionInSnapshot(env.db, key(n))?.versionId,
		);
		await scanWith(env, handlersOf(env, { extractor: "names" }, longVowel()));
		for (const [i, n] of [1, 2, 3].entries()) {
			expect(getPublishedVersionInSnapshot(env.db, key(n))?.versionId).not.toBe(
				before[i],
			);
			expect(extractorOf(env, n)).toBe("names:long-vowel@rules8");
		}
		// The new versions wait for the identity chain (compared without the model).
		expect(
			pickVersionToCompareInTransaction(env.db, env.clock.t),
		).not.toBeNull();
	});
});
