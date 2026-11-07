// Ports of the evaluation (inference and embedding) and the counting around them. The evaluation
// takes its ports from here and from nowhere else: no environment variable names an endpoint and
// nothing connects to a service. A real connection (P6 and later, opt-in) would be one more
// `EvalPorts` supplied by the caller; this module does not build one.
import type {
	EmbeddingKind,
	EmbeddingPort,
} from "../../src/contracts/index.js";
import { TEST_SPACE } from "../../examples/scenarios/harness.js";
import { createMeaninglessHashEmbedding } from "../../examples/mocks/embedding.js";

export type EvalPorts = {
	/** Identifies the ports in the record (for example `mock:scripted-extraction+hash-embedding`). */
	label: string;
	/**
	 * The embedding used at ingest and at search. The mock's vectors come from a hash and carry no
	 * meaning: the vector route cannot find anything by meaning with them.
	 */
	embedding: EmbeddingPort;
	/** True when the answers are scripted/synthetic. A real port sets false (P6 and later). */
	synthetic: boolean;
};

export function createMockPorts(): EvalPorts {
	return {
		label: "mock:scripted-extraction+hash-embedding",
		embedding: createMeaninglessHashEmbedding({ space: TEST_SPACE }).port,
		synthetic: true,
	};
}

export type EmbeddingCounts = {
	calls: number;
	texts: number;
	byKind: Record<EmbeddingKind, { calls: number; texts: number }>;
};

export type CountingEmbedding = {
	port: EmbeddingPort;
	counts(): EmbeddingCounts;
};

/** Counts the calls that go through `inner`; separate wrappers split ingest from search. */
export function countEmbedding(inner: EmbeddingPort): CountingEmbedding {
	const byKind: EmbeddingCounts["byKind"] = {
		query: { calls: 0, texts: 0 },
		passage: { calls: 0, texts: 0 },
	};
	return {
		port: {
			embed(texts, kind, signal) {
				byKind[kind].calls += 1;
				byKind[kind].texts += texts.length;
				return inner.embed(texts, kind, signal);
			},
		},
		counts: () => ({
			calls: byKind.query.calls + byKind.passage.calls,
			texts: byKind.query.texts + byKind.passage.texts,
			byKind: {
				query: { ...byKind.query },
				passage: { ...byKind.passage },
			},
		}),
	};
}

export const diffEmbeddingCounts = (
	after: EmbeddingCounts,
	before: EmbeddingCounts,
): EmbeddingCounts => ({
	calls: after.calls - before.calls,
	texts: after.texts - before.texts,
	byKind: {
		query: {
			calls: after.byKind.query.calls - before.byKind.query.calls,
			texts: after.byKind.query.texts - before.byKind.query.texts,
		},
		passage: {
			calls: after.byKind.passage.calls - before.byKind.passage.calls,
			texts: after.byKind.passage.texts - before.byKind.passage.texts,
		},
	},
});
