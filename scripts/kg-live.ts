// `bun scripts/kg-live.ts`: the live run of kg.md (K4). Ingests the synthetic AI-memory corpus
// (examples/corpus/ai-memory) through the example host with the real LARM (inference and
// embedding), reads the knowledge graph through the API, checks every quotation it returns with
// the evidence API, and compares the graph with the corpus' expected.json.
//
// Not part of verify: it calls LARM. Documents are synthetic research notes, never personal ones.
// Prompts, raw model answers and credentials are never printed or written; the log carries counts,
// codes and timings only. graph.json is what the graph API returns: names, types, relation names
// and summaries the model wrote from the synthetic corpus, with quotation ranges.
//
// Environment: LARM_API_TOKEN, KG_LARM_BASE_URL, KG_LARM_PROFILE, KG_LARM_AUDIENCE
//   (KG_LARM_PROVIDER_HOSTS optional, comma separated).
// Options:
//   --out <dir>          output directory (default verification/kg-ai-memory/<UTC stamp>-<profile>)
//   --docs a,b           only these corpus files (basename without .md)
//   --max-minutes <n>    stop waiting after this long (default 240)
//   --reasoning default  leave the model's reasoning setting as served (default: off)
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createKnowledgeClient } from "../src/client/index.js";
import type {
	AccessContext,
	EvidenceResponse,
	GraphResponse,
	InferencePort,
	IngestDeps,
	StatusOptions,
} from "../src/contracts/index.js";
import {
	createIngestNextHandler,
	createLinkNextHandler,
	createSyncPageHandler,
	createVectorIndex,
	readEvidence,
	readGraph,
	readRelated,
	search,
} from "../src/core/index.js";
import {
	migrations,
	readScanInSnapshot,
	readStatusInSnapshot,
} from "../src/sqlite/index.js";
import { createExampleHost } from "../examples/host/index.js";
import { createLarm } from "../examples/larm/index.js";
import {
	createDoclingMock,
	type MockDocumentInput,
} from "../examples/mocks/docling.js";
import { createDoclingSource } from "../examples/mocks/docling-source.js";

const ROOT = resolve(import.meta.dir, "..");
const CORPUS = join(ROOT, "examples/corpus/ai-memory");
const NAMESPACE = "notes";
const TOKEN = "kg-live-token-0123456789abcdefghij";
const DOCLING_CREDENTIAL = "docling-mock-credential-0123456789abcdef";
const DAY_MS = 24 * 60 * 60 * 1000;
const INFERENCE_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 30_000;

type Options = {
	out: string | null;
	docs: string[] | null;
	maxMinutes: number;
	reasoning: "off" | "default";
};

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		out: null,
		docs: null,
		maxMinutes: 240,
		reasoning: "off",
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`missing value for ${flag}`);
		if (flag === "--out") options.out = resolve(value);
		else if (flag === "--docs") options.docs = value.split(",").filter(Boolean);
		else if (flag === "--max-minutes") options.maxMinutes = Number(value);
		else if (flag === "--reasoning" && (value === "off" || value === "default"))
			options.reasoning = value;
		else throw new Error(`unknown option ${flag}`);
		i++;
	}
	if (!Number.isFinite(options.maxMinutes) || options.maxMinutes <= 0)
		throw new Error("invalid --max-minutes");
	return options;
}

