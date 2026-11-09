import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	GRAPH_LIMITS,
	type AccessContext,
	type RelatedResponse,
} from "../../contracts/index.js";
import { searchMentionsInSnapshot } from "../../sqlite/search.js";
import { docId, makeDoc, rows } from "../harness.fixture.js";
import { createVectorIndex } from "../search/index.js";
import { fitGraphAnswer, readGraph } from "./graph.js";
import {
	makeLinkEnv,
	putDoc,
	scanAndDrain,
	type LinkEnv,
} from "./link.fixture.js";
import { readRelated } from "./related.js";

const access = (...namespaces: string[]): AccessContext => ({
	principal: "tester",
	namespaces,
});
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

async function names(docs: Record<number, string>): Promise<LinkEnv> {
	const env = makeLinkEnv({}, { extractor: "names" });
	for (const [n, body] of Object.entries(docs)) putDoc(env, Number(n), body);
	await scanAndDrain(env);
	return env;
}

const deps = (env: LinkEnv, vectors = false) => ({
	read: <T>(op: (db: LinkEnv["db"]) => T): T => op(env.db),
	clock: env.clock,
	options: { verifiedWithinMs: 10 ** 12 },
	...(vectors ? { vectors: createVectorIndex() } : {}),
});

/** The body of a document as stored (the fragments joined). */
const bodyOf = (env: LinkEnv, n: number): Buffer =>
	Buffer.from(
		rows(
			env.db,
			`SELECT f.text FROM knowledge_fragments f
JOIN knowledge_documents d ON d.published_version_id = f.version_id
WHERE d.document_id = ? ORDER BY f.ordinal`,
			docId(n),
		)
			.map((r) => r.text as string)
			.join(""),
		"utf8",
	);

