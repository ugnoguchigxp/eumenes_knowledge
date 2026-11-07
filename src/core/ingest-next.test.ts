import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	KnowledgeError,
	SourceError,
	embeddingSpaceKey,
	type InferenceResult,
	type SettleOutcome,
} from "../contracts/index.js";
import { INSTRUCTION_SET_DIGEST } from "../contexts/index.js";
import {
	getActiveIngestInTransaction,
	getChainInTransaction,
	getDocumentInTransaction,
	getPublishedVersionInSnapshot,
	readStatusInSnapshot,
	searchFragmentsInSnapshot,
} from "../sqlite/index.js";
import {
	getRetainedVersionInSnapshot,
	getVersionInSnapshot,
	listEntityMentionsInSnapshot,
	listEvidenceInSnapshot,
	listExtractionsInSnapshot,
	listFragmentsInSnapshot,
	readVersionVectorsInSnapshot,
} from "../sqlite/reads.js";
import {
	SPACE,
	claimOf,
	docId,
	drain,
	fragmentTextOf,
	inferenceOk,
	makeDoc,
	makeEnv,
	rows,
	runJob,
	sha,
	syncAll,
	type Env,
} from "./harness.fixture.js";
import { PortFailure } from "./support.js";

const key = (n: number) => ({
	sourceNamespace: "docling",
	documentId: docId(n),
});

const scanPage0 = (env: Env) =>
	runJob(env.db, env.sync, { scanId: randomUUID(), cursor: null, page: 0 });

const count = (env: Env, table: string): number =>
	rows(env.db, `SELECT 1 FROM ${table}`).length;

const stateOfVersions = (env: Env): string[] =>
	rows(env.db, "SELECT state FROM knowledge_versions ORDER BY version_id").map(
		(r) => r.state as string,
	);

/** Take the open chain job and run prepare, leaving execute and settle to the test. */
function prepare(env: Env) {
	const job = env.sink.open.shift();
	if (!job) throw new Error("no open job");
	const claim = claimOf(env.ingest.kind, env.ingest.schema.parse(job.payload));
	const prepared = env.db.transaction(() =>
		env.ingest.prepareInTransaction(env.db, claim),
	)();
	if (prepared.status !== "ready") throw new Error("prepare was stale");
	return { env, claim, input: prepared.input };
}
type Prepared = ReturnType<typeof prepare>;

/** Not through `runJob`, so the test controls what happens between the steps. */
const execute = (p: Prepared, signal = new AbortController().signal) =>
	p.env.ingest.execute(p.input, {
		signal,
		jobId: p.claim.jobId,
		attempt: 1,
	});

function settle(env: Env, p: Prepared, outcome: SettleOutcome<never>) {
	return env.db.transaction(() =>
		env.ingest.settleInTransaction(env.db, p.claim, p.input, outcome),
	)();
}

/** Index checks shared by the scenarios: coverage, byte ranges, digests. */
function checkIndex(env: Env, n: number, body: string) {
	const v = getPublishedVersionInSnapshot(env.db, key(n))!;
	expect(v).not.toBeNull();
	const bytes = Buffer.from(body, "utf8");
	const fragments = listFragmentsInSnapshot(env.db, v.versionId);
	expect(fragments.map((f) => f.text).join("")).toBe(body);
	let position = 0;
	for (const f of fragments) {
		expect(f.byteStart).toBe(position);
		expect(f.byteEnd - f.byteStart).toBeLessThanOrEqual(2048);
		const slice = bytes.subarray(f.byteStart, f.byteEnd);
		expect(slice.toString("utf8")).toBe(f.text);
		expect(f.textSha256).toBe(sha(slice));
		position = f.byteEnd;
	}
	expect(position).toBe(bytes.length);
	const evidence = listEvidenceInSnapshot(env.db, v.versionId);
	for (const e of evidence) {
		const f = fragments[e.fragmentOrdinal]!;
		expect(e.byteStart).toBeGreaterThanOrEqual(f.byteStart);
		expect(e.byteEnd).toBeLessThanOrEqual(f.byteEnd);
		expect(sha(bytes.subarray(e.byteStart, e.byteEnd))).toBe(e.quoteSha256);
	}
	return { v, fragments, evidence };
}

const sections = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `## 節${i}\n\n本文${i}。${"あ".repeat(40)}\n\n`,
	).join("");

