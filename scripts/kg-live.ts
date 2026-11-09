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
//   --candidate-match text  identity candidates also by type and description (default: name)
//   --relink <file>      start from the knowledge.db of an earlier run: its extraction is kept,
//                        its identity links and summaries are dropped and made again (kg.md §7)
//   --corpus <name>      the corpus under examples/corpus (default ai-memory); its expected.json
//   --extract none       no model extraction (kg2.md G6): the inference port answers every
//                        extraction with no entity and no relation, so the run only splits and
//                        embeds (LARM's embedding is still used); kg-alt.ts reads the result
//   --extract names      the package's model-free extractor (kg2.md G3: names and same-sentence
//                        relations from a tokenizer and rules); no model is asked: mentions of one
//                        namespace with the same identity key are one node when read (G4), and
//                        the identity chain compares none of them with the model
//   --tokenizer <engine> with --extract names: charclass (default, no dictionary), sudachi-napi,
//                        kuromoji or lindera (scripts/kg-alt/candidates.ts; all but charclass need
//                        --js-modules <dir>, sudachi-napi also NAPI_SUDACHI_ROOT and SUDACHI_DICT_PATH)
//
// Every run leaves a copy of its database as knowledge.db in the output directory (not committed:
// .gitignore), which a later run can relink.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createKnowledgeClient } from "../src/client/index.js";
import type {
	AccessContext,
	InferencePort,
	IngestDeps,
	StatusOptions,
} from "../src/contracts/index.js";
import { instruction } from "../src/contexts/index.js";
import {
	createIngestNextHandler,
	createLinkNextHandler,
	namesModel,
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
import { type Engine, loadTokenizer } from "./kg-alt/candidates.js";
import {
	createDoclingMock,
	type MockDocumentInput,
} from "../examples/mocks/docling.js";
import { createDoclingSource } from "../examples/mocks/docling-source.js";
import {
	corpusDir,
	type CorpusDocument,
	accounted,
	checkEvidence,
	readGraphFitting,
	env,
	evaluate,
	fullGraph,
	type Expected,
	graphStats,
	linkingStats,
	log,
	prepareRelink,
	ROOT,
	reportPath,
} from "./kg-common.js";

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
	candidateMatch: "name" | "text";
	relink: string | null;
	corpus: string;
	extract: "model" | "none" | "names";
	tokenizer: Engine | null;
	jsModules: string | null;
};

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		out: null,
		docs: null,
		maxMinutes: 240,
		reasoning: "off",
		candidateMatch: "name",
		relink: null,
		corpus: "ai-memory",
		extract: "model",
		tokenizer: null,
		jsModules: null,
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
		else if (
			flag === "--candidate-match" &&
			(value === "name" || value === "text")
		)
			options.candidateMatch = value;
		else if (flag === "--relink") options.relink = resolve(value);
		else if (flag === "--corpus" && /^[a-z0-9-]+$/.test(value))
			options.corpus = value;
		else if (flag === "--extract" && (value === "none" || value === "names"))
			options.extract = value;
		else if (flag === "--tokenizer" && ENGINES.includes(value as Engine))
			options.tokenizer = value as Engine;
		else if (flag === "--js-modules") options.jsModules = resolve(value);
		else throw new Error(`unknown option ${flag}`);
		i++;
	}
	if (!Number.isFinite(options.maxMinutes) || options.maxMinutes <= 0)
		throw new Error("invalid --max-minutes");
	if (options.relink && options.docs)
		throw new Error("--relink keeps the earlier run's documents: no --docs");
	// The stub would also answer the identity questions of a relink with an extraction.
	if (options.relink && options.extract !== "model")
		throw new Error(
			`--relink and --extract ${options.extract} are not used together`,
		);
	if (options.extract !== "names" && (options.tokenizer || options.jsModules))
		throw new Error("--tokenizer and --js-modules go with --extract names");
	return options;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const ENGINES: readonly Engine[] = [
	"charclass",
	"sudachi-napi",
	"kuromoji",
	"lindera",
];

/** --extract names: no model may be asked; a call would be a wiring fault, so it fails loudly. */
const noModel: InferencePort = {
	async complete() {
		throw new Error("--extract names asks no model");
	},
};

/** --extract none: every extraction answer holds no entity and no relation (no model is asked). */
const noExtraction: InferencePort = {
	async complete() {
		return {
			ok: true,
			text: JSON.stringify({ entities: [], relations: [] }),
			model: null,
			usage: {
				inputTokens: null,
				cachedTokens: null,
				outputTokens: null,
				reasoningTokens: null,
				calls: null,
			},
			durationMs: 0,
		};
	},
};

