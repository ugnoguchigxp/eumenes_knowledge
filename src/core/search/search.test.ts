import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	KnowledgeError,
	searchResponseSchema,
	type SearchResponse,
} from "../../contracts/index.js";
import { retireDocumentInTransaction } from "../../sqlite/index.js";
import { docId, makeDoc, syncAll } from "../harness.fixture.js";
import { vectorIndexStats } from "./index.js";
import { ACCESS, ingestAll, makeSearchEnv } from "./search.fixture.js";

const sha = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");
const ids = (r: SearchResponse) => r.results.map((h) => h.documentId);
const route = (r: SearchResponse, name: string) =>
	r.routes.find((x) => x.route === name)!;

const DOCS = [
	{ n: 1, markdown: "# 東京の天気\n\n東京は晴れです。alpha の話。\n" },
	{ n: 2, markdown: "# 大阪の食べ物\n\nたこ焼きが有名です。bravo の話。\n" },
	{ n: 3, markdown: "# Notes\n\nFull-width ＡＢＣ text and charlie topic.\n" },
	{ n: 4, markdown: "﻿# Bom doc\r\n\r\n絵文字 😀 を含む delta の文書。\r\n" },
];

async function ready() {
	const env = makeSearchEnv();
	await ingestAll(env, DOCS);
	return env;
}

describe("text route", () => {
	test("trigram match, normalized, with a traceable hit", async () => {
		const env = await ready();
		const r = await env.run({ query: "abc text", routes: ["text"] });
		expect(ids(r)).toEqual([docId(3)]);
		expect(r.lexicalMode).toBe("trigram");
		const hit = r.results[0]!;
		expect(hit.rank).toBe(1);
		expect(hit.state).toBe("current");
		expect(hit.matchedBy).toEqual([{ route: "text", rank: 1 }]);
		expect(hit.mentions).toEqual([]);
		// the hit leads back to the exact bytes and digest
		const bytes = Buffer.from(DOCS[2]!.markdown, "utf8");
		expect(hit.markdownSha256).toBe(sha(bytes));
		const slice = bytes.subarray(hit.fragment.byteStart, hit.fragment.byteEnd);
		expect(slice.toString("utf8")).toBe(hit.quote);
		expect(sha(slice)).toBe(hit.quoteSha256);
		expect(hit.fragment.headingPath).toEqual(["Notes"]);
		expect(route(r, "text")).toMatchObject({ status: "ok", candidates: 1 });
		expect(route(r, "vector")).toBeUndefined();
		// every response satisfies the contract
		expect(searchResponseSchema.parse(r)).toEqual(r);
	});

	test("Japanese text, BOM, CRLF and emoji ranges", async () => {
		const env = await ready();
		const r = await env.run({ query: "絵文字 😀", routes: ["text"] });
		expect(ids(r)).toEqual([docId(4)]);
		const hit = r.results[0]!;
		const bytes = Buffer.from(DOCS[3]!.markdown, "utf8");
		expect(bytes[0]).toBe(0xef);
		expect(
			bytes
				.subarray(hit.fragment.byteStart, hit.fragment.byteEnd)
				.toString("utf8"),
		).toBe(hit.quote);
		expect(hit.quote.startsWith("﻿")).toBe(true);
		expect(hit.quote).toContain("\r\n");
	});

	test("a query under 3 characters scans the index text and says so", async () => {
		const env = await ready();
		const r = await env.run({ query: "東京", routes: ["text"] });
		expect(r.lexicalMode).toBe("substring_scan");
		expect(ids(r)).toEqual([docId(1)]);
		expect(route(r, "text").status).toBe("ok");
		// full-width one-character queries normalize to ASCII
		const one = await env.run({ query: "Ａ", routes: ["text"] });
		expect(one.lexicalMode).toBe("substring_scan");
		expect(ids(one)).toContain(docId(3));
	});

	test("above the scan bound a short query skips the route (and says why)", async () => {
		const env = await ready();
		const r = await env.run(
			{ query: "東京", routes: ["text", "entity"] },
			{ substringScanMaxFragments: 3 },
		);
		expect(r.results).toEqual([]);
		expect(r.lexicalMode).toBe("none");
		for (const name of ["text", "entity"]) {
			expect(route(r, name)).toMatchObject({
				status: "skipped",
				reason: "query_too_short",
				candidates: 0,
			});
		}
		// a route that did not run leaves part of the index unread: never complete
		expect(r.complete).toBe(false);
		expect(r.partialReasons).toContain("route_skipped");
		// at the bound it still scans
		const at = await env.run(
			{ query: "東京", routes: ["text"] },
			{ substringScanMaxFragments: 4 },
		);
		expect(at.lexicalMode).toBe("substring_scan");
		expect(ids(at)).toEqual([docId(1)]);
		expect(at.partialReasons).not.toContain("route_skipped");
		// each skipped route alone is enough
		for (const only of ["text", "entity", "relation"] as const) {
			const one = await env.run(
				{ query: "東京", routes: [only] },
				{ substringScanMaxFragments: 3 },
			);
			expect(route(one, only).status).toBe("skipped");
			expect(one.complete).toBe(false);
			expect(one.partialReasons).toContain("route_skipped");
		}
	});

	test("candidates stop at the route budget and the answer says so", async () => {
		const env = makeSearchEnv();
		await ingestAll(
			env,
			Array.from({ length: 5 }, (_, i) => ({
				n: i + 1,
				markdown: `# Doc\n\nshared phrase number ${i}\n`,
			})),
		);
		const r = await env.run(
			{ query: "shared phrase", routes: ["text"] },
			{ candidatesPerRoute: 3 },
		);
		expect(route(r, "text").candidates).toBe(3);
		expect(r.partialReasons).toContain("route_budget_exhausted");
		expect(r.complete).toBe(false);
		const all = await env.run({ query: "shared phrase", routes: ["text"] });
		expect(all.results).toHaveLength(5);
		expect(all.partialReasons).not.toContain("route_budget_exhausted");
	});

	test("limit caps the results", async () => {
		const env = await ready();
		const r = await env.run({ query: "の", limit: 1, routes: ["text"] });
		expect(r.results).toHaveLength(1);
	});
});