describe("ingest to publish", () => {
	test("fragments cover the body; evidence returns the original text and its sha256", async () => {
		const env = makeEnv({ maxFragmentBytes: 200 });
		const body = `# 題名\n\n${sections(12)}`;
		env.source.put(makeDoc(1, body));
		const { rest } = await syncAll(env);
		expect(
			rest.logs.every((l) => l.prepared === "stale" || l.settled === "applied"),
		).toBe(true);

		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("current");
		expect(row.appliedMarkdownSha256).toBe(sha(Buffer.from(body, "utf8")));
		expect(row.publishedVersionId).not.toBeNull();

		const { v, fragments, evidence } = checkIndex(env, 1, body);
		expect(fragments.length).toBeGreaterThan(5);
		expect(v).toMatchObject({
			state: "published",
			markdownSha256: row.appliedMarkdownSha256,
			byteLength: Buffer.byteLength(body),
			expectedFragments: fragments.length,
			fragmentsWritten: fragments.length,
			vectorsWritten: fragments.length,
			extractionsWritten: fragments.length,
			extractionPartial: false,
			instructionDigest: INSTRUCTION_SET_DIGEST,
			spaceKey: embeddingSpaceKey(SPACE),
		});
		expect(evidence.length).toBeGreaterThan(fragments.length);
		expect(
			listExtractionsInSnapshot(env.db, v.versionId).every(
				(x) => x.status === "ok",
			),
		).toBe(true);
		expect(
			listEntityMentionsInSnapshot(env.db, v.versionId).length,
		).toBeGreaterThan(0);
		// Vectors and full-text rows exist per fragment.
		expect(
			readVersionVectorsInSnapshot(env.db, v.versionId, v.spaceKey!),
		).toHaveLength(fragments.length);
		expect(
			searchFragmentsInSnapshot(env.db, "本文3", 10, ["wiki"]).length,
		).toBeGreaterThan(0);
		// Passages only, and the fragment text itself is embedded.
		expect(env.embedding.calls.every((c) => c.kind === "passage")).toBe(true);
		expect(env.embedding.calls.flatMap((c) => c.texts)).toEqual(
			fragments.map((f) => f.text),
		);
		// Everything was staged through the writer in bundles, never in one long transaction.
		expect(env.writer.writes).toBeGreaterThanOrEqual(4);
	});

	test("many fragments are embedded 64 at a time and staged in bundles", async () => {
		const env = makeEnv({ maxFragmentBytes: 64 });
		const body = sections(40);
		env.source.put(makeDoc(1, body));
		await syncAll(env);
		const { fragments } = checkIndex(env, 1, body);
		expect(fragments.length).toBeGreaterThan(130);
		const sizes = env.embedding.calls.map((c) => c.texts.length);
		expect(Math.max(...sizes)).toBe(64);
		expect(sizes.slice(0, -1).every((n) => n === 64)).toBe(true);
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(fragments.length);
		expect(env.inference.calls).toHaveLength(fragments.length);
		// create + fragment bundles + extraction bundles (bounded by rows, here one) + vector bundles
		const bundles = Math.ceil(fragments.length / 64);
		expect(env.writer.writes).toBe(1 + 2 * bundles + 1);
	});

	test("extractions are staged in bundles bounded by rows, not by fragments", async () => {
		const env = makeEnv({ maxFragmentBytes: 64 });
		const body = sections(400);
		env.source.put(makeDoc(1, body));
		const tables = [
			"knowledge_extractions",
			"knowledge_entity_mentions",
			"knowledge_relation_mentions",
			"knowledge_evidence",
		];
		const total = () => tables.reduce((n, t) => n + count(env, t), 0);
		// Rows present when each write starts: the difference is what the previous write added.
		const seen: number[] = [];
		env.writer.beforeWrite = () => {
			seen.push(total());
		};
		await syncAll(env);
		seen.push(total());
		const steps = seen.slice(1).map((n, i) => n - seen[i]!);
		const rowsInTotal = total();
		expect(rowsInTotal).toBeGreaterThan(4_000);
		// One fragment is about 7 rows here; a bundle stays near the bound.
		expect(Math.max(...steps)).toBeLessThanOrEqual(2_000);
		expect(steps.filter((n) => n > 0).length).toBeGreaterThanOrEqual(
			Math.ceil(rowsInTotal / 2_000),
		);
	});

	const bodies: Record<string, string> = {
		bom: "﻿# Title\n\nbody text here\n",
		crlf: "# One\r\n\r\nline1\r\nline2\r\n\r\n## Two\r\n\r\nmore text\r\n",
		japanese:
			"# 見出し\n\n日本語の本文です。二つ目の文。\n\n## 次\n\n続きの本文。\n",
		emoji: "# e\n\n絵文字 😀👨‍👩‍👧 の本文 😀 end\n",
		frontmatter: "---\ntitle: あ\n---\n\n# H\r\n\r\nbody\r\n",
		fullwidth: "# Ｆｕｌｌ\n\nＡＢＣ　ｄｅｆ\n",
	};
	for (const [name, body] of Object.entries(bodies)) {
		test(`${name}: byte ranges are UTF-8 offsets of the exact body`, async () => {
			const env = makeEnv({ maxFragmentBytes: 40 });
			env.source.put(makeDoc(1, body));
			await syncAll(env);
			const { fragments, evidence } = checkIndex(env, 1, body);
			expect(fragments.length).toBeGreaterThan(0);
			expect(evidence.length).toBeGreaterThan(0);
			if (name === "bom") {
				expect(fragments[0]!.text.startsWith("﻿")).toBe(true);
			}
		});
	}

	test("the search index holds NFKC lower-cased text", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# Ｆｕｌｌ\n\nＡＢＣ　ｄｅｆ\n"));
		await syncAll(env);
		expect(
			searchFragmentsInSnapshot(env.db, "abc def", 5, ["wiki"]),
		).toHaveLength(1);
		expect(
			searchFragmentsInSnapshot(env.db, "abc def", 5, ["wiki"])[0]!.text,
		).toContain("ＡＢＣ");
	});

	test("an empty body publishes a version without fragments", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, ""));
		await syncAll(env);
		const v = getPublishedVersionInSnapshot(env.db, key(1))!;
		expect(v).toMatchObject({ expectedFragments: 0, byteLength: 0 });
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		expect(env.embedding.calls).toHaveLength(0);
	});

	test("the extraction request carries the earlier of the job and inference deadlines", async () => {
		const env = makeEnv({ inferenceTimeoutMs: 50_000 });
		env.source.put(makeDoc(1, "short body"));
		await scanPage0(env);
		const t = env.clock.t;
		// No job deadline: now + the inference limit.
		const first = prepare(env);
		await execute(first);
		expect(env.inference.calls[0]!.deadlineAtMs).toBe(t + 50_000);
		expect(env.inference.calls[0]!.purpose).toBe("extract");
		expect(env.inference.calls[0]!.outputSchema).toBeDefined();
		// The claim's deadline when it is earlier.
		env.sink.open.push({ ...env.sink.calls[0]! });
		const second = prepare(env);
		if (second.input.mode !== "ingest") throw new Error("not an ingest");
		second.input.deadlineAtMs = t + 7_000;
		await execute(second);
		expect(env.inference.calls[1]!.deadlineAtMs).toBe(t + 7_000);
		// ... and not when it is later.
		second.input.deadlineAtMs = t + 90_000;
		await execute(second);
		expect(env.inference.calls[2]!.deadlineAtMs).toBe(t + 50_000);
	});

	test("gleaning is an option: off by default, one more pass per fragment when set", async () => {
		const off = makeEnv();
		off.source.put(makeDoc(1, "alpha beta gamma"));
		await syncAll(off);
		expect(off.inference.calls).toHaveLength(1);

		const on = makeEnv({ gleaning: 1 });
		on.source.put(makeDoc(1, "alpha beta gamma"));
		await syncAll(on);
		expect(on.inference.calls).toHaveLength(2);
		expect(on.inference.calls[0]!.prompt).not.toContain("---Previous---");
		expect(on.inference.calls[1]!.prompt).toContain("---Previous---");
		const v = getPublishedVersionInSnapshot(on.db, key(1))!;
		// Both passes' entities are kept, with ids renumbered.
		expect(listEntityMentionsInSnapshot(on.db, v.versionId)).toHaveLength(4);
	});
});

