// Runs the comparison: ingest the corpus once, then ask every question of every method.
// The returned record has a deterministic part (everything that depends on the inputs only) and a
// volatile part (timings, machine). Two runs on the same inputs must give the same deterministic part.
import { cpus, arch, platform, release, totalmem } from "node:os";
import { PACKAGE_VERSION } from "../../src/version.js";
import { ALICE, PRINCIPALS } from "../../examples/scenarios/harness.js";
import {
	FIXTURE_DIR,
	loadFixture,
	manifestMatches,
	questionKinds,
	type EvalFixture,
} from "./fixture.js";
import { ingestCorpus, type IngestStats } from "./ingest.js";
import {
	createBaselineMethods,
	createPackageMethods,
	FETCH_LIMIT,
	type SearchMethod,
} from "./methods.js";
import {
	summarize,
	summarizeBy,
	summarizeLatency,
	firstRelevantRank,
	type LatencySummary,
	type MetricSummary,
	type QuestionOutcome,
} from "./metrics.js";
import type { SearchImplementation } from "./package-search.js";
import {
	createMockPorts,
	diffEmbeddingCounts,
	type EmbeddingCounts,
	type EvalPorts,
} from "./ports.js";

export const RESULT_SCHEMA = "eumenes-knowledge.eval-search.v1";

/** Printed in the record and the report: what this result is and is not. */
export const SYNTHETIC_NOTICE =
	"fixture（合成資料・scripted mock）での結果であり、意味の品質を示さない。仕組みが動くことと、質問の種類ごとの挙動の違いを確かめるためのもの。実モデル・実文書での比較は P6 以降の opt-in（p0.md #24 の指定が要る）。";