async function loadCorpus(
	name: string,
	only: string[] | null,
): Promise<CorpusDocument[]> {
	const dir = corpusDir(name);
	const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
	const picked = only
		? files.filter((f) => only.includes(f.replace(/\.md$/, "")))
		: files;
	if (picked.length === 0) throw new Error("no corpus document selected");
	return Promise.all(
		picked.map(async (file) => ({
			file,
			path: `${name}/${file}`,
			markdown: await readFile(join(dir, file), "utf8"),
		})),
	);
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

	// A relink keeps the earlier run's documents exactly as they were ingested.
	const relinked = options.relink ? await prepareRelink(options.relink) : null;
	const corpus: CorpusDocument[] = relinked
		? relinked.documents.map((d) => ({
				file: basename(d.path),
				path: d.path,
				markdown: d.markdown,
			}))
		: await loadCorpus(options.corpus, options.docs);
	// A relinked database must hold the documents of --corpus (its expected.json grades them).
	if (corpus.some((d) => !d.path.startsWith(`${options.corpus}/`)))
		throw new Error(
			`the documents are not of --corpus ${options.corpus} (pass the corpus the run used)`,
		);
	const expected = JSON.parse(
		await readFile(join(corpusDir(options.corpus), "expected.json"), "utf8"),
	) as Expected;
	const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
	const out =
		options.out ??
		join(
			ROOT,
			`verification/kg-${options.corpus}`,
			`${stamp}-${profile}${
				options.extract === "none"
					? "-no-extraction"
					: options.extract === "names"
						? `-names-${options.tokenizer ?? "charclass"}`
						: ""
			}`,
		);
	// Loaded before anything runs: a tokenizer that fails its check stops here.
	const tokenizer =
		options.extract === "names"
			? await loadTokenizer(options.tokenizer ?? "charclass", options.jsModules)
			: null;
	await mkdir(out, { recursive: true });

	const docling = createDoclingMock({
		documents:
			relinked?.documents ??
			corpus.map((d): MockDocumentInput => ({
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
	const inference = accounted(
		options.extract === "none"
			? noExtraction
			: options.extract === "names"
				? noModel
				: larm.inference,
	);
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
		extractor:
			options.extract === "names" ? ("names" as const) : ("model" as const),
	};
	const linkOptions = {
		inferenceTimeoutMs: INFERENCE_TIMEOUT_MS,
		transientRetryDelayMs: RETRY_DELAY_MS,
		candidateMatch: options.candidateMatch,
	};
	const host = createExampleHost({
		...(relinked ? { dir: relinked.dir } : {}),
		keep: true,
		source,
		principals,
		clock,
		inference: inference.port,
		embedding: larm.embedding,
		...(tokenizer ? { tokenizer } : {}),
		handlerFactories: [
			(deps: IngestDeps) => createSyncPageHandler(deps, {}),
			(deps: IngestDeps) => createIngestNextHandler(deps, ingestOptions),
			// --extract names: mentions with an identity key are never compared by the model, so
			// the chain marks their versions compared without a call (kg2.md G4).
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
		const { graph, request: graphRequest } = await readGraphFitting(client);
		const evidence = await checkEvidence(client, graph);
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
		const linking = host.store.read((db) => linkingStats(db));
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
		// Every name of every mention (the graph API lists at most 10 names per node and may have
		// been read at smaller limits): the same joins, read from the database.
		const evaluationAllNames = host.store.read(
			(db) => evaluate(fullGraph(db), expected, corpus, docIdByPath).summary,
		);
		const jobs = host.runner.listJobs();
		const jobStates: Record<string, number> = {};
		for (const j of jobs)
			jobStates[`${j.kind}:${j.state}`] =
				(jobStates[`${j.kind}:${j.state}`] ?? 0) + 1;
		const report = {
			kind: "kg-live",
			note:
				options.extract === "none"
					? "Synthetic notes split and embedded through LARM; no extraction (every extraction answer was empty, no model was asked). A single run: not a benchmark."
					: options.extract === "names"
						? "Synthetic notes ingested with the model-free extractor (names and same-sentence relations from a tokenizer and rules, mentions joined by identity key when read) and embedded through LARM; no model was asked. A single run: not a benchmark."
						: "Synthetic research notes ingested with a real model through LARM. A single run: not a benchmark.",
			corpusName: options.corpus,
			extract: options.extract,
			extractor: tokenizer ? namesModel(tokenizer) : null,
			startedAt: new Date(started).toISOString(),
			elapsedMinutes: Number((elapsedMs / 60_000).toFixed(1)),
			elapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
			finished,
			relinkedFrom: options.relink ? reportPath(options.relink) : null,
			instructions: {
				extract:
					options.extract === "model" ? instruction("extract").version : null,
				link: tokenizer ? null : instruction("link").version,
				summarize: tokenizer ? null : instruction("summarize").version,
			},
			linkOptions: tokenizer
				? null
				: { candidateMatch: options.candidateMatch },
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
			linking,
			status: {
				complete: status.complete,
				partialReasons: status.partialReasons,
			},
			graph: {
				request: graphRequest,
				complete: graph.complete,
				partialReasons: graph.partialReasons,
				...graphStats(graph),
			},
			evidence,
			evaluation,
			evaluationAllNames,
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
		// A copy of the database for a later --relink (not committed).
		const snapshot = new Database(join(host.dir, "knowledge.db"), {
			readonly: true,
		});
		try {
			snapshot.run("VACUUM INTO ?", [join(out, "knowledge.db")]);
		} finally {
			snapshot.close();
		}
		log(`wrote ${join(out, "graph.json")}, report.json and knowledge.db`);
		log(`linking: ${JSON.stringify(linking)}`);
		log(`evaluation: ${JSON.stringify(evaluation.summary)}`);
		log(`evaluation (all names): ${JSON.stringify(evaluationAllNames)}`);
		log(`evidence: ${JSON.stringify(evidence)}`);
	} finally {
		await host.close();
	}
}

await main();