function env(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clockText = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${clockText()}] ${line}`);
const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/**
 * Whether the normalized text names the alias: an ASCII word character next to the match ends it
 * (`mem0` is not found inside `mem0g`); other scripts have no word boundary to check.
 */
function mentions(normalizedText: string, alias: string): boolean {
	const a = norm(alias);
	const word = /[a-z0-9_]/;
	for (
		let i = normalizedText.indexOf(a);
		i >= 0;
		i = normalizedText.indexOf(a, i + 1)
	) {
		const before = normalizedText[i - 1] ?? "";
		const after = normalizedText[i + a.length] ?? "";
		const edgeOk = (c: string, inner: string | undefined) =>
			!(inner && word.test(inner) && word.test(c));
		if (edgeOk(before, a[0]) && edgeOk(after, a[a.length - 1])) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Corpus and expected graph
// ---------------------------------------------------------------------------

type CorpusDocument = { file: string; path: string; markdown: string };

async function loadCorpus(only: string[] | null): Promise<CorpusDocument[]> {
	const files = (await readdir(CORPUS)).filter((f) => f.endsWith(".md")).sort();
	const picked = only
		? files.filter((f) => only.includes(f.replace(/\.md$/, "")))
		: files;
	if (picked.length === 0) throw new Error("no corpus document selected");
	return Promise.all(
		picked.map(async (file) => ({
			file,
			path: `ai-memory/${file}`,
			markdown: await readFile(join(CORPUS, file), "utf8"),
		})),
	);
}

type Expected = {
	entities: { id: string; aliases: string[] }[];
	relations: { a: string[]; b: string[]; about: string }[];
	distinct: [string, string][];
};

// ---------------------------------------------------------------------------
// Inference with per-call accounting (no prompt or answer is kept)
// ---------------------------------------------------------------------------

type PurposeStats = {
	calls: number;
	ok: number;
	errors: Record<string, number>;
	ms: number;
	inputTokens: number;
	outputTokens: number;
};

function accounted(port: InferencePort) {
	const byPurpose = new Map<string, PurposeStats>();
	const wrapped: InferencePort = {
		async complete(request, signal) {
			const s = byPurpose.get(request.purpose) ?? {
				calls: 0,
				ok: 0,
				errors: {},
				ms: 0,
				inputTokens: 0,
				outputTokens: 0,
			};
			byPurpose.set(request.purpose, s);
			s.calls++;
			const started = Date.now();
			try {
				const result = await port.complete(request, signal);
				const ms = Date.now() - started;
				s.ms += ms;
				s.inputTokens += result.usage.inputTokens ?? 0;
				s.outputTokens += result.usage.outputTokens ?? 0;
				if (result.ok) s.ok++;
				else s.errors[result.error] = (s.errors[result.error] ?? 0) + 1;
				log(
					`${request.purpose} #${s.calls} ${result.ok ? "ok" : result.error} ${(ms / 1000).toFixed(1)}s in=${result.usage.inputTokens ?? "-"} out=${result.usage.outputTokens ?? "-"}`,
				);
				return result;
			} catch (error) {
				s.ms += Date.now() - started;
				s.errors.thrown = (s.errors.thrown ?? 0) + 1;
				log(`${request.purpose} #${s.calls} thrown`);
				throw error;
			}
		},
	};
	return { port: wrapped, stats: () => Object.fromEntries(byPurpose) };
}

// ---------------------------------------------------------------------------
// Evaluation against expected.json
// ---------------------------------------------------------------------------

type Node = GraphResponse["nodes"][number];