export class EvalRunError extends Error {
	constructor(
		readonly code: string,
		detail = "",
	) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export type QuestionRecord = {
	id: string;
	set: string;
	kind: string;
	/** Rank of the best expected document; null when none was returned or nothing is expected. */
	firstRank: number | null;
	/** The first ten documents returned (keys). */
	top: string[];
	partial: boolean | null;
	failed: boolean;
};

export type MethodResult = {
	id: string;
	label: string;
	version: string;
	family: string;
	routes: readonly string[] | null;
	summary: MetricSummary;
	bySet: Record<string, MetricSummary>;
	byKind: Record<string, MetricSummary>;
	/** Search-time calls of the ports. Search never receives an inference port, so it is 0 by construction. */
	searchCalls: {
		inference: number;
		embedding: EmbeddingCounts;
	};
	/** How often the answers reported each lexical mode and partial reason (package methods). */
	lexicalModes: Record<string, number>;
	partialReasons: Record<string, number>;
	routeStatuses: Record<string, number>;
	questions: QuestionRecord[];
};

export type DeterministicRecord = {
	schema: typeof RESULT_SCHEMA;
	notice: string;
	inputs: {
		corpus: EvalFixture["digests"]["corpus"];
		extraction: EvalFixture["digests"]["extraction"];
		questions: EvalFixture["digests"]["questions"];
		/** Questions asked, by kind. */
		questionKinds: Record<string, number>;
		questionsAsked: number;
		package: { name: string; version: string };
		search: { source: string };
		ports: { label: string; synthetic: boolean };
		principal: { namespaces: readonly string[] };
		/** Fragments or documents fetched per query before the ranked documents are cut to k. */
		fetchLimit: number;
	};
	ingest: IngestStats;
	methods: MethodResult[];
};

export type LatencyRecord = {
	/** Wall-clock milliseconds of one search call, sequential, after one unrecorded priming call. */
	byMethod: Record<string, LatencySummary & { perQuestionMs: number[] }>;
	ingestMs: number;
};

export type RunConditions = {
	startedAt: string;
	finishedAt: string;
	bun: string;
	platform: string;
	arch: string;
	osRelease: string;
	cpuModel: string;
	cpuCount: number;
	memoryGiB: number;
};

export type EvalRun = {
	deterministic: DeterministicRecord;
	latency: LatencyRecord;
	conditions: RunConditions;
};

export type EvalRunOptions = {
	implementation: SearchImplementation;
	fixture?: EvalFixture;
	ports?: EvalPorts;
	/** Only these methods (ids). Default: all. */
	methodIds?: readonly string[];
	/** Only the first n questions (tests). Default: all. */
	questionLimit?: number;
	/** Millisecond clock for latency. Default `performance.now`. */
	timer?: () => number;
};

const count = (record: Record<string, number>, key: string) => {
	record[key] = (record[key] ?? 0) + 1;
};
const sortedRecord = (record: Record<string, number>) =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

export function machineConditions(): Omit<
	RunConditions,
	"startedAt" | "finishedAt"
> {
	const cpu = cpus();
	return {
		bun: Bun.version,
		platform: platform(),
		arch: arch(),
		osRelease: release(),
		cpuModel: cpu[0]?.model ?? "unknown",
		cpuCount: cpu.length,
		memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
	};
}

export async function runEvaluation(options: EvalRunOptions): Promise<EvalRun> {
	const timer = options.timer ?? (() => performance.now());
	const startedAt = new Date().toISOString();
	const fixture = options.fixture ?? loadFixture(FIXTURE_DIR);
	if (!manifestMatches(fixture))
		throw new EvalRunError(
			"fixture_manifest_mismatch",
			"run `bun scripts/eval/update-manifest.ts` after changing the fixture",
		);
	const questions =
		options.questionLimit === undefined
			? fixture.questions
			: fixture.questions.slice(0, options.questionLimit);
	const ports = options.ports ?? createMockPorts();

	const ingestStart = timer();
	const corpus = await ingestCorpus(fixture, ports);
	const ingestMs = timer() - ingestStart;
	const methods: SearchMethod[] = [];
	try {
		methods.push(
			...createPackageMethods(
				options.implementation,
				corpus,
				fixture.documents,
			),
			...createBaselineMethods(fixture.documents),
		);
		const selected = options.methodIds
			? methods.filter((m) => options.methodIds?.includes(m.id))
			: methods;
		const results: MethodResult[] = [];
		const latencies: LatencyRecord["byMethod"] = {};
		for (const method of selected) {
			const first = questions[0];
			// One unrecorded call warms what a long-lived host would already hold (the resident vectors).
			if (first) await method.run(first.query);
			const before = corpus.searchEmbedding.counts();
			const outcomes: QuestionOutcome[] = [];
			const records: QuestionRecord[] = [];
			const times: number[] = [];
			const lexicalModes: Record<string, number> = {};
			const partialReasons: Record<string, number> = {};
			const routeStatuses: Record<string, number> = {};
			for (const question of questions) {
				const t0 = timer();
				const answer = await method.run(question.query);
				times.push(timer() - t0);
				const outcome: QuestionOutcome = {
					id: question.id,
					kind: question.kind,
					set: question.set,
					expected: question.expected,
					ranked: answer.ranked,
					partial: answer.partial,
					failed: answer.failed,
				};
				outcomes.push(outcome);
				records.push({
					id: question.id,
					set: question.set,
					kind: question.kind,
					firstRank: firstRelevantRank(answer.ranked, question.expected),
					top: answer.ranked.slice(0, 10),
					partial: answer.partial,
					failed: answer.failed,
				});
				if (answer.report) {
					count(lexicalModes, answer.report.lexicalMode);
					for (const reason of answer.report.partialReasons)
						count(partialReasons, reason);
					for (const r of answer.report.routes)
						count(routeStatuses, `${r.route}:${r.status}`);
				}
			}
			const after = corpus.searchEmbedding.counts();
			results.push({
				id: method.id,
				label: method.label,
				version: method.version,
				family: method.family,
				routes: method.routes,
				summary: summarize(outcomes),
				bySet: summarizeBy(outcomes, (o) => o.set),
				byKind: summarizeBy(outcomes, (o) => o.kind),
				searchCalls: {
					inference: 0,
					embedding: diffEmbeddingCounts(after, before),
				},
				lexicalModes: sortedRecord(lexicalModes),
				partialReasons: sortedRecord(partialReasons),
				routeStatuses: sortedRecord(routeStatuses),
				questions: records,
			});
			latencies[method.id] = {
				...summarizeLatency(times),
				perQuestionMs: times.map((t) => Math.round(t * 1000) / 1000),
			};
		}
		const kindCounts: Record<string, number> = {};
		for (const kind of questionKinds) kindCounts[kind] = 0;
		for (const q of questions) count(kindCounts, q.kind);
		return {
			deterministic: {
				schema: RESULT_SCHEMA,
				notice: SYNTHETIC_NOTICE,
				inputs: {
					corpus: fixture.digests.corpus,
					extraction: fixture.digests.extraction,
					questions: fixture.digests.questions,
					questionKinds: kindCounts,
					questionsAsked: questions.length,
					package: { name: "eumenes_knowledge", version: PACKAGE_VERSION },
					search: { source: options.implementation.source },
					ports: { label: ports.label, synthetic: ports.synthetic },
					principal: { namespaces: PRINCIPALS[ALICE].namespaces },
					fetchLimit: FETCH_LIMIT,
				},
				ingest: corpus.stats,
				methods: results,
			},
			latency: { byMethod: latencies, ingestMs: Math.round(ingestMs) },
			conditions: {
				startedAt,
				finishedAt: new Date().toISOString(),
				...machineConditions(),
			},
		};
	} finally {
		for (const method of methods) method.close();
		await corpus.close();
	}
}