describe("related documents by two routes (kg2.md G5)", () => {
	const DOCS = {
		1: "Lantern と設計。",
		2: "設計の話。",
		3: "Lantern の話。設計。",
		4: "設計。",
	};

	test("entities: a rare shared name ranks above a name every fragment has; IDF orders the shared list", async () => {
		const env = await names(DOCS);
		const r = readRelated(deps(env), access("wiki"), { documentId: docId(1) });
		expect(r.status).toBe("ok");
		// 3 shares Lantern (2 of 4 fragments) and 設計 (all 4: IDF 0); 2 and 4 share 設計 alone.
		expect(r.results.map((x) => [x.documentId, x.routes])).toEqual([
			[docId(3), ["entities"]],
			[docId(2), ["entities"]],
			[docId(4), ["entities"]],
		]);
		expect(r.results[0]?.shared.map((s) => s.label)).toEqual([
			"Lantern",
			"設計",
		]);
		expect(r.results.every((x) => x.passages.length > 0)).toBe(true);
	});

	test("embedding: with the vector index every near fragment counts, and `routes` picks the routes", async () => {
		const env = await names({ ...DOCS, 5: "まったく別の段落。" });
		const both = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		// Document 5 shares no name: only the embedding route finds it.
		const five = both.results.find((x) => x.documentId === docId(5));
		expect(five?.routes).toEqual(["embedding"]);
		expect(five?.shared).toEqual([]);
		expect(both.results.find((x) => x.documentId === docId(3))?.routes).toEqual(
			["entities", "embedding"],
		);
		const entitiesOnly = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
			routes: ["entities"],
		});
		expect(entitiesOnly.results.map((x) => x.documentId)).not.toContain(
			docId(5),
		);
		const embeddingOnly = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
			routes: ["embedding"],
		});
		expect(embeddingOnly.results.every((x) => x.shared.length === 0)).toBe(
			true,
		);
		expect(
			embeddingOnly.results.every((x) => x.routes.join() === "embedding"),
		).toBe(true);
	});

	test("every passage is a whole fragment of its document, checked by its digest", async () => {
		const env = await names({ ...DOCS, 5: "まったく別の段落。" });
		const r: RelatedResponse = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		const mine = bodyOf(env, 1);
		for (const result of r.results) {
			const theirs = bodyOf(
				env,
				Number(result.documentId.replace(/^wiki-0*/, "")),
			);
			for (const p of result.passages) {
				expect(
					sha(mine.subarray(p.document.byteStart, p.document.byteEnd)),
				).toBe(p.document.quoteSha256);
				expect(
					sha(theirs.subarray(p.related.byteStart, p.related.byteEnd)),
				).toBe(p.related.quoteSha256);
			}
		}
	});

	test("documents that share an entity come before those the embedding alone found; limit is applied after", async () => {
		const env = await names({ ...DOCS, 5: "まったく別の段落。" });
		const r = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		const byEntities = r.results.map((x) => x.routes.includes("entities"));
		expect(byEntities).toEqual(
			[...byEntities].sort((x, y) => Number(y) - Number(x)),
		);
		expect(r.results.at(-1)?.documentId).toBe(docId(5));
		const one = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
			limit: 1,
		});
		expect(one.results.map((x) => x.documentId)).toEqual([docId(3)]);
	});

	test("documents that share only names of IDF 0 come after those the embedding found (kg2.md §7.10)", async () => {
		const env = await names({ ...DOCS, 5: "設計とまったく別の段落。" });
		// 2 and 4 are of another embedding space: the embedding route does not see them, and they
		// share 設計 alone (in every fragment: IDF 0). 5 shares it too, and the embedding finds it.
		env.db.run(
			`INSERT INTO knowledge_embedding_spaces (space_key, model_id, revision, artifact_digest, dimension,
 query_prefix, passage_prefix)
SELECT 'other', model_id, revision, artifact_digest, dimension, query_prefix, passage_prefix
FROM knowledge_embedding_spaces LIMIT 1`,
		);
		env.db.run(
			`UPDATE knowledge_versions SET space_key = 'other' WHERE version_id IN
 (SELECT published_version_id FROM knowledge_documents WHERE document_id IN (?, ?))`,
			[docId(2), docId(4)],
		);
		const r = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		expect(r.results.map((x) => [x.documentId, x.routes])).toEqual([
			[docId(3), ["entities", "embedding"]],
			[docId(5), ["embedding"]],
			[docId(2), ["entities"]],
			[docId(4), ["entities"]],
		]);
		expect(r.partialReasons).toContain("vector_unavailable");
	});

	test("an index that cannot run gives vector_unavailable; without the embedding route it is not asked", async () => {
		const env = await names(DOCS);
		const tooSmall = {
			...deps(env),
			vectors: createVectorIndex({ maxFragments: 0 }),
		};
		const r = readRelated(tooSmall, access("wiki"), { documentId: docId(1) });
		expect(r.partialReasons).toContain("vector_unavailable");
		expect(r.complete).toBe(false);
		// The entities route still answers.
		expect(r.results.map((x) => x.documentId)[0]).toBe(docId(3));
		const entities = readRelated(tooSmall, access("wiki"), {
			documentId: docId(1),
			routes: ["entities"],
		});
		expect(entities.partialReasons).not.toContain("vector_unavailable");
	});

	test("a name of more mentions than a cluster holds weighs nothing (IDF 0), and the read says it was cut", async () => {
		// Document 2 names Lantern in 520 fragments: its cluster is cut at 500 mentions.
		const env = makeLinkEnv({}, { extractor: "names", maxFragmentBytes: 40 });
		putDoc(env, 1, "Lantern と Zircon の話。");
		putDoc(
			env,
			2,
			Array.from({ length: 520 }, (_, i) => `# 節${i}\n\nLantern。`).join(
				"\n\n",
			),
		);
		putDoc(env, 3, "Zircon の続き。");
		await scanAndDrain(env);
		const r = readRelated(deps(env), access("wiki"), { documentId: docId(1) });
		// Zircon (two fragments in scope) ranks; Lantern, cut, only relates document 2 after it.
		expect(r.results.map((x) => x.documentId)).toEqual([docId(3), docId(2)]);
		expect(r.partialReasons).toContain("response_truncated");
	});

	test("request.namespaces narrows both routes", async () => {
		const env = makeLinkEnv({}, { extractor: "names" });
		putDoc(env, 1, "Lantern と設計。");
		putDoc(env, 2, "Lantern の話。", "other");
		putDoc(env, 3, "設計の話。");
		await scanAndDrain(env);
		const narrowed = readRelated(deps(env, true), access("wiki", "other"), {
			documentId: docId(1),
			namespaces: ["wiki"],
		});
		expect(narrowed.results.map((x) => x.documentId)).toEqual([docId(3)]);
		const wide = readRelated(deps(env, true), access("wiki", "other"), {
			documentId: docId(1),
		});
		expect(wide.results.map((x) => x.documentId)).toContain(docId(2));
	});

	test("a document that is no longer available is found by neither route", async () => {
		const env = await names(DOCS);
		// A new version that cannot be read: the document becomes unavailable.
		env.source.put(makeDoc(3, "Lantern の話。設計。変わった。"));
		env.source.readErrors.set(docId(3), "not_found");
		await scanAndDrain(env);
		expect(
			rows(
				env.db,
				"SELECT state FROM knowledge_documents WHERE document_id = ?",
				docId(3),
			),
		).toEqual([{ state: "unavailable" }]);
		const r = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		expect(r.results.map((x) => x.documentId)).not.toContain(docId(3));
		expect(r.results.length).toBeGreaterThan(0);
	});

	test("a document outside the caller's namespaces is never found by either route", async () => {
		const env = makeLinkEnv({}, { extractor: "names" });
		putDoc(env, 1, "Lantern と設計。");
		putDoc(env, 2, "Lantern の話。", "other");
		await scanAndDrain(env);
		const r = readRelated(deps(env, true), access("wiki"), {
			documentId: docId(1),
		});
		expect(r.results).toEqual([]);
	});
});