describe("entity and relation routes", () => {
	test("a mention is found and carries the byte range of its evidence", async () => {
		const env = await ready();
		const text = "# 大阪の食べ物\n\nたこ焼きが有名です。bravo の話。\n";
		// the entity named after the first characters of the fragment
		const first = [...text].slice(0, 6).join("");
		const r = await env.run({ query: `name-${first}`, routes: ["entity"] });
		expect(ids(r)).toEqual([docId(2)]);
		const hit = r.results[0]!;
		expect(hit.matchedBy).toEqual([{ route: "entity", rank: 1 }]);
		expect(hit.mentions).toHaveLength(1);
		const m = hit.mentions[0]!;
		expect(m.kind).toBe("entity");
		expect(m.label).toBe(`name-${first}`);
		const bytes = Buffer.from(text, "utf8");
		expect(m.evidence).toHaveLength(1);
		const ev = m.evidence[0]!;
		const quoted = bytes.subarray(ev.byteStart, ev.byteEnd);
		expect(quoted.toString("utf8")).toBe(first);
		expect(sha(quoted)).toBe(ev.quoteSha256);
		expect(route(r, "entity")).toMatchObject({ status: "ok", candidates: 1 });
	});

	test("the relation route matches the relation, description and keywords", async () => {
		const env = await ready();
		const text = "# Notes\n\nFull-width ＡＢＣ text and charlie topic.\n";
		const chars = [...text];
		const a = chars.slice(0, 6).join("");
		const b = chars.slice(6, 12).join("");
		for (const query of [`links-${a}`, `kw-${b}`, `${a} to ${b}`]) {
			const r = await env.run({ query, routes: ["relation"] });
			expect(ids(r)).toEqual([docId(3)]);
			expect(r.results[0]!.mentions[0]!.kind).toBe("relation");
			expect(r.results[0]!.mentions[0]!.label).toBe(`links-${a}`);
		}
		// a name is an entity's field, not a relation's
		const none = await env.run({ query: `name-${a}`, routes: ["relation"] });
		expect(none.results).toEqual([]);
	});

	test("a short query scans the mentions (same rule as the text route)", async () => {
		const env = await ready();
		const r = await env.run({ query: "ab", routes: ["entity"] });
		expect(route(r, "entity").status).toBe("ok");
		expect(r.results.length).toBeGreaterThan(0);
		for (const h of r.results) expect(h.mentions.length).toBeGreaterThan(0);
	});
});

