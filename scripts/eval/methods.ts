// The search methods compared by the evaluation: the package (each route alone, and all routes
// together) and the two baselines. Each method answers a query with documents in rank order.
import {
	searchResponseSchema,
	searchRoutes,
	type AccessContext,
	type SearchRoute,
} from "../../src/contracts/index.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import {
	BASELINE_FTS_VERSION,
	BASELINE_LEDGER_VERSION,
	createFtsTrigramBaseline,
	createLedgerSubstringBaseline,
	uniqueInOrder,
	type BaselineDocument,
	type BaselineIndex,
} from "./baselines.js";
import type { SearchImplementation } from "./package-search.js";
import type { IngestedCorpus } from "./ingest.js";
import type { EvalDocument } from "./fixture.js";
import { PRINCIPALS, ALICE } from "../../examples/scenarios/harness.js";

/** Fragments (or documents) fetched per query; the ranked documents are cut to k afterwards. */
export const FETCH_LIMIT = 50;

export type MethodFamily =
	"package" | "baseline-fts-trigram" | "baseline-ledger";

export type MethodAnswer = {
	/** Document keys in rank order, each once. */
	ranked: string[];
	/** `null`: the method has no notion of completeness. */
	partial: boolean | null;
	/** The search threw or answered something the contract does not allow. */
	failed: boolean;
	/** Package only: how the answer reported itself (deterministic facts, no timing). */
	report?: {
		lexicalMode: string;
		partialReasons: string[];
		routes: {
			route: string;
			status: string;
			reason: string | null;
			candidates: number;
		}[];
	};
};

export type SearchMethod = {
	id: string;
	label: string;
	version: string;
	family: MethodFamily;
	routes: readonly SearchRoute[] | null;
	run(query: string): Promise<MethodAnswer>;
	close(): void;
};

/** A failed search is an answer with nothing in it and not a complete one. */
const failedAnswer = (): MethodAnswer => ({
	ranked: [],
	partial: true,
	failed: true,
});

export function createPackageMethods(
	implementation: SearchImplementation,
	corpus: IngestedCorpus,
	documents: readonly EvalDocument[],
): SearchMethod[] {
	const { scenario } = corpus;
	const access: AccessContext = PRINCIPALS[ALICE];
	const vectors = implementation.createVectorIndex();
	const keyById = new Map(documents.map((d) => [d.documentId, d.key]));
	const sourceLabel =
		implementation.source === "fake" ? "fake-search" : "package";
	const make = (
		id: string,
		label: string,
		routes: readonly SearchRoute[] | null,
	): SearchMethod => ({
		id,
		label,
		version: `${sourceLabel}@${PACKAGE_VERSION}${routes ? `:${routes.join("+")}` : ":default-routes"}`,
		family: "package",
		routes,
		async run(query) {
			try {
				const raw = await implementation.search(
					{
						read: (operation) =>
							scenario.host.store.readSnapshot(
								(db) => operation(db as never) as never,
							),
						embedding: corpus.searchEmbedding.port,
						vectors,
						clock: scenario.clock,
						options: { verifiedWithinMs: 24 * 60 * 60 * 1000 },
					},
					access,
					{
						query,
						limit: FETCH_LIMIT,
						...(routes ? { routes: [...routes] } : {}),
					},
					new AbortController().signal,
				);
				const response = searchResponseSchema.parse(raw);
				return {
					ranked: uniqueInOrder(
						response.results.map(
							(hit) =>
								keyById.get(hit.documentId) ?? `unknown:${hit.documentId}`,
						),
					),
					partial: !response.complete,
					failed: false,
					report: {
						lexicalMode: response.lexicalMode,
						partialReasons: [...response.partialReasons].sort(),
						routes: response.routes.map((r) => ({
							route: r.route,
							status: r.status,
							reason: r.reason,
							candidates: r.candidates,
						})),
					},
				};
			} catch {
				return failedAnswer();
			}
		},
		close() {},
	});
	return [
		make("package-integrated", "本パッケージ: 統合（既定の経路）", null),
		...searchRoutes.map((route) =>
			make(`package-${route}`, `本パッケージ: ${route} 経路の単独`, [route]),
		),
	];
}

export function createBaselineMethods(
	documents: readonly EvalDocument[],
): SearchMethod[] {
	const baselineDocuments: BaselineDocument[] = documents.map((d) => ({
		key: d.key,
		documentId: d.documentId,
		title: d.title,
		bytes: d.bytes,
		markdown: d.markdown,
	}));
	const wrap = (
		id: string,
		label: string,
		version: string,
		family: MethodFamily,
		index: BaselineIndex,
	): SearchMethod => ({
		id,
		label,
		version,
		family,
		routes: null,
		run: async (query) => ({
			ranked: index.search(query, FETCH_LIMIT),
			partial: null,
			failed: false,
		}),
		close: () => index.close(),
	});
	return [
		wrap(
			"baseline-fts-trigram",
			"基準 1: FTS trigram だけ",
			BASELINE_FTS_VERSION,
			"baseline-fts-trigram",
			createFtsTrigramBaseline(baselineDocuments),
		),
		wrap(
			"baseline-ledger",
			"基準 2: World の収集資料台帳と同じ部分一致",
			BASELINE_LEDGER_VERSION,
			"baseline-ledger",
			createLedgerSubstringBaseline(baselineDocuments),
		),
	];
}
