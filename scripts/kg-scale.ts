// `bun scripts/kg-scale.ts build --notes <dir> --db <file> [--copies <n>]`
// `bun scripts/kg-scale.ts time --db <file> [--runs <n>]`
//
// The scale check of kg2.md §7.12 (B): a store of the size Eumenes may reach, made from Markdown
// notes copied `--copies` times into one namespace (every name is then shared by the copies, as
// a large corpus shares its frequent names), extracted by the model-free extractor (charclass)
// with deterministic vectors, without a model or an embedding service. `time` reads it through
// the package's operations (status, graph, related, search) and prints their times.
//
// The notes and the database must lie outside the repository (they may be personal); only the
// printed numbers are meant to be recorded.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type {
	AccessContext,
	EmbeddingSpace,
	FragmentExtraction,
	Tx,
} from "../src/contracts/index.js";
import {
	createCharclassTokenizer,
	extractNames,
	fragmentStructures,
	namesModel,
} from "../src/core/extract/index.js";
import { readGraph } from "../src/core/link/graph.js";
import { readRelated } from "../src/core/link/related.js";
import { createVectorIndex, search } from "../src/core/search/index.js";
import {
	chunkMarkdown,
	linkName,
	markdownLinks,
	normalizeForSearch,
} from "../src/core/text/index.js";
import {
	createStagingVersionInTransaction,
	migrations,
	observeDocumentInTransaction,
	publishVersionInTransaction,
	readStatusInSnapshot,
	stageExtractionsInTransaction,
	stageFragmentsInTransaction,
	stageLinksInTransaction,
	stageVectorsInTransaction,
} from "../src/sqlite/index.js";
import { insideRepository, listNotes } from "./kg-heldout.js";

