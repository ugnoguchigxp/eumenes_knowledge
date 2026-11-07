import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type {
	EmbeddingPort,
	EmbeddingSpace,
	FragmentExtraction,
	SearchDeps,
} from "../../contracts/index.js";
import {
	createStagingVersionInTransaction,
	migrations,
	observeDocumentInTransaction,
	publishVersionInTransaction,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageVectorsInTransaction,
} from "../../sqlite/index.js";
import { createVectorIndex, search, vectorIndexStats } from "./index.js";

/**
 * A measurement, not a gate for the machine it runs on: 50,000 fragments of 1024 dimensions (the
 * p0.md 6.2 bound) in the resident index, p95 of the search without the query embedding. The
 * target is 150 ms on a development machine; the assertion is loose (1 s) so that a slow CI does
 * not fail. `KNOWLEDGE_PERF_FRAGMENTS` lowers the size for a quick run.
 */
const FRAGMENTS = Number(process.env.KNOWLEDGE_PERF_FRAGMENTS ?? 50_000);
const DIMENSION = 1024;
const PER_DOC = 1000;
const LOOSE_P95_MS = 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SPACE: EmbeddingSpace = {
	modelId: "perf",
	revision: "1",
	artifactDigest: "a".repeat(64),
	dimension: DIMENSION,
	queryPrefix: "",
	passagePrefix: "",
};

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function unitVector(rand: () => number): Float32Array {
	const v = new Float32Array(DIMENSION);
	let norm = 0;
	for (let i = 0; i < DIMENSION; i++) {
		v[i] = rand() * 2 - 1;
		norm += v[i]! * v[i]!;
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < DIMENSION; i++) v[i] = v[i]! / norm;
	return v;
}

function build(): Database {
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	const rand = lcg(7);
	const docs = Math.ceil(FRAGMENTS / PER_DOC);
	for (let d = 1; d <= docs; d++) {
		const count = Math.min(PER_DOC, FRAGMENTS - (d - 1) * PER_DOC);
		const texts = Array.from(
			{ length: count },
			(_, i) =>
				`document ${d} fragment ${i} synthetic text ${(d * 7919 + i * 104729) % 10007}\n`,
		);
		const body = texts.join("");
		db.transaction(() => {
			const documentId = `wiki-${d.toString(16).padStart(32, "0")}`;
			const obs = observeDocumentInTransaction(
				db,
				{
					sourceNamespace: "docling",
					documentId,
					namespace: "wiki",
					path: `p/${d}.md`,
					title: `Doc ${d}`,
					etag: `"${sha(`e${d}`)}"`,
					markdownSha256: sha(body),
					contentDigest: sha(`c${d}`),
				},
				["wiki"],
				1000,
			);
			const expectation = {
				sourceNamespace: "docling",
				documentId,
				markdownSha256: sha(body),
				generation: obs.generation,
				retry: obs.retry,
				namespace: "wiki",
			};
			const versionId = createStagingVersionInTransaction(
				db,
				{
					...expectation,
					byteLength: Buffer.byteLength(body),
					expectedFragments: count,
					instructionDigest: "i".repeat(64),
				},
				1000,
			);
			let start = 0;
			stageFragmentsInTransaction(
				db,
				versionId,
				texts.map((text, ordinal) => {
					const len = Buffer.byteLength(text);
					const fragment = {
						ordinal,
						byteStart: start,
						byteEnd: start + len,
						headingPath: [],
						text,
					};
					start += len;
					return { fragment, searchText: text };
				}),
			);
			stageVectorsInTransaction(
				db,
				versionId,
				SPACE,
				texts.map((_, ordinal) => ({ ordinal, vector: unitVector(rand) })),
			);
			stageExtractionsInTransaction(
				db,
				versionId,
				texts.map((_, ordinal): FragmentExtraction => ({
					fragmentOrdinal: ordinal,
					status: "ok",
					entities: [],
					relations: [],
					dropped: [],
					model: null,
				})),
			);
			if (!publishVersionInTransaction(db, versionId, expectation, 1001)) {
				throw new Error("publish failed");
			}
		})();
	}
	return db;
}

const percentile = (sorted: number[], p: number) =>
	sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;

test(`vector route over ${FRAGMENTS} resident fragments x ${DIMENSION} dimensions`, async () => {
	const buildStart = performance.now();
	const db = build();
	const buildMs = performance.now() - buildStart;
	const rand = lcg(99);
	const embedding: EmbeddingPort = {
		embed: async (texts) => ({
			vectors: texts.map(() => Array.from(unitVector(rand))),
			space: SPACE,
		}),
	};
	const vectors = createVectorIndex();
	const deps: SearchDeps = {
		read: (operation) => db.transaction(() => operation(db))(),
		embedding,
		vectors,
		clock: { now: () => 2000 },
		options: { verifiedWithinMs: 10 * 3_600_000 },
	};
	const access = { principal: "p", namespaces: ["wiki"] };
	const signal = new AbortController().signal;

	const coldStart = performance.now();
	const cold = await search(
		deps,
		access,
		{ query: "synthetic", routes: ["vector"] },
		signal,
	);
	const coldMs = performance.now() - coldStart;
	expect(cold.routes[0]).toMatchObject({ status: "ok", candidates: 200 });
	expect(vectorIndexStats(vectors).spaces[0]!.fragments).toBe(FRAGMENTS);

	const measure = async (
		routes: ("text" | "vector" | "entity" | "relation")[],
		query: string,
	) => {
		const times: number[] = [];
		for (let i = 0; i < 30; i++) {
			// the embedding is a stub, so the time is the search alone
			const t = performance.now();
			const r = await search(
				deps,
				access,
				{ query, routes, limit: 10 },
				signal,
			);
			times.push(performance.now() - t);
			expect(r.results.length).toBeGreaterThan(0);
		}
		times.sort((a, b) => a - b);
		return { p50: percentile(times, 0.5), p95: percentile(times, 0.95) };
	};
	const vector = await measure(["vector"], "synthetic");
	const all = await measure(
		["text", "vector", "entity", "relation"],
		"fragment 7 synthetic",
	);
	console.log(
		JSON.stringify({
			fragments: FRAGMENTS,
			dimension: DIMENSION,
			buildMs: Math.round(buildMs),
			coldFirstSearchMs: Math.round(coldMs),
			vectorRoute: {
				p50Ms: +vector.p50.toFixed(1),
				p95Ms: +vector.p95.toFixed(1),
			},
			allRoutes: { p50Ms: +all.p50.toFixed(1), p95Ms: +all.p95.toFixed(1) },
			targetP95Ms: 150,
		}),
	);
	expect(vector.p95).toBeLessThan(LOOSE_P95_MS);
	// the resident set was not read again by the warm searches
	expect(vectorIndexStats(vectors).versionLoads).toBe(
		Math.ceil(FRAGMENTS / PER_DOC),
	);
}, 300_000);