describe("new versions and cleanup", () => {
	test("a new version retires the old one and the cleanup removes its rows in bounded steps", async () => {
		const env = makeEnv({ maxFragmentBytes: 200, cleanupBatchRows: 7 });
		const v1 = `# v1\n\n${sections(8)}`;
		env.source.put(makeDoc(1, v1));
		await syncAll(env);
		const old = getPublishedVersionInSnapshot(env.db, key(1))!;
		expect(old.state).toBe("published");

		const v2 = `# v2\n\n${sections(9)}`;
		env.source.put(makeDoc(1, v2));
		env.events.length = 0;
		await scanPage0(env);
		const first = prepare(env);
		const out = await execute(first);
		expect(settle(env, first, { type: "success", result: out as never })).toBe(
			"applied",
		);
		// Published, and the old version no longer reads, even before its rows are gone.
		const current = getPublishedVersionInSnapshot(env.db, key(1))!;
		expect(current.versionId).not.toBe(old.versionId);
		expect(current.markdownSha256).toBe(sha(Buffer.from(v2, "utf8")));
		expect(getVersionInSnapshot(env.db, old.versionId)!.state).toBe("retired");
		expect(getDocumentInTransaction(env.db, key(1))!.generation).toBe(1);
		// The first settle deleted at most its bound.
		const deleted = () =>
			env.events
				.filter((e) => e.type === "knowledge.ingest.cleanup")
				.map((e) => (e.fields as { deletedRows: number }).deletedRows);
		expect(deleted()).toEqual([7]);
		// More remains, so the chain went on with cleanup-only links.
		expect(env.sink.open).toHaveLength(1);
		const links = await drain(env);
		expect(links.ran).toBeGreaterThan(2);
		expect(deleted().every((n) => n >= 1 && n <= 7)).toBe(true);
		expect(stateOfVersions(env)).toEqual(["published"]);
		expect(getVersionInSnapshot(env.db, old.versionId)).toBeNull();
		expect(count(env, "knowledge_fragments")).toBe(
			listFragmentsInSnapshot(env.db, current.versionId).length,
		);
		expect(count(env, "knowledge_fragment_fts")).toBe(
			count(env, "knowledge_fragments"),
		);
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		// Cleanup-only links ran no extraction.
		expect(env.inference.calls.length).toBeLessThan(80);
		checkIndex(env, 1, v2);
	});

	test("a recovery-only change does not ingest again", async () => {
		const env = makeEnv();
		const doc = makeDoc(1, "same body");
		env.source.put(doc);
		await syncAll(env);
		const calls = env.inference.calls.length;
		env.source.put({
			...doc,
			etag: `"${"a".repeat(64)}"`,
			contentDigest: "b".repeat(64),
		});
		await syncAll(env);
		expect(env.inference.calls).toHaveLength(calls);
		expect(count(env, "knowledge_versions")).toBe(1);
	});

	test("a document outside the allowed areas is not ingested", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body", { namespace: "secret" }));
		await syncAll(env);
		expect(env.source.readCalls).toBe(0);
		expect(count(env, "knowledge_versions")).toBe(0);
		expect(env.sink.calls).toHaveLength(0);
	});

	test("404 and 403 make the document unavailable and keep its published version", async () => {
		for (const code of ["not_found", "forbidden"] as const) {
			const env = makeEnv();
			env.source.put(makeDoc(1, "v1"));
			await syncAll(env);
			const published = getPublishedVersionInSnapshot(env.db, key(1))!;
			env.source.put(makeDoc(1, "v2 changed"));
			env.source.readErrors.set(docId(1), code);
			await syncAll(env);
			const row = getDocumentInTransaction(env.db, key(1))!;
			expect(row.state).toBe("unavailable");
			expect(row.publishedVersionId).toBe(published.versionId);
			expect(getVersionInSnapshot(env.db, published.versionId)!.state).toBe(
				"published",
			);
			// Nothing was staged for the unreadable version.
			expect(stateOfVersions(env)).toEqual(["published"]);
		}
	});
});