describe("fusion", () => {
	test("a fragment found by several routes is one hit with each route's rank", async () => {
		const env = await ready();
		// "alpha" is in doc 1 only: text and vector both find it first
		const r = await env.run({ query: "alpha", routes: ["text", "vector"] });
		expect(r.results[0]!.documentId).toBe(docId(1));
		expect(r.results[0]!.matchedBy).toEqual([
			{ route: "text", rank: 1 },
			{ route: "vector", rank: 1 },
		]);
		// one entry per fragment even though two routes found it
		expect(new Set(ids(r)).size).toBe(r.results.length);
		// the vector route alone returns every searchable fragment, ranks only
		const v = await env.run({ query: "alpha", routes: ["vector"], limit: 50 });
		expect(v.results).toHaveLength(4);
		expect(v.results.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
		expect(v.results[0]!.documentId).toBe(docId(1));
		expect(v.results.every((h) => !("score" in h))).toBe(true);
		expect(v.lexicalMode).toBe("none");
	});

	test("all four routes together", async () => {
		const env = await ready();
		const r = await env.run({ query: "bravo" });
		expect(r.routes.map((x) => x.route)).toEqual([
			"text",
			"vector",
			"entity",
			"relation",
		]);
		expect(r.results[0]!.documentId).toBe(docId(2));
	});
});

describe("vector residency", () => {
	test("only changed versions are read again; retired vectors are never returned", async () => {
		const env = await ready();
		const first = await env.run({ query: "alpha", routes: ["vector"] });
		expect(route(first, "vector").status).toBe("ok");
		const loaded = vectorIndexStats(env.vectors);
		expect(loaded.versionLoads).toBe(4);
		expect(loaded.spaces).toHaveLength(1);

		await env.run({ query: "bravo", routes: ["vector"] });
		expect(vectorIndexStats(env.vectors).versionLoads).toBe(4);
		expect(vectorIndexStats(env.vectors).rowsLoaded).toBe(loaded.rowsLoaded);

		// publish a new version of document 1: its old text is gone, the old vectors dropped
		env.source.put(makeDoc(1, "# 東京\n\nNew text now about bravo.\n"));
		env.clock.t += 1000;
		await syncAll(env);
		const after = await env.run({
			query: "alpha",
			routes: ["vector"],
			limit: 50,
		});
		const stats = vectorIndexStats(env.vectors);
		expect(stats.versionLoads).toBe(5);
		expect(stats.versionDrops).toBe(1);
		expect(after.results).toHaveLength(4);
		const doc1 = after.results.find((h) => h.documentId === docId(1))!;
		expect(doc1.quote).toContain("New text");
		// doc 1 now speaks of bravo, so it is no longer the nearest to "alpha"
		expect(after.results[0]!.documentId).not.toBe(docId(1));
		expect(after.results.every((h) => !h.quote.includes("alpha の話"))).toBe(
			true,
		);

		// a withdrawn document drops out of the resident set
		env.db.transaction(() =>
			retireDocumentInTransaction(
				env.db,
				{ sourceNamespace: "docling", documentId: docId(2) },
				"removed",
				env.clock.t,
			),
		)();
		const gone = await env.run({
			query: "bravo",
			routes: ["vector"],
			limit: 50,
		});
		expect(gone.results.map((h) => h.documentId)).not.toContain(docId(2));
		expect(vectorIndexStats(env.vectors).versionDrops).toBe(2);
	});

	test("the resident bound fails the route", async () => {
		const env = await ready();
		const { createVectorIndex } = await import("./index.js");
		const small = createVectorIndex({ maxFragments: 3 });
		const r = await search2(env, small);
		expect(route(r, "vector")).toMatchObject({
			status: "failed",
			reason: "vector_index_too_large",
		});
		expect(r.partialReasons).toContain("vector_unavailable");
		expect(vectorIndexStats(small).versionLoads).toBe(0);
		// the other route still answers
		expect(r.results.length).toBeGreaterThan(0);
	});
});

async function search2(
	env: Awaited<ReturnType<typeof ready>>,
	vectors: Parameters<typeof vectorIndexStats>[0],
) {
	const { search } = await import("./index.js");
	return search(
		{ ...env.deps, vectors },
		ACCESS,
		{ query: "alpha", routes: ["text", "vector"] },
		new AbortController().signal,
	);
}

describe("vector route failures", () => {
	test("an embedding that throws fails the route; the other routes answer", async () => {
		const env = await ready();
		env.embedding.onCall = () => {
			throw new Error("down");
		};
		const r = await env.run({ query: "alpha" });
		expect(route(r, "vector")).toMatchObject({
			status: "failed",
			reason: "embedding_failed",
			candidates: 0,
		});
		expect(r.partialReasons).toContain("vector_unavailable");
		expect(r.partialReasons).not.toContain("deadline_exceeded");
		expect(r.complete).toBe(false);
		expect(r.results[0]!.documentId).toBe(docId(1));
		expect(r.results[0]!.matchedBy.map((m) => m.route)).toEqual(["text"]);
	});

	test("a slow embedding is cut at its limit and its signal is aborted", async () => {
		const env = await ready();
		let seen: AbortSignal | null = null;
		env.embedding.onCall = (_call, signal) => {
			seen = signal;
			return new Promise(() => {}); // never answers, ignores the signal
		};
		const started = performance.now();
		const r = await env.run(
			{ query: "alpha" },
			{ queryEmbeddingTimeoutMs: 30 },
		);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(route(r, "vector")).toMatchObject({
			status: "failed",
			reason: "embedding_timeout",
		});
		expect(r.partialReasons).toEqual(
			expect.arrayContaining(["vector_unavailable", "deadline_exceeded"]),
		);
		expect(seen!.aborted).toBe(true);
		expect(r.results.length).toBeGreaterThan(0);
	});

	test("a wrong dimension, a broken answer and an unknown space", async () => {
		const env = await ready();
		env.embedding.mutate = (answer) => ({
			space: answer.space,
			vectors: [[1, 0, 0]],
		});
		const dim = await env.run({ query: "alpha", routes: ["vector"] });
		expect(route(dim, "vector")).toMatchObject({
			status: "failed",
			reason: "dimension_mismatch",
		});

		env.embedding.mutate = (answer) => ({
			space: answer.space,
			vectors: [[1, Number.NaN, 0, 0]],
		});
		const nan = await env.run({ query: "alpha", routes: ["vector"] });
		expect(route(nan, "vector").reason).toBe("embedding_failed");

		env.embedding.mutate = (answer) => ({
			space: { ...answer.space, revision: "2" },
			vectors: [[1, 0, 0, 0]],
		});
		const space = await env.run({ query: "alpha", routes: ["vector"] });
		expect(route(space, "vector")).toMatchObject({
			status: "failed",
			reason: "no_vectors",
		});
		expect(space.partialReasons).toContain("vector_unavailable");
		for (const r of [dim, nan, space]) {
			expect(r.results).toEqual([]);
			expect(r.complete).toBe(false);
		}
	});

	test("a cancelled search throws instead of answering", async () => {
		const env = await ready();
		const pre = new AbortController();
		pre.abort();
		await expect(
			env.run({ query: "alpha" }, {}, ACCESS, pre.signal),
		).rejects.toThrow();

		const mid = new AbortController();
		env.embedding.onCall = () => new Promise(() => {});
		const pending = env.run({ query: "alpha" }, {}, ACCESS, mid.signal);
		setTimeout(() => mid.abort(), 10);
		await expect(pending).rejects.toThrow();
	});

	test("no embedding call is made when the vector route is off", async () => {
		const env = await ready();
		const before = env.embedding.calls.length;
		await env.run({ query: "alpha", routes: ["text", "entity"] });
		expect(env.embedding.calls.length).toBe(before);
		await env.run({ query: "alpha", routes: ["vector"] });
		expect(env.embedding.calls.length).toBe(before + 1);
		expect(env.embedding.calls.at(-1)).toMatchObject({
			texts: ["alpha"],
			kind: "query",
		});
	});
});

describe("namespaces", () => {
	async function twoNamespaces() {
		const env = makeSearchEnv();
		env.source.namespaces = ["wiki", "other"];
		await ingestAll(env, [
			{ n: 1, markdown: "# A\n\nshared words alpha here\n" },
			{
				n: 2,
				markdown: "# B\n\nshared words alpha there\n",
				namespace: "other",
			},
		]);
		return env;
	}

	test("the caller's namespaces are narrowed by the request, never widened", async () => {
		const env = await twoNamespaces();
		const q = { query: "shared words" };
		expect(ids(await env.run(q))).toEqual([docId(1)]);
		expect(ids(await env.run({ ...q, namespaces: ["wiki", "other"] }))).toEqual(
			[docId(1)],
		);
		const both = { principal: "p", namespaces: ["wiki", "other"] };
		expect(ids(await env.run(q, {}, both)).sort()).toEqual([
			docId(1),
			docId(2),
		]);
		expect(
			ids(await env.run({ ...q, namespaces: ["other"] }, {}, both)),
		).toEqual([docId(2)]);
	});

	test("an empty product is an empty answer that is not complete, for every route", async () => {
		const env = await twoNamespaces();
		const before = env.embedding.calls.length;
		for (const r of [
			await env.run({ query: "shared words", namespaces: ["other"] }),
			await env.run(
				{ query: "shared words" },
				{},
				{ principal: "p", namespaces: [] },
			),
		]) {
			expect(r.results).toEqual([]);
			expect(r.complete).toBe(false);
			expect(r.partialReasons.length).toBeGreaterThan(0);
			expect(r.routes.every((x) => x.status === "skipped")).toBe(true);
			expect(r.coverage.documents).toBe(0);
		}
		expect(env.embedding.calls.length).toBe(before);
	});

	test("coverage counts only the narrowed namespaces", async () => {
		const env = await twoNamespaces();
		const r = await env.run({ query: "x" });
		expect(r.coverage.documents).toBe(1);
		const both = await env.run(
			{ query: "x" },
			{},
			{ principal: "p", namespaces: ["wiki", "other"] },
		);
		expect(both.coverage.documents).toBe(2);
	});
});

describe("freshness and coverage", () => {
	test("a clean index is complete and counts its documents", async () => {
		const env = await ready();
		const r = await env.run({ query: "東京の天気" });
		expect(r.complete).toBe(true);
		expect(r.partialReasons).toEqual([]);
		expect(r.coverage).toEqual({
			documents: 4,
			searchable: 4,
			stale: 0,
			unavailable: 0,
			failed: 0,
			extractionIncomplete: 0,
		});
		// nothing matched, but the index is whole: still complete, and the count is there
		const none = await env.run({ query: "zzzzzz", routes: ["text"] });
		expect(none.results).toEqual([]);
		expect(none.complete).toBe(true);
		expect(none.coverage.searchable).toBe(4);
	});

	test("a newer version waiting makes the document stale, hidden and the answer partial", async () => {
		const env = await ready();
		env.source.put(makeDoc(1, "# 東京の天気\n\n新しい内容です。\n"));
		env.clock.t += 1000;
		// observe the new version without ingesting it
		const { runJob } = await import("../harness.fixture.js");
		const { randomUUID } = await import("node:crypto");
		await runJob(env.db, env.sync, {
			scanId: randomUUID(),
			cursor: null,
			page: 0,
		});
		const r = await env.run({
			query: "東京の天気",
			routes: ["text", "vector", "entity"],
		});
		expect(ids(r)).not.toContain(docId(1));
		expect(r.coverage).toMatchObject({ documents: 4, searchable: 3, stale: 1 });
		expect(r.partialReasons).toContain("stale_documents");
		expect(r.complete).toBe(false);
		// nothing matched at all, and it still says it is partial
		const none = await env.run({ query: "zzzzzz", routes: ["text"] });
		expect(none.results).toEqual([]);
		expect(none.complete).toBe(false);
	});

	test("unavailable, excluded and removed documents never appear", async () => {
		const env = await ready();
		const key = (n: number) => ({
			sourceNamespace: "docling",
			documentId: docId(n),
		});
		env.db.transaction(() => {
			retireDocumentInTransaction(env.db, key(1), "excluded", env.clock.t);
			retireDocumentInTransaction(env.db, key(2), "removed", env.clock.t);
		})();
		// document 3 becomes unavailable (it keeps its published version, which must stay hidden)
		env.db
			.query(
				"UPDATE knowledge_documents SET state = 'unavailable' WHERE document_id = ?",
			)
			.run(docId(3));
		const r = await env.run({ query: "の", limit: 50 });
		for (const n of [1, 2, 3]) expect(ids(r)).not.toContain(docId(n));
		expect(r.coverage.unavailable).toBeGreaterThanOrEqual(3);
		expect(r.partialReasons).toContain("unavailable_documents");
		const v = await env.run({ query: "alpha", routes: ["vector"], limit: 50 });
		for (const n of [1, 2, 3]) expect(ids(v)).not.toContain(docId(n));
		expect(ids(v)).toContain(docId(4));
	});

	test("unverified documents are returned as such, and make the answer partial", async () => {
		const env = await ready();
		env.clock.t += 2 * 3_600_000;
		const r = await env.run({ query: "alpha", routes: ["text"] });
		expect(r.results[0]!.state).toBe("unverified");
		expect(r.partialReasons).toContain("unverified_documents");
		expect(r.coverage).toMatchObject({ searchable: 4 });
	});

	test("failed fragments of an extraction are counted", async () => {
		const env = makeSearchEnv();
		env.inference.script = () => ({
			ok: true,
			text: "not json",
			model: "m",
			usage: {
				inputTokens: null,
				cachedTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				calls: null,
			},
			durationMs: 1,
		});
		await ingestAll(env, [{ n: 1, markdown: "# A\n\nsome text\n" }]);
		const r = await env.run({ query: "some text", routes: ["text"] });
		expect(r.results).toHaveLength(1);
		expect(r.coverage.extractionIncomplete).toBe(1);
		expect(r.partialReasons).toContain("extraction_incomplete");
	});

	test("without a complete scan the answer is partial", async () => {
		const env = makeSearchEnv();
		const r = await env.run({ query: "anything", routes: ["text"] });
		expect(r.results).toEqual([]);
		expect(r.partialReasons).toContain("no_complete_scan");
		expect(r.complete).toBe(false);
	});
});

describe("response size", () => {
	test("quotes beyond the byte budget are dropped and the answer says so", async () => {
		const env = makeSearchEnv();
		const body = (i: number) =>
			`# D${i}\n\n${"shared sentence ".repeat(10)}${i}\n`;
		await ingestAll(
			env,
			Array.from({ length: 5 }, (_, i) => ({ n: i + 1, markdown: body(i) })),
		);
		const one = Buffer.byteLength(body(0));
		const r = await env.run(
			{ query: "shared sentence", routes: ["text"] },
			{ maxResponseBytes: one * 2 + 5 },
		);
		expect(r.results).toHaveLength(2);
		expect(r.results.map((h) => h.rank)).toEqual([1, 2]);
		expect(r.partialReasons).toContain("response_truncated");
		expect(r.complete).toBe(false);
		const total = r.results.reduce((n, h) => n + Buffer.byteLength(h.quote), 0);
		expect(total).toBeLessThanOrEqual(one * 2 + 5);
		const zero = await env.run(
			{ query: "shared sentence", routes: ["text"] },
			{ maxResponseBytes: 0 },
		);
		expect(zero.results).toEqual([]);
		expect(zero.partialReasons).toContain("response_truncated");
		// the default budget fits the maximum number of maximum-size fragments
		const full = await env.run({ query: "shared sentence", routes: ["text"] });
		expect(full.results).toHaveLength(5);
		expect(full.partialReasons).not.toContain("response_truncated");
	});
});

describe("input", () => {
	test("an invalid request is invalid_input", async () => {
		const env = await ready();
		for (const bad of [
			{ query: "" },
			{ query: "x", limit: 0 },
			{ query: "x", limit: 51 },
			{ query: "x", routes: [] },
			{ query: "x", routes: ["nope"] },
			{ query: "x", extra: 1 },
			{ query: "x".repeat(1001) },
			null,
			"query",
		]) {
			await expect(env.run(bad as never)).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		await expect(
			env.run({ query: "x" }, { candidatesPerRoute: 0 }),
		).rejects.toThrow(KnowledgeError);
		await expect(
			env.run({ query: "x" }, { verifiedWithinMs: -1 }),
		).rejects.toThrow(KnowledgeError);
	});

	test("a quote mark or an FTS operator in the query is only text", async () => {
		const env = await ready();
		for (const query of [
			'"',
			'a" OR "b',
			"NEAR(alpha bravo)",
			"alpha*",
			"-alpha",
			"((",
		]) {
			const r = await env.run({
				query,
				routes: ["text", "entity", "relation"],
			});
			expect(searchResponseSchema.safeParse(r).success).toBe(true);
		}
	});
});