const DIMENSION = 384;
const SPACE: EmbeddingSpace = {
	modelId: "scale",
	revision: "1",
	artifactDigest: "a".repeat(64),
	dimension: DIMENSION,
	queryPrefix: "",
	passagePrefix: "",
};
const NAMESPACE = "wiki";
const ACCESS: AccessContext = { principal: "scale", namespaces: [NAMESPACE] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Apply the migrations the file has not had (PRAGMA user_version counts them). */
export function openStore(path: string): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL");
	const done = (
		db.query("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	for (let i = done; i < migrations.length; i++) {
		db.exec(migrations[i] as string);
		db.exec(`PRAGMA user_version = ${i + 1}`);
	}
	return db;
}

/** A deterministic unit vector of a text (no model: the scale check times reads, not relevance). */
function vectorOf(text: string): Float32Array {
	const v = new Float32Array(DIMENSION);
	let seed = Number.parseInt(sha(text).slice(0, 8), 16) >>> 0;
	let norm = 0;
	for (let i = 0; i < DIMENSION; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		v[i] = seed / 0x100000000 - 0.5;
		norm += (v[i] as number) ** 2;
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < DIMENSION; i++) v[i] = (v[i] as number) / norm;
	return v;
}

export function build(
	notes: string,
	path: string,
	copies: number,
): Record<string, number> {
	if (insideRepository(notes) || insideRepository(path))
		throw new Error("--notes and --db must lie outside the repository");
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const texts: string[] = [];
	/** The notes' paths under --notes: links between them resolve within each copy. */
	const paths: string[] = [];
	for (const f of listNotes(notes)) {
		try {
			texts.push(decoder.decode(readFileSync(f)));
			paths.push(relative(notes, f));
		} catch {
			// Not UTF-8: left out, as the package refuses it.
		}
	}
	const db = openStore(path);
	const tokenizer = createCharclassTokenizer();
	const model = namesModel(tokenizer);
	let documents = 0;
	let fragmentsTotal = 0;
	const t0 = performance.now();
	for (let c = 0; c < copies; c++) {
		texts.forEach((text, n) => {
			const bytes = Buffer.from(text, "utf8");
			const fragments = chunkMarkdown(bytes, text);
			if (fragments.length === 0) return;
			const structures = fragmentStructures(fragments.map((f) => f.text));
			const extractions: FragmentExtraction[] = fragments.map((f, i) =>
				extractNames(f, tokenizer, structures[i]),
			);
			const d = c * texts.length + n + 1;
			const documentId = `wiki-${d.toString(16).padStart(32, "0")}`;
			const markdownSha256 = sha(text);
			db.transaction(() => {
				const obs = observeDocumentInTransaction(
					db,
					{
						sourceNamespace: "docling",
						documentId,
						namespace: NAMESPACE,
						path: `copy${c}/${paths[n]}`,
						title: `Copy ${c} note ${n}`,
						etag: `"${sha(`e${d}`)}"`,
						markdownSha256,
						contentDigest: sha(`c${d}`),
					},
					[NAMESPACE],
					1000,
				);
				const expectation = {
					sourceNamespace: "docling",
					documentId,
					markdownSha256,
					generation: obs.generation,
					retry: obs.retry,
					namespace: NAMESPACE,
				};
				const versionId = createStagingVersionInTransaction(
					db,
					{
						...expectation,
						byteLength: bytes.length,
						expectedFragments: fragments.length,
						instructionDigest: "i".repeat(64),
						extractor: model,
					},
					1000,
				);
				stageFragmentsInTransaction(
					db,
					versionId,
					fragments.map((fragment) => ({
						fragment,
						searchText: normalizeForSearch(fragment.text),
					})),
				);
				stageLinksInTransaction(
					db,
					versionId,
					fragments.flatMap((f, i) =>
						markdownLinks(f.text, structures[i]?.code ?? []).map((href) => ({
							fragmentOrdinal: f.ordinal,
							href,
							targetName: linkName(href),
						})),
					),
				);
				stageVectorsInTransaction(
					db,
					versionId,
					SPACE,
					fragments.map((f) => ({
						ordinal: f.ordinal,
						vector: vectorOf(f.text),
					})),
				);
				stageExtractionsInTransaction(db, versionId, extractions);
				if (!publishVersionInTransaction(db, versionId, expectation, 1000))
					throw new Error(`not published: ${documentId}`);
			})();
			documents += 1;
			fragmentsTotal += fragments.length;
		});
	}
	const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
	const stats = {
		documents,
		fragments: fragmentsTotal,
		entityMentions: count(
			"SELECT COUNT(*) AS n FROM knowledge_entity_mentions",
		),
		relationMentions: count(
			"SELECT COUNT(*) AS n FROM knowledge_relation_mentions",
		),
		links: count("SELECT COUNT(*) AS n FROM knowledge_document_links"),
		buildSeconds: Math.round((performance.now() - t0) / 1000),
	};
	db.close();
	return stats;
}

function timed<T>(f: () => T): { ms: number; value: T } {
	const t0 = performance.now();
	const value = f();
	return { ms: Math.round(performance.now() - t0), value };
}

export async function time(
	path: string,
	runs: number,
): Promise<Record<string, unknown>> {
	if (insideRepository(path))
		throw new Error("--db must lie outside the repository");
	const db = openStore(path);
	const clock = { now: () => 2000 };
	const read = <T>(op: (tx: Tx) => T): T => db.transaction(() => op(db))();
	const options = { verifiedWithinMs: 10 ** 12 };
	const vectors = createVectorIndex();
	const out: Record<string, unknown> = {};
	const best = <T>(name: string, f: () => T, summary: (v: T) => unknown) => {
		let min = Number.POSITIVE_INFINITY;
		let last: T | undefined;
		for (let i = 0; i < runs; i++) {
			const r = timed(f);
			min = Math.min(min, r.ms);
			last = r.value;
		}
		out[name] = { ms: min, ...(summary(last as T) as object) };
	};
	best(
		"status",
		() => read((tx) => readStatusInSnapshot(tx, ACCESS, 2000, options)),
		(s) => ({ reasons: s.partialReasons }),
	);
	const graphSummary = (g: Awaited<ReturnType<typeof readGraph>>) => ({
		nodes: g.nodes.length,
		edges: g.edges.length,
		topNodes: g.nodes.slice(0, 3).map((n) => n.mentionCount),
		reasons: g.partialReasons,
	});
	best(
		"graphDefault",
		() => readGraph({ read, clock, options }, ACCESS, {}),
		graphSummary,
	);
	best(
		"graphProperTwoDocs",
		() =>
			readGraph({ read, clock, options }, ACCESS, {
				types: ["固有名"],
				minDocuments: 2,
			}),
		graphSummary,
	);
	const ids = (
		db
			.query(
				"SELECT document_id FROM knowledge_documents WHERE state = 'current' ORDER BY document_id LIMIT 3",
			)
			.all() as { document_id: string }[]
	).map((r) => r.document_id);
	// The document of the most links (an index, kg2.md §7.14), when any.
	const index = db
		.query(
			`SELECT d.document_id FROM knowledge_document_links l
JOIN knowledge_documents d ON d.published_version_id = l.version_id AND d.state = 'current'
GROUP BY l.version_id ORDER BY COUNT(*) DESC, d.document_id LIMIT 1`,
		)
		.get() as { document_id: string } | null;
	if (index) ids.push(index.document_id);
	for (const [i, documentId] of ids.entries()) {
		best(
			`related${i + 1}`,
			() =>
				readRelated({ read, clock, options, vectors }, ACCESS, {
					documentId,
				}),
			(r) => ({
				results: r.results.length,
				linked: r.results.filter((x) => x.links.length > 0).length,
				reasons: r.partialReasons,
			}),
		);
	}
	const embedding = {
		space: SPACE,
		embed: async (texts: readonly string[]) => ({
			ok: true as const,
			vectors: texts.map(vectorOf),
		}),
	};
	for (const query of ["Lantern", "設計", "SQLite の索引"]) {
		const t0 = performance.now();
		let min = Number.POSITIVE_INFINITY;
		let last: Awaited<ReturnType<typeof search>> | undefined;
		for (let i = 0; i < runs; i++) {
			const s = performance.now();
			last = await search(
				{ read, clock, options, vectors, embedding } as never,
				ACCESS,
				{ query },
				new AbortController().signal,
			);
			min = Math.min(min, performance.now() - s);
		}
		void t0;
		out[`search:${query}`] = {
			ms: Math.round(min),
			results: last?.results.length,
			reasons: last?.partialReasons,
		};
	}
	db.close();
	return out;
}

function option(args: string[], name: string): string | null {
	const i = args.indexOf(name);
	if (i < 0) return null;
	const v = args[i + 1];
	if (v === undefined || v.startsWith("--"))
		throw new Error(`${name} needs a value`);
	return v;
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	const db = option(rest, "--db");
	if (!db) throw new Error("--db <file> is required (outside the repository)");
	if (command === "build") {
		const notes = option(rest, "--notes");
		if (!notes) throw new Error("--notes <dir> is required");
		console.log(
			JSON.stringify(build(notes, db, Number(option(rest, "--copies") ?? 1))),
		);
	} else if (command === "time") {
		console.log(
			JSON.stringify(
				await time(db, Number(option(rest, "--runs") ?? 3)),
				null,
				1,
			),
		);
	} else {
		throw new Error("usage: kg-scale.ts build|time ...");
	}
}