describe("extraction failures", () => {
	const body =
		"# A\n\nfirst fragment text\n\n# B\n\nsecond fragment text\n\n# C\n\nthird fragment text\n\n# D\n\nfourth fragment text\n";

	/** Three fragments; `answers` rewrite what the model says for each (by order of calls). */
	async function ingestWith(
		answer: (call: number, text: string) => string | Error | "not_ok",
	) {
		const env = makeEnv({ maxFragmentBytes: 40 });
		env.inference.script = (request, call) => {
			const out = answer(call, fragmentTextOf(request));
			if (out instanceof Error) throw out;
			if (out === "not_ok") {
				return {
					ok: false,
					error: "provider_down",
					model: null,
					usage: {
						inputTokens: null,
						cachedTokens: null,
						outputTokens: null,
						reasoningTokens: null,
						calls: null,
					},
					durationMs: 1,
				};
			}
			return inferenceOk(out);
		};
		env.source.put(makeDoc(1, body));
		await syncAll(env);
		const v = getPublishedVersionInSnapshot(env.db, key(1))!;
		return {
			env,
			v,
			extractions: listExtractionsInSnapshot(env.db, v.versionId),
		};
	}
	const good = (text: string) =>
		JSON.stringify({
			entities: [
				{
					id: "e1",
					name: "n",
					type: "t",
					description: "d",
					evidence: [[...text].slice(0, 5).join("")],
				},
			],
			relations: [],
		});

	test("invalid JSON and a schema violation fail only their fragment; the version is partial", async () => {
		const { env, v, extractions } = await ingestWith((call, text) => {
			if (call === 1) return "this is not json";
			if (call === 2)
				return JSON.stringify({ entities: [{ id: "x" }], relations: [] });
			return good(text);
		});
		expect(extractions.length).toBeGreaterThanOrEqual(4);
		expect(extractions.slice(0, 2).map((x) => [x.status, x.errorCode])).toEqual(
			[
				["failed", "invalid_json"],
				["failed", "schema_violation"],
			],
		);
		expect(extractions.slice(2).every((x) => x.status === "ok")).toBe(true);
		expect(v.extractionPartial).toBe(true);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		// The status says so.
		const status = readStatusInSnapshot(
			env.db,
			{ principal: "p", namespaces: ["wiki"] },
			env.clock.t,
			{ verifiedWithinMs: 1e9 },
		);
		expect(status.partialReasons).toContain("extraction_incomplete");
		// The events carry counts only.
		expect(JSON.stringify(env.events)).not.toContain("this is not json");
	});

	/** v1 published; v2 observed; the model's provider breaks in the middle of v2 (`call` 2). */
	async function providerBreaksOnV2(
		breakIt: (request: never) => InferenceResult | never,
	) {
		const env = makeEnv({ maxFragmentBytes: 40 });
		env.source.put(makeDoc(1, "# v1\n\nfirst version body\n"));
		await syncAll(env);
		const before = getPublishedVersionInSnapshot(env.db, key(1))!;
		env.source.put(makeDoc(1, body));
		await scanPage0(env);
		const callsBefore = env.inference.calls.length;
		env.inference.script = (request, call) => {
			if (call - callsBefore === 2) return breakIt(request as never);
			return inferenceOk(good(fragmentTextOf(request)));
		};
		const log = await runJob(
			env.db,
			env.ingest,
			env.ingest.schema.parse(env.sink.open.shift()!.payload),
			undefined,
			{ attempts: "once" },
		);
		return { env, before, log };
	}
	const notOk = (): InferenceResult => ({
		ok: false,
		error: "provider_down",
		model: null,
		usage: {
			inputTokens: null,
			cachedTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			calls: null,
		},
		durationMs: 1,
	});

	for (const [name, breakIt] of [
		[
			"a port that throws",
			() => {
				throw new Error("provider exploded: SECRET-PROMPT");
			},
		],
		["a port that answers ok:false", notOk],
	] as const) {
		test(`${name} publishes nothing: the ingest ends as a temporary failure and the old version stays`, async () => {
			const { env, before, log } = await providerBreaksOnV2(breakIt);
			expect(log.error).toBeInstanceOf(PortFailure);
			expect(JSON.stringify(log.error)).not.toContain("SECRET");
			const row = getDocumentInTransaction(env.db, key(1))!;
			// Not published, not counted; the document waits.
			expect(row.state).toBe("stale");
			expect(row.publishedVersionId).toBe(before.versionId);
			expect(row.ingestRetry).toBe(0);
			expect(row.transientFailures).toBe(1);
			expect(row.ingestNotBefore).toBe(env.clock.t + 5 * 60 * 1000);
			expect(getVersionInSnapshot(env.db, before.versionId)!.state).toBe(
				"published",
			);
			expect(stateOfVersions(env).filter((s) => s !== "abandoned")).toEqual([
				"published",
			]);
			// The old version is retained and, being only stale, is not served as current.
			expect(getRetainedVersionInSnapshot(env.db, key(1))!.versionId).toBe(
				before.versionId,
			);
			// Nothing is left to pick right now: the chain closed.
			expect(getChainInTransaction(env.db).openSweep).toBeNull();
		});
	}

	test("a fragment whose answer arrived but is invalid still fails alone", async () => {
		const { v, extractions } = await ingestWith((call, text) =>
			call === 2 ? "{" : good(text),
		);
		expect(extractions[1]).toMatchObject({
			status: "failed",
			errorCode: "invalid_json",
		});
		expect(extractions.filter((x) => x.status === "ok").length).toBe(
			extractions.length - 1,
		);
		expect(v.extractionPartial).toBe(true);
	});

	test("a quotation outside the fragment drops its element, not the fragment", async () => {
		const { env, v, extractions } = await ingestWith((call, text) =>
			call === 1
				? JSON.stringify({
						entities: [
							{
								id: "e1",
								name: "kept",
								type: "t",
								description: "d",
								evidence: [[...text].slice(0, 4).join("")],
							},
							{
								id: "e2",
								name: "lost",
								type: "t",
								description: "d",
								evidence: ["a quotation nobody wrote"],
							},
						],
						relations: [
							{
								id: "r1",
								source: "e1",
								target: "e2",
								directed: false,
								relation: "r",
								description: "d",
								keywords: [],
								qualifiers: {
									negated: false,
									condition: null,
									certainty: "stated",
								},
								evidence: [[...text].slice(0, 4).join("")],
							},
						],
					})
				: good(text),
		);
		expect(extractions[0]).toMatchObject({ status: "ok" });
		expect(extractions[0]!.dropped.map((d) => d.reason).sort()).toEqual([
			"no_evidence",
			"not_in_fragment",
			"unknown_entity",
		]);
		const names = listEntityMentionsInSnapshot(env.db, v.versionId)
			.filter((e) => e.fragmentOrdinal === 0)
			.map((e) => e.name);
		expect(names).toEqual(["kept"]);
		// Dropped elements do not make the version partial.
		expect(v.extractionPartial).toBe(false);
	});
});