function evaluate(
	graph: GraphResponse,
	expected: Expected,
	corpus: readonly CorpusDocument[],
	docIdByPath: ReadonlyMap<string, string>,
) {
	const aliasSets = new Map(
		expected.entities.map((e) => [e.id, new Set(e.aliases.map(norm))]),
	);
	const nodesOf = (id: string): Node[] =>
		graph.nodes.filter((n) =>
			n.names.some((name) => aliasSets.get(id)?.has(norm(name))),
		);
	// A corpus document the store does not know (never listed) still counts: no node covers it.
	const idOf = (path: string) => docIdByPath.get(path) ?? `missing:${path}`;
	const normalizedText = new Map(corpus.map((d) => [d.path, norm(d.markdown)]));
	const entities = expected.entities.map((e) => {
		const expectedDocs = corpus
			.filter((d) =>
				e.aliases.some((a) => mentions(normalizedText.get(d.path) ?? "", a)),
			)
			.map((d) => idOf(d.path));
		const nodes = nodesOf(e.id);
		const covered = (docs: readonly string[]) =>
			expectedDocs.filter((d) => docs.includes(d)).length;
		const best = nodes.reduce((m, n) => Math.max(m, covered(n.documentIds)), 0);
		const union = covered([...new Set(nodes.flatMap((n) => n.documentIds))]);
		return {
			id: e.id,
			expectedDocuments: expectedDocs.length,
			found: nodes.length > 0,
			nodes: nodes.length,
			bestNodeCoverage: expectedDocs.length ? best / expectedDocs.length : null,
			unionCoverage: expectedDocs.length ? union / expectedDocs.length : null,
			labels: nodes.map((n) => n.label),
		};
	});
	const present = entities.filter((e) => e.expectedDocuments > 0);
	const crossDoc = present.filter((e) => e.expectedDocuments >= 2);
	const relations = expected.relations.map((r) => {
		const a = new Set(r.a.flatMap((id) => nodesOf(id).map((n) => n.nodeId)));
		const b = new Set(r.b.flatMap((id) => nodesOf(id).map((n) => n.nodeId)));
		const edges = graph.edges.filter(
			(e) =>
				(a.has(e.source) && b.has(e.target)) ||
				(a.has(e.target) && b.has(e.source)),
		);
		return {
			about: r.about,
			endpointsFound: a.size > 0 && b.size > 0,
			hit: edges.length > 0,
			relations: [...new Set(edges.map((e) => e.relation))],
		};
	});
	const distinct = expected.distinct.map(([x, y]) => {
		const xs = new Set(nodesOf(x).map((n) => n.nodeId));
		const merged = nodesOf(y).filter((n) => xs.has(n.nodeId));
		return { pair: [x, y], merged: merged.map((n) => n.label) };
	});
	const ratio = (n: number, d: number) => (d ? n / d : null);
	return {
		summary: {
			entitiesInCorpus: present.length,
			entityRecall: ratio(
				present.filter((e) => e.found).length,
				present.length,
			),
			crossDocumentEntities: crossDoc.length,
			mergedIntoOneNode: crossDoc.filter((e) => e.bestNodeCoverage === 1)
				.length,
			meanBestNodeCoverage: ratio(
				crossDoc.reduce((s, e) => s + (e.bestNodeCoverage ?? 0), 0),
				crossDoc.length,
			),
			meanNodesPerFoundEntity: ratio(
				present.filter((e) => e.found).reduce((s, e) => s + e.nodes, 0),
				present.filter((e) => e.found).length,
			),
			relationRecall: ratio(
				relations.filter((r) => r.hit).length,
				relations.length,
			),
			relationEndpointsFound: relations.filter((r) => r.endpointsFound).length,
			distinctViolations: distinct.filter((d) => d.merged.length > 0).length,
		},
		entities,
		relations,
		distinct,
	};
}

