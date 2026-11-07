// Metrics of the search comparison (p3.md section 6). Pure functions over ranked document lists.
// A search method answers each question with documents in rank order (the first appearance of a
// document in its result list); the expected documents are the document keys of the question.

export const RECALL_KS = [1, 5, 10] as const;
export type RecallK = (typeof RECALL_KS)[number];

/** 1-based rank of the best-ranked expected document; null when none is in `ranked`. */
export function firstRelevantRank(
	ranked: readonly string[],
	expected: readonly string[],
): number | null {
	const wanted = new Set(expected);
	const index = ranked.findIndex((key) => wanted.has(key));
	return index === -1 ? null : index + 1;
}

/** Share of the expected documents found in the first `k` ranked documents (null: nothing expected). */
export function recallAtK(
	ranked: readonly string[],
	expected: readonly string[],
	k: number,
): number | null {
	const wanted = new Set(expected);
	if (wanted.size === 0) return null;
	const top = new Set(ranked.slice(0, k));
	let found = 0;
	for (const key of wanted) if (top.has(key)) found += 1;
	return found / wanted.size;
}

/** 1 when any expected document is in the first `k`, 0 when not, null when nothing is expected. */
export function hitAtK(
	ranked: readonly string[],
	expected: readonly string[],
	k: number,
): 0 | 1 | null {
	if (expected.length === 0) return null;
	const rank = firstRelevantRank(ranked, expected);
	return rank !== null && rank <= k ? 1 : 0;
}

/** Nearest-rank percentile (p in 0..100) of the values; null for an empty list. */
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
	return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/** Rounds to 6 decimals so a JSON record does not depend on float noise. */
export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

const mean = (values: readonly number[]): number | null =>
	values.length === 0
		? null
		: round6(values.reduce((a, b) => a + b, 0) / values.length);

/** What a method returned for one question, as the evaluation records it. */
export type QuestionOutcome = {
	id: string;
	kind: string;
	set: string;
	expected: readonly string[];
	/** Documents in rank order, each once. */
	ranked: readonly string[];
	/** `null` when the method has no notion of completeness (the baselines). */
	partial: boolean | null;
	/** The search threw or answered an invalid response; counted as an empty answer. */
	failed: boolean;
};

export type MetricSummary = {
	questions: number;
	/** Questions that have at least one expected document. */
	answerable: number;
	recall: Record<`at${RecallK}`, number | null>;
	/** Share of answerable questions with an expected document in the first k. */
	hit: Record<`at${RecallK}`, number | null>;
	/** Share of answerable questions where an expected document was found at all in the result list. */
	found: number | null;
	/** Median of the best expected rank over the questions where one was found. */
	medianTopRank: number | null;
	meanReciprocalRank: number | null;
	/** Questions with nothing expected. */
	noAnswer: {
		questions: number;
		/** Share that returned no document at all. */
		emptyRate: number | null;
		/** Share answered as partial (complete: false). */
		partialRate: number | null;
	};
	/** Share of all questions answered as partial; null when the method does not report it. */
	partialRate: number | null;
	failedQueries: number;
};

const perK = <T>(f: (k: RecallK) => T) => ({
	at1: f(1),
	at5: f(5),
	at10: f(10),
});

export function summarize(outcomes: readonly QuestionOutcome[]): MetricSummary {
	const answerable = outcomes.filter((o) => o.expected.length > 0);
	const none = outcomes.filter((o) => o.expected.length === 0);
	const ranks = answerable.map((o) => firstRelevantRank(o.ranked, o.expected));
	const foundRanks = ranks.filter((r): r is number => r !== null);
	const reports = outcomes.every((o) => o.partial !== null);
	const share = (count: number, total: number) =>
		total === 0 ? null : round6(count / total);
	return {
		questions: outcomes.length,
		answerable: answerable.length,
		recall: perK((k) => {
			const values = answerable.map(
				(o) => recallAtK(o.ranked, o.expected, k) as number,
			);
			return mean(values);
		}),
		hit: perK((k) =>
			mean(answerable.map((o) => hitAtK(o.ranked, o.expected, k) as number)),
		),
		found: share(foundRanks.length, answerable.length),
		medianTopRank: percentile(foundRanks, 50),
		meanReciprocalRank: mean(ranks.map((r) => (r === null ? 0 : 1 / r))),
		noAnswer: {
			questions: none.length,
			emptyRate: share(
				none.filter((o) => o.ranked.length === 0).length,
				none.length,
			),
			partialRate: none.every((o) => o.partial !== null)
				? share(none.filter((o) => o.partial).length, none.length)
				: null,
		},
		partialRate:
			reports && outcomes.length > 0
				? share(outcomes.filter((o) => o.partial).length, outcomes.length)
				: null,
		failedQueries: outcomes.filter((o) => o.failed).length,
	};
}

/** Groups `outcomes` by `key` (keys in first-seen order) and summarizes each group. */
export function summarizeBy(
	outcomes: readonly QuestionOutcome[],
	key: (outcome: QuestionOutcome) => string,
): Record<string, MetricSummary> {
	const groups = new Map<string, QuestionOutcome[]>();
	for (const outcome of outcomes) {
		const name = key(outcome);
		const group = groups.get(name);
		if (group) group.push(outcome);
		else groups.set(name, [outcome]);
	}
	return Object.fromEntries(
		[...groups].map(([name, group]) => [name, summarize(group)]),
	);
}

export type LatencySummary = {
	samples: number;
	p50Ms: number | null;
	p95Ms: number | null;
	maxMs: number | null;
};

export function summarizeLatency(valuesMs: readonly number[]): LatencySummary {
	const r = (v: number | null) =>
		v === null ? null : Math.round(v * 1000) / 1000;
	return {
		samples: valuesMs.length,
		p50Ms: r(percentile(valuesMs, 50)),
		p95Ms: r(percentile(valuesMs, 95)),
		maxMs: r(valuesMs.length === 0 ? null : Math.max(...valuesMs)),
	};
}