describe("embedding failures", () => {
	/** Ingest v1 cleanly, then break the embedder and try v2. Returns what v1 looked like. */
	async function brokenSecondIngest(
		options: Parameters<typeof makeEnv>[0],
		body2: string,
		breakIt: (env: Env) => void,
	) {
		const env = makeEnv(options);
		env.source.put(makeDoc(1, "# v1\n\nfirst version body\n"));
		await syncAll(env);
		const before = getPublishedVersionInSnapshot(env.db, key(1))!;
		const fragmentsBefore = listFragmentsInSnapshot(env.db, before.versionId);
		env.source.put(makeDoc(1, body2));
		await scanPage0(env);
		breakIt(env);
		const log = await runJob(
			env.db,
			env.ingest,
			env.ingest.schema.parse(env.sink.open.shift()!.payload),
		);
		return { env, before, fragmentsBefore, log };
	}
	function expectUntouched(
		env: Env,
		before: { versionId: number },
		fragmentsBefore: unknown[],
	) {
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.state).toBe("stale");
		expect(row.publishedVersionId).toBe(before.versionId);
		expect(getVersionInSnapshot(env.db, before.versionId)!.state).toBe(
			"published",
		);
		expect(listFragmentsInSnapshot(env.db, before.versionId)).toHaveLength(
			fragmentsBefore.length,
		);
		// The half-staged version was abandoned (its rows go in bounded cleanup steps).
		expect(stateOfVersions(env).filter((s) => s !== "abandoned")).toEqual([
			"published",
		]);
		expect(row.ingestRetry).toBe(1);
	}

	test("a dimension mismatch publishes nothing and keeps the published version", async () => {
		const { env, before, fragmentsBefore, log } = await brokenSecondIngest(
			{},
			"# v2\n\nsecond version body\n",
			(e) => {
				e.embedding.mutate = (a) => ({
					...a,
					vectors: a.vectors.map((v) => v.slice(1)),
				});
			},
		);
		expect(log.error).toMatchObject({ code: "contract_mismatch" });
		expect(env.ingest.classify(log.error)).toBe("fail");
		expectUntouched(env, before, fragmentsBefore);
	});

	test("a wrong number of vectors, a non-finite value or a malformed space break the contract", async () => {
		const breakers: Array<
			(a: { vectors: number[][]; space: typeof SPACE }) => unknown
		> = [
			(a) => ({ ...a, vectors: a.vectors.slice(1) }),
			(a) => ({
				...a,
				vectors: a.vectors.map((v) => [Number.NaN, ...v.slice(1)]),
			}),
			(a) => ({
				...a,
				vectors: a.vectors.map((v) => [
					Number.POSITIVE_INFINITY,
					...v.slice(1),
				]),
			}),
			(a) => ({ ...a, space: { ...a.space, dimension: 0 } }),
			(a) => ({ vectors: a.vectors }),
			() => "not an answer",
		];
		for (const breaker of breakers) {
			const { env, before, fragmentsBefore, log } = await brokenSecondIngest(
				{},
				"# v2\n\nsecond\n",
				(e) => {
					e.embedding.mutate = breaker as never;
				},
			);
			expect(log.error).toMatchObject({ code: "contract_mismatch" });
			expectUntouched(env, before, fragmentsBefore);
		}
	});

	test("a space that changes in the middle of an ingest is not published", async () => {
		const { env, before, fragmentsBefore, log } = await brokenSecondIngest(
			{ maxFragmentBytes: 64 },
			sections(20),
			(e) => {
				e.embedding.mutate = (a, call) =>
					call === 2 ? { ...a, space: { ...a.space, revision: "2" } } : a;
			},
		);
		// One call for v1, two for v2: the second answer named another space.
		expect(env.embedding.calls.length).toBe(3);
		expect(log.error).toMatchObject({ code: "contract_mismatch" });
		expectUntouched(env, before, fragmentsBefore);
	});

	test("an embedder that throws is retried by the host and counts nothing", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		env.embedding.onCall = () => {
			throw new Error("embedder down");
		};
		const log = await runJob(
			env.db,
			env.ingest,
			env.ingest.schema.parse(env.sink.open.shift()!.payload),
		);
		expect(log.error).toBeDefined();
		expect(env.ingest.classify(log.error)).toBe("retry");
		expect(JSON.stringify(log.error)).not.toContain("embedder down");
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");
		expect(getChainInTransaction(env.db).openSweep).toBe(1);
		// The staged rows wait for the rerun, which starts over.
		expect(stateOfVersions(env)).toEqual(["staging"]);
		env.embedding.onCall = null;
		const rerun = await runJob(env.db, env.ingest, { sweep: 1 });
		expect(rerun.settled).toBe("applied");
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		expect(stateOfVersions(env)).toEqual(["published"]);
	});

	test("classification: transient source and provider failures retry, contract and data errors fail", () => {
		const env = makeEnv();
		expect(env.ingest.classify(new SourceError("unavailable"))).toBe("retry");
		expect(env.ingest.classify(new SourceError("timeout"))).toBe("retry");
		expect(env.ingest.classify(new SourceError("unauthorized"))).toBe("fail");
		expect(env.ingest.classify(new SourceError("connection_changed"))).toBe(
			"fail",
		);
		expect(env.ingest.classify(new KnowledgeError("contract_mismatch"))).toBe(
			"fail",
		);
		expect(env.ingest.classify(new KnowledgeError("not_available"))).toBe(
			"fail",
		);
		expect(env.ingest.classify(new Error("x"))).toBe("fail");
	});
});