function graphStats(graph: GraphResponse) {
	const multiDoc = graph.nodes.filter((n) => n.documentIds.length >= 2);
	return {
		nodes: graph.nodes.length,
		edges: graph.edges.length,
		singletonNodes: graph.nodes.filter((n) => n.mentionCount === 1).length,
		multiDocumentNodes: multiDoc.length,
		nodesWithSummary: graph.nodes.filter((n) => n.summary !== null).length,
		multiMentionEdges: graph.edges.filter((e) => e.mentionCount >= 2).length,
		crossDocumentEdges: graph.edges.filter((e) => e.documentIds.length >= 2)
			.length,
		topNodes: graph.nodes.slice(0, 25).map((n) => ({
			label: n.label,
			mentions: n.mentionCount,
			documents: n.documentIds.length,
			types: n.types.slice(0, 3),
		})),
	};
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const profile = env("KG_LARM_PROFILE");
	const larm = createLarm({
		baseUrl: env("KG_LARM_BASE_URL"),
		token: env("LARM_API_TOKEN"),
		profile,
		audience: env("KG_LARM_AUDIENCE"),
		...(process.env.KG_LARM_PROVIDER_HOSTS
			? {
					providerHosts: process.env.KG_LARM_PROVIDER_HOSTS.split(",")
						.map((h) => h.trim())
						.filter(Boolean),
				}
			: {}),
		reasoning: options.reasoning,
		// The served context window allows it ("remaining-context"); 4096 cut an extraction short.
		maxOutputTokens: 16_384,
	});
	const binding = await larm.describe(AbortSignal.timeout(30_000));
	log(
		`LARM profile=${binding.profile} llm=${binding.llm.model} embedding=${binding.embedding?.model ?? "none"}`,
	);
	if (!binding.embedding)
		throw new Error("the profile has no embedding provider");

	const corpus = await loadCorpus(options.docs);
	const expected = JSON.parse(
		await readFile(join(CORPUS, "expected.json"), "utf8"),
	) as Expected;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
	const out =
		options.out ??
		join(ROOT, "verification/kg-ai-memory", `${stamp}-${profile}`);
	await mkdir(out, { recursive: true });

	const docling = createDoclingMock({
		documents: corpus.map((d): MockDocumentInput => ({
			namespace: NAMESPACE,
			path: d.path,
			title: d.markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? d.file,
			markdown: d.markdown,
		})),
		namespaces: [NAMESPACE],
		pageSize: 100,
		credential: DOCLING_CREDENTIAL,
	});
	const source = createDoclingSource({
		fetch: (input, init) => docling.app.request(input, init),
		baseUrl: "http://docling.mock",
		credential: DOCLING_CREDENTIAL,
	});
	const clock = { now: () => Date.now() };
	const inference = accounted(larm.inference);
	const principals: Record<string, AccessContext> = {
		[TOKEN]: { principal: "kg-live", namespaces: [NAMESPACE] },
	};
	const statusOptions: StatusOptions = {
		verifiedWithinMs: DAY_MS,
		maxUnappliedAttempts: 3,
		get binding() {
			return source.binding();
		},
	};
	const ingestOptions = {
		inferenceTimeoutMs: INFERENCE_TIMEOUT_MS,
		transientRetryDelayMs: RETRY_DELAY_MS,
	};
	const linkOptions = {
		inferenceTimeoutMs: INFERENCE_TIMEOUT_MS,
		transientRetryDelayMs: RETRY_DELAY_MS,
	};
	const host = createExampleHost({
		keep: true,
		source,
		principals,
		clock,
		inference: inference.port,
		embedding: larm.embedding,
		handlerFactories: [
			(deps: IngestDeps) => createSyncPageHandler(deps, {}),
			(deps: IngestDeps) => createIngestNextHandler(deps, ingestOptions),
			(deps: IngestDeps) => createLinkNextHandler(deps, linkOptions),
		],
		readStatusInSnapshot,
		readScanInSnapshot,
		packageMigrations: migrations,
		statusOptions,
		search,
		readEvidence,
		readRelated,
		readGraph,
		createVectorIndex,
		searchOptions: { verifiedWithinMs: DAY_MS, maxUnappliedAttempts: 3 },
		retryDelayMs: RETRY_DELAY_MS,
		maxAttempts: 3,
	});
	await host.ready;
	log(`host database directory: ${host.dir}`);
	const client = createKnowledgeClient({
		baseUrl: "http://example.host",
		token: TOKEN,
		fetch: async (input, init) => host.app.request(input, init),
	});

	const started = Date.now();
	const stopAt = started + options.maxMinutes * 60_000;
	let finished = false;
	try {
		await client.requestSync(randomUUID());
		for (;;) {
			// One step at a time so --max-minutes is checked after every job.
			const run = await host.runner.runUntilIdle({ maxSteps: 1 });
			const open = host.runner
				.listJobs()
				.filter((j) => j.state === "queued" || j.state === "running");
			const byKind = new Map<string, number>();
			for (const j of open) byKind.set(j.kind, (byKind.get(j.kind) ?? 0) + 1);
			log(
				`jobs open: ${[...byKind].map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
			);
			if (run.idle && open.length === 0) {
				finished = true;
				break;
			}
			if (Date.now() > stopAt) break;
			if (run.idle) {
				const next = Math.min(...open.map((j) => j.availableAtMs));
				await sleep(Math.min(Math.max(next - Date.now(), 500), 60_000));
			}
		}
		const elapsedMs = Date.now() - started;
		log(
			`run ${finished ? "finished" : "stopped"} after ${(elapsedMs / 60_000).toFixed(1)} min`,
		);

		const status = await client.status();
		const graph = await client.graph({
			maxNodes: 1000,
			maxEdges: 2000,
		});
		// Every quotation the graph returns, checked with the evidence API.
		const evidence: Record<EvidenceResponse["status"], number> = {
			valid: 0,
			stale: 0,
			unavailable: 0,
			mismatch: 0,
			not_available: 0,
		};
		for (const point of [
			...graph.nodes.flatMap((n) => n.evidence),
			...graph.edges.flatMap((e) => e.evidence),
		]) {
			const answer = await client.evidence({
				documentId: point.documentId,
				markdownSha256: point.markdownSha256,
				byteStart: point.byteStart,
				byteEnd: point.byteEnd,
				quoteSha256: point.quoteSha256,
			});
			evidence[answer.status]++;
		}
		const store = host.store.read((db) => {
			const one = (sql: string) =>
				(db.query(sql).get() as { n: number } | null)?.n ?? 0;
			return {
				fragments: one("SELECT count(*) AS n FROM knowledge_fragments"),
				extractionsOk: one(
					"SELECT count(*) AS n FROM knowledge_extractions WHERE status = 'ok'",
				),
				extractionsFailed: one(
					"SELECT count(*) AS n FROM knowledge_extractions WHERE status = 'failed'",
				),
				droppedItems: one(
					"SELECT coalesce(sum(dropped_count), 0) AS n FROM knowledge_extractions",
				),
				entityMentions: one(
					"SELECT count(*) AS n FROM knowledge_entity_mentions",
				),
				relationMentions: one(
					"SELECT count(*) AS n FROM knowledge_relation_mentions",
				),
				linksSame: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'same'",
				),
				linksDifferent: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'different'",
				),
				linksUnsure: one(
					"SELECT count(*) AS n FROM knowledge_entity_links WHERE decision = 'unsure'",
				),
				summariesOk: one(
					"SELECT count(*) AS n FROM knowledge_entity_summaries WHERE status = 'ok'",
				),
			};
		});
		// Documents from the store, not from the graph: a document without nodes still counts.
		const documents = host.store.read(
			(db) =>
				db
					.query(
						"SELECT document_id, path, state FROM knowledge_documents ORDER BY path",
					)
					.all() as { document_id: string; path: string; state: string }[],
		);
		const docIdByPath = new Map(documents.map((d) => [d.path, d.document_id]));
		const evaluation = evaluate(graph, expected, corpus, docIdByPath);
		const jobs = host.runner.listJobs();
		const jobStates: Record<string, number> = {};
		for (const j of jobs)
			jobStates[`${j.kind}:${j.state}`] =
				(jobStates[`${j.kind}:${j.state}`] ?? 0) + 1;
		const report = {
			kind: "kg-live",
			note: "Synthetic research notes ingested with a real model through LARM. A single run: not a benchmark.",
			startedAt: new Date(started).toISOString(),
			elapsedMinutes: Number((elapsedMs / 60_000).toFixed(1)),
			finished,
			jobs: jobStates,
			documents: documents.map((d) => ({
				documentId: d.document_id,
				path: d.path,
				state: d.state,
			})),
			larm: {
				profile: binding.profile,
				catalogRevision: binding.catalogRevision,
				llm: binding.llm,
				embedding: binding.embedding,
				reasoning: options.reasoning,
			},
			corpus: corpus.map((d) => ({
				path: d.path,
				bytes: Buffer.byteLength(d.markdown, "utf8"),
			})),
			inference: inference.stats(),
			larmStats: larm.stats(),
			store,
			status: {
				complete: status.complete,
				partialReasons: status.partialReasons,
			},
			graph: {
				complete: graph.complete,
				partialReasons: graph.partialReasons,
				...graphStats(graph),
			},
			evidence,
			evaluation,
		};
		// "wx": an earlier run's files are never overwritten.
		await writeFile(
			join(out, "graph.json"),
			`${JSON.stringify(graph, null, "\t")}\n`,
			{ flag: "wx" },
		);
		await writeFile(
			join(out, "report.json"),
			`${JSON.stringify(report, null, "\t")}\n`,
			{ flag: "wx" },
		);
		log(`wrote ${join(out, "graph.json")} and report.json`);
		log(`evaluation: ${JSON.stringify(evaluation.summary)}`);
		log(`evidence: ${JSON.stringify(evidence)}`);
	} finally {
		await host.close();
	}
}

await main();