describe("graph filters and the answer's size (kg2.md G5)", () => {
	test("minDocuments, types and minEdgeDocuments narrow the graph; omitted, the answer is as before", async () => {
		const env = await names({
			1: "Lantern と MySQL と設計。",
			2: "Lantern と MySQL の移行。",
			3: "設計の会議。",
		});
		const all = readGraph(deps(env), access("wiki"), {});
		const many = readGraph(deps(env), access("wiki"), { minDocuments: 2 });
		expect(many.nodes.every((n) => n.documentIds.length >= 2)).toBe(true);
		expect(many.nodes.length).toBeLessThan(all.nodes.length);
		const proper = readGraph(deps(env), access("wiki"), { types: ["固有名"] });
		expect(proper.nodes.map((n) => n.label).sort()).toEqual([
			"Lantern",
			"MySQL",
		]);
		const strong = readGraph(deps(env), access("wiki"), {
			minEdgeDocuments: 2,
		});
		expect(strong.edges.map((e) => e.documentIds.length)).toEqual([2]);
		const label = new Map(strong.nodes.map((n) => [n.nodeId, n.label]));
		expect(
			strong.edges.map((e) =>
				[label.get(e.source), label.get(e.target)].sort(),
			),
		).toEqual([["Lantern", "MySQL"]]);
	});

	test("an answer larger than responseChars keeps the first nodes and the edges between them", async () => {
		// 30 documents of 40 sentences, each with three names of their own: about 3,600 nodes.
		const docs: Record<number, string> = {};
		for (let n = 1; n <= 30; n++)
			docs[n] = Array.from(
				{ length: 40 },
				(_, s) => `N${n}x${s}a と N${n}x${s}b と N${n}x${s}c。`,
			).join("\n");
		const env = await names(docs);
		const g = readGraph(deps(env), access("wiki"), {
			maxNodes: GRAPH_LIMITS.maxNodes,
			maxEdges: GRAPH_LIMITS.maxEdges,
		});
		expect(JSON.stringify(g).length).toBeLessThanOrEqual(
			GRAPH_LIMITS.responseChars,
		);
		expect(g.partialReasons).toContain("nodes_truncated");
		const ids = new Set(g.nodes.map((n) => n.nodeId));
		expect(g.nodes.map((n) => n.nodeId)).toEqual(
			g.nodes.map((_, i) => `n${i + 1}`),
		);
		expect(g.edges.map((e) => e.edgeId)).toEqual(
			g.edges.map((_, i) => `e${i + 1}`),
		);
		expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(
			true,
		);
	});
});

describe("fitting the graph answer", () => {
	test("with thousands of documents read, the first nodes and their documents still fit", () => {
		const node = (i: number) => ({
			nodeId: `n${i + 1}`,
			label: `L${i}`,
			names: [`L${i}`],
			types: ["名詞"],
			mentionCount: 1,
			documentCount: 1,
			documentIds: [`d${i}`],
			evidence: [],
			decidedBy: [],
			summary: null,
		});
		const nodes = Array.from({ length: 1000 }, (_, i) => node(i));
		const edges = Array.from({ length: 999 }, (_, i) => ({
			edgeId: `e${i + 1}`,
			source: `n${i + 1}`,
			target: `n${i + 2}`,
			directed: false,
			relation: "同じ文",
			keywords: [],
			negated: false,
			certainty: "stated" as const,
			conditions: [],
			mentionCount: 1,
			documentCount: 1,
			documentIds: [`d${i}`],
			evidence: [],
		}));
		// 5,000 documents were read; each named one takes 300 characters in the answer.
		const room = 120_000;
		const fitted = fitGraphAnswer(nodes, edges, () => 300, room);
		expect(fitted.nodes.length).toBeGreaterThan(0);
		expect(fitted.nodes.length).toBeLessThan(nodes.length);
		const ids = new Set(fitted.nodes.map((n) => n.nodeId));
		expect(
			fitted.edges.every((e) => ids.has(e.source) && ids.has(e.target)),
		).toBe(true);
		const docs = new Set([
			...fitted.nodes.flatMap((n) => n.documentIds),
			...fitted.edges.flatMap((e) => e.documentIds),
		]);
		const size =
			JSON.stringify(fitted.nodes).length +
			JSON.stringify(fitted.edges).length +
			docs.size * 300;
		expect(size).toBeLessThanOrEqual(room);
		// Everything that fits is kept as it is.
		expect(
			fitGraphAnswer(nodes.slice(0, 3), edges.slice(0, 2), () => 300, room),
		).toEqual({
			nodes: nodes.slice(0, 3),
			edges: edges.slice(0, 2),
		});
	});
});

describe("the search index of model-free mentions (kg2.md G5)", () => {
	test("a mention is found by its name, never by the fixed type or relation words", async () => {
		const env = await names({ 1: "Lantern と MySQL を使う。" });
		const find = (kind: "entity" | "relation", q: string) =>
			searchMentionsInSnapshot(env.db, kind, q, 10, ["wiki"]).map(
				(h) => h.label,
			);
		expect(find("entity", "lantern")).toEqual(["Lantern"]);
		expect(find("entity", "名詞")).toEqual([]);
		expect(find("entity", "固有名")).toEqual([]);
		expect(find("relation", "同じ文")).toEqual([]);
		// The relation is still stored and read by the graph.
		expect(
			rows(env.db, "SELECT relation FROM knowledge_relation_mentions"),
		).toEqual([{ relation: "同じ文" }]);
	});
});