describe("cancel, expiry, interruption and settle failures", () => {
	/** v1 published, v2 observed and the chain job prepared. */
	async function readyForV2(
		options: Parameters<typeof makeEnv>[0] = {},
		body2 = "# v2\n\nsecond version body\n",
	) {
		const env = makeEnv(options);
		env.source.put(makeDoc(1, "# v1\n\nfirst version body\n"));
		await syncAll(env);
		const before = getPublishedVersionInSnapshot(env.db, key(1))!;
		env.source.put(makeDoc(1, body2));
		await scanPage0(env);
		return { env, before, p: prepare(env) };
	}
	const unchanged = (env: Env, before: { versionId: number }) => {
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.publishedVersionId).toBe(before.versionId);
		expect(getVersionInSnapshot(env.db, before.versionId)!.state).toBe(
			"published",
		);
		expect(stateOfVersions(env)).toEqual(["published"]);
	};

	test("an abort in the middle of the extraction fails the job; staging is abandoned and cleaned", async () => {
		const { env, before, p } = await readyForV2(
			{ maxFragmentBytes: 40 },
			sections(3),
		);
		const abort = new AbortController();
		env.inference.script = (_request, call) => {
			if (call === 2) {
				abort.abort(new Error("aborted"));
				throw abort.signal.reason;
			}
			return inferenceOk('{"entities":[],"relations":[]}');
		};
		let thrown: unknown;
		try {
			await execute(p, abort.signal);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(stateOfVersions(env)).toEqual(["published", "staging"]);
		// The host settles an aborted run as failed (or expired / interrupted).
		expect(settle(env, p, { type: "failed", errorCode: "aborted" })).toBe(
			"applied",
		);
		unchanged(env, before);
		// An abort is a temporary end: nothing counted, the document waits.
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.ingestRetry).toBe(0);
		expect(row.transientFailures).toBe(1);
		expect(row.ingestNotBefore).toBe(env.clock.t + 5 * 60 * 1000);
		// Only a waiting document is left, so the chain closes.
		expect(env.sink.open).toHaveLength(0);
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
	});

	test("an abort stops an embedder that honours the signal", async () => {
		const { env, before, p } = await readyForV2();
		const abort = new AbortController();
		env.embedding.onCall = (_call, signal) => {
			abort.abort(new Error("aborted"));
			signal.throwIfAborted();
		};
		await expect(execute(p, abort.signal)).rejects.toThrow("aborted");
		settle(env, p, { type: "interrupted", errorCode: "restart" });
		unchanged(env, before);
	});

	for (const [outcome, counted] of [
		[{ type: "expired" }, false],
		[{ type: "interrupted", errorCode: "restart" }, false],
		[{ type: "interrupted", errorCode: "digest_mismatch" }, false],
		[{ type: "failed", errorCode: "boom" }, false],
		[{ type: "failed", errorCode: "unavailable" }, false],
		[{ type: "failed", errorCode: "digest_mismatch" }, true],
	] as const) {
		test(`${outcome.type}${"errorCode" in outcome ? ` (${outcome.errorCode})` : ""} after a complete execute publishes nothing and abandons the staging; ${counted ? "counted" : "delayed"}`, async () => {
			const { env, before, p } = await readyForV2();
			await execute(p);
			expect(stateOfVersions(env)).toEqual(["published", "staging"]);
			expect(settle(env, p, outcome)).toBe("applied");
			unchanged(env, before);
			const row = getDocumentInTransaction(env.db, key(1))!;
			expect(row.state).toBe("stale");
			// Only a failure the content caused counts; every other end only delays.
			expect(row.ingestRetry).toBe(counted ? 1 : 0);
			expect(row.transientFailures).toBe(counted ? 0 : 1);
			expect(row.ingestNotBefore).toBe(counted ? 0 : env.clock.t + 300_000);
		});
	}

	test("a settle input lost in a restart still finds the document through the chain state", async () => {
		const { env, before, p } = await readyForV2();
		await execute(p);
		env.db.transaction(() =>
			env.ingest.settleInTransaction(env.db, p.claim, null, {
				type: "expired",
			}),
		)();
		unchanged(env, before);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.ingestRetry).toBe(0);
		expect(row.transientFailures).toBe(1);
	});

	test("a retry outcome changes nothing: the same job runs again", async () => {
		const { env, p } = await readyForV2();
		await execute(p);
		const dump = () =>
			JSON.stringify([
				rows(env.db, "SELECT * FROM knowledge_documents"),
				rows(env.db, "SELECT * FROM knowledge_ingest_chain"),
				rows(env.db, "SELECT version_id, state FROM knowledge_versions"),
			]);
		const snapshot = dump();
		const calls = env.sink.calls.length;
		expect(
			settle(env, p, { type: "retry", errorCode: "x", availableAtMs: 1 }),
		).toBe("applied");
		expect(dump()).toBe(snapshot);
		expect(env.sink.calls).toHaveLength(calls);
	});

	test("cancel finds the document from the chain state: abandons staging, counts nothing, delays, stops the chain", async () => {
		const { env, before, p } = await readyForV2();
		expect(getActiveIngestInTransaction(env.db, 2)).toMatchObject({
			documentId: docId(1),
			generation: 1,
		});
		const staged = await execute(p);
		env.db.transaction(() =>
			env.ingest.cancelInTransaction(
				env.db,
				{ jobId: p.claim.jobId, payload: p.claim.payload },
				"user",
			),
		)();
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		// A cancel is a temporary end: nothing counted, the document waits.
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
		expect(getDocumentInTransaction(env.db, key(1))!.transientFailures).toBe(1);
		expect(stateOfVersions(env)).toEqual(["published", "abandoned"]);
		// A late result is not applied: the settle sees an abandoned version.
		expect(settle(env, p, { type: "success", result: staged as never })).toBe(
			"stale",
		);
		const row = getDocumentInTransaction(env.db, key(1))!;
		expect(row.publishedVersionId).toBe(before.versionId);
		expect(row.state).toBe("stale");
		expect(env.sink.open).toHaveLength(0);
		// A scan during the wait queues nothing; the first scan after it restarts the chain.
		await scanPage0(env);
		expect(env.sink.open).toHaveLength(0);
		env.clock.t += 5 * 60 * 1000;
		await scanPage0(env);
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 3 }]);
	});

	test("a cancel while execute is still writing makes its next write fail", async () => {
		const { env, before, p } = await readyForV2();
		env.inference.script = () => {
			// The host cancels while the model is answering.
			env.db.transaction(() =>
				env.ingest.cancelInTransaction(
					env.db,
					{ jobId: p.claim.jobId, payload: p.claim.payload },
					"user",
				),
			)();
			return inferenceOk('{"entities":[],"relations":[]}');
		};
		await expect(execute(p)).rejects.toMatchObject({ code: "not_available" });
		settle(env, p, { type: "failed", errorCode: "not_available" });
		unchanged(env, before);
	});

	test("an exception while settling rolls everything back; the repeated settle fails the job and goes on", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "# one\n\nfirst body\n"));
		env.source.put(makeDoc(2, "# two\n\nsecond body\n"));
		await scanPage0(env);
		const p = prepare(env);
		const out = await execute(p);
		// The enqueue of the next link fails inside the settling transaction.
		env.sink.throwOn = (job) => job.kind === "knowledge.ingest-next";
		expect(() =>
			settle(env, p, { type: "success", result: out as never }),
		).toThrow("sink exploded");
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			publishedVersionId: null,
		});
		expect(stateOfVersions(env)).toEqual(["staging"]);
		expect(getChainInTransaction(env.db).openSweep).toBe(1);
		// Eumenes then calls settle again with `failed (settle_failed)`; the sink works now.
		env.sink.throwOn = null;
		expect(settle(env, p, { type: "failed", errorCode: "settle_failed" })).toBe(
			"applied",
		);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			publishedVersionId: null,
			// `settle_failed` is no failure of the content: nothing counted, the document waits.
			ingestRetry: 0,
			transientFailures: 1,
		});
		expect(stateOfVersions(env)).toEqual([]);
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 2 }]);
		// Document 2 goes first; document 1 waits, so the chain closes after it.
		await drain(env);
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("stale");
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		// After the wait the next scan queues document 1 again.
		env.clock.t += 5 * 60 * 1000;
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "current",
			ingestRetry: 0,
			transientFailures: 0,
			ingestNotBefore: 0,
		});
	});
});

describe("the chain", () => {
	test("150 documents never leave more than one open chain job; sweep numbers rise and the chain closes", async () => {
		const env = makeEnv();
		env.source.pageSize = 100;
		for (let i = 1; i <= 150; i++)
			env.source.put(makeDoc(i, `# d${i}\n\nbody ${i}\n`));
		const first = await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		expect(first.settled).toBe("applied");
		const chainJobs = () =>
			env.sink.open.filter((j) => j.kind === "knowledge.ingest-next");
		expect(chainJobs()).toHaveLength(1);
		let guard = 0;
		while (env.sink.open.length > 0 && guard++ < 1000) {
			const job = env.sink.open.shift()!;
			if (job.kind === "knowledge.sync-page") {
				await runJob(env.db, env.sync, env.sync.schema.parse(job.payload));
				expect(chainJobs().length).toBeLessThanOrEqual(1);
				continue;
			}
			// While a link runs no other chain job is open.
			expect(chainJobs()).toHaveLength(0);
			await runJob(env.db, env.ingest, env.ingest.schema.parse(job.payload));
			expect(chainJobs().length).toBeLessThanOrEqual(1);
		}
		const sweeps = env.sink.calls
			.filter((c) => c.kind === "knowledge.ingest-next")
			.map((c) => (c.payload as { sweep: number }).sweep);
		expect(sweeps).toEqual([...sweeps].sort((a, b) => a - b));
		expect(new Set(sweeps).size).toBe(sweeps.length);
		expect(sweeps.length).toBeGreaterThanOrEqual(150);
		// Every enqueue was a fresh key: the queue never saw a duplicate.
		expect(new Set(env.sink.calls.map((c) => c.dedupeKey)).size).toBe(
			env.sink.calls.length,
		);
		expect(
			rows(env.db, "SELECT 1 FROM knowledge_documents WHERE state = 'current'"),
		).toHaveLength(150);
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		const scan = rows(env.db, "SELECT documents_queued FROM knowledge_scans");
		expect(scan[0]!.documents_queued).toBe(150);
	});

	test("a chain with nothing to do stops and queues nothing", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "x"));
		await syncAll(env);
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		expect(env.sink.open).toHaveLength(0);
		// A lone link (for example one that outlived its work) finds nothing and writes nothing else.
		await scanPage0(env);
		expect(env.sink.open).toHaveLength(0);
	});

	test("the registry decides the order: fewest attempts, then the oldest observation", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(2, "second"));
		env.source.put(makeDoc(1, "first"));
		env.source.put(makeDoc(3, "third"));
		await scanPage0(env);
		env.source.readErrors.set(docId(1), "invalid_response");
		const order: string[] = [];
		const original = env.source.read.bind(env.source);
		env.source.read = async (id: string) => {
			order.push(id);
			return original(id);
		};
		await drain(env);
		// Equal observation times tie on the id; a failed document waits behind those with fewer attempts.
		expect(order).toEqual([docId(1), docId(2), docId(3), docId(1), docId(1)]);
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
		expect(getDocumentInTransaction(env.db, key(3))!.state).toBe("current");
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(3);
	});

	test("a replaced chain queues no successor; its late result is still judged by the tuple", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body one"));
		await scanPage0(env);
		const p = prepare(env);
		const out = await execute(p);
		// The link ran long; a scan an hour later takes it for lost and starts sweep 2.
		env.clock.t += 60 * 60 * 1000;
		await scanPage0(env);
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 2 }]);
		expect(settle(env, p, { type: "success", result: out as never })).toBe(
			"applied",
		);
		// The valid result was published, but the old link did not queue a second job.
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 2 }]);
		expect(getChainInTransaction(env.db).openSweep).toBe(2);
		// The new link has nothing left to do and stops the chain.
		const log = await runJob(env.db, env.ingest, { sweep: 2 });
		expect(log.prepared).toBe("stale");
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
	});

	test("a replaced link neither works nor touches the new link's document", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body one"));
		await scanPage0(env);
		const old = prepare(env);
		env.clock.t += 60 * 60 * 1000;
		await scanPage0(env);
		const fresh = prepare(env);
		await execute(fresh);
		// The old link fails late: it counts nothing and abandons nothing of the new one.
		expect(settle(env, old, { type: "failed", errorCode: "late" })).toBe(
			"applied",
		);
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
		expect(stateOfVersions(env)).toEqual(["staging"]);
		// And the old link's prepare would be stale.
		const rerun = await runJob(env.db, env.ingest, { sweep: 1 });
		expect(rerun.prepared).toBe("stale");
		expect(
			settle(env, fresh, {
				type: "success",
				result: (await execute(fresh)) as never,
			}),
		).toBe("applied");
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("a stalled chain is restarted by a scan after an hour, not before", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		env.sink.open = []; // the job is lost
		env.clock.t += 59 * 60 * 1000;
		await scanPage0(env);
		expect(env.sink.open).toHaveLength(0);
		env.clock.t += 2 * 60 * 1000;
		await scanPage0(env);
		expect(env.sink.open.map((j) => j.payload)).toEqual([{ sweep: 2 }]);
		await drain(env);
		expect(getDocumentInTransaction(env.db, key(1))!.state).toBe("current");
	});

	test("a version over the attempt limit is not chosen until its version changes", async () => {
		const env = makeEnv({ maxUnappliedAttempts: 2 });
		env.source.put(makeDoc(1, "# broken\n\nbody\n"));
		env.source.put(makeDoc(2, "# fine\n\nbody\n"));
		// Only document 1 is poisoned: the embedder breaks while it is the one being read.
		const original = env.source.read.bind(env.source);
		let reading = "";
		env.source.read = async (id: string) => {
			reading = id;
			return original(id);
		};
		env.embedding.mutate = (a) =>
			reading === docId(1)
				? { ...a, vectors: a.vectors.map((v) => v.slice(1)) }
				: a;
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "stale",
			ingestRetry: 2,
		});
		expect(getDocumentInTransaction(env.db, key(2))!.state).toBe("current");
		const attempts = env.source.readCalls;
		// More scans start no chain for it.
		await syncAll(env);
		expect(env.source.readCalls).toBe(attempts);
		expect(env.sink.open).toHaveLength(0);
		const status = readStatusInSnapshot(
			env.db,
			{ principal: "p", namespaces: ["wiki"] },
			env.clock.t,
			{ verifiedWithinMs: 1e9, maxUnappliedAttempts: 2 },
		);
		expect(status.partialReasons).toContain("failed_documents");
		// A new version resets the count and is ingested.
		env.source.put(makeDoc(1, "# fixed\n\nbody\n"));
		reading = "";
		env.embedding.mutate = null;
		await syncAll(env);
		expect(getDocumentInTransaction(env.db, key(1))).toMatchObject({
			state: "current",
			ingestRetry: 0,
		});
	});

	test("an unconfigured source stops the chain at prepare, without counting", async () => {
		const env = makeEnv();
		env.source.put(makeDoc(1, "body"));
		await scanPage0(env);
		env.source.currentBinding = null;
		const log = await runJob(env.db, env.ingest, { sweep: 1 });
		expect(log.prepared).toBe("stale");
		expect(getChainInTransaction(env.db).openSweep).toBeNull();
		expect(getDocumentInTransaction(env.db, key(1))!.ingestRetry).toBe(0);
	});
});

describe("events", () => {
	test("events carry ids, counts and codes, never the body, a quotation or the prompt", async () => {
		const env = makeEnv();
		env.inference.script = (request) =>
			inferenceOk(
				JSON.stringify({
					entities: [
						{
							id: "e1",
							name: "SECRET-NAME",
							type: "t",
							description: "SECRET-DESC",
							evidence: ["SECRET"],
						},
					],
					relations: [],
				}) + (request ? "" : ""),
			);
		env.source.put(makeDoc(1, "SECRET-BODY text about things"));
		await syncAll(env);
		const text = JSON.stringify(env.events);
		for (const secret of [
			"SECRET-BODY",
			"SECRET-NAME",
			"SECRET-DESC",
			"Input",
			"text about",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(
			env.events.some((e) => e.type === "knowledge.document.published"),
		).toBe(true);
	});
});
