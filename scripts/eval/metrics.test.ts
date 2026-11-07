import { describe, expect, test } from "bun:test";
import {
	firstRelevantRank,
	hitAtK,
	percentile,
	recallAtK,
	summarize,
	summarizeBy,
	summarizeLatency,
	type QuestionOutcome,
} from "./metrics.js";

const outcome = (
	overrides: Partial<QuestionOutcome> & Pick<QuestionOutcome, "ranked">,
): QuestionOutcome => ({
	id: "q",
	kind: "verbatim",
	set: "seen",
	expected: [],
	partial: false,
	failed: false,
	...overrides,
});

describe("rank and recall@k", () => {
	test("firstRelevantRank is the 1-based rank of the best expected document", () => {
		expect(firstRelevantRank(["a", "b", "c"], ["c", "b"])).toBe(2);
		expect(firstRelevantRank(["a", "b"], ["z"])).toBeNull();
		expect(firstRelevantRank([], ["a"])).toBeNull();
	});

	test("recallAtK is the share of expected documents inside the first k", () => {
		const ranked = ["a", "x", "b", "y", "c"];
		expect(recallAtK(ranked, ["a", "b", "c"], 1)).toBeCloseTo(1 / 3);
		expect(recallAtK(ranked, ["a", "b", "c"], 3)).toBeCloseTo(2 / 3);
		expect(recallAtK(ranked, ["a", "b", "c"], 5)).toBe(1);
		expect(recallAtK(ranked, ["q"], 10)).toBe(0);
	});

	test("nothing expected gives null, not 0 or 1", () => {
		expect(recallAtK(["a"], [], 10)).toBeNull();
		expect(hitAtK(["a"], [], 10)).toBeNull();
	});

	test("hitAtK is 1 only when an expected document is within k", () => {
		expect(hitAtK(["a", "b"], ["b"], 1)).toBe(0);
		expect(hitAtK(["a", "b"], ["b"], 2)).toBe(1);
	});
});

describe("percentile (nearest rank)", () => {
	test("p50 and p95 of a small list", () => {
		const values = [5, 1, 3, 2, 4, 10, 9, 8, 7, 6];
		expect(percentile(values, 50)).toBe(5);
		expect(percentile(values, 95)).toBe(10);
		expect(percentile([7], 95)).toBe(7);
		expect(percentile([], 50)).toBeNull();
	});

	test("the input is not reordered", () => {
		const values = [3, 1, 2];
		percentile(values, 50);
		expect(values).toEqual([3, 1, 2]);
	});

	test("summarizeLatency reports samples, p50, p95 and max", () => {
		expect(summarizeLatency([1, 2, 3, 4])).toEqual({
			samples: 4,
			p50Ms: 2,
			p95Ms: 4,
			maxMs: 4,
		});
		expect(summarizeLatency([]).p50Ms).toBeNull();
	});
});

describe("summarize", () => {
	const outcomes = [
		outcome({ id: "1", ranked: ["a", "b"], expected: ["a"] }),
		outcome({ id: "2", ranked: ["x", "b"], expected: ["b"] }),
		outcome({ id: "3", ranked: ["x", "y"], expected: ["q"] }),
		outcome({ id: "4", ranked: [], expected: [], partial: false }),
		outcome({ id: "5", ranked: ["z"], expected: [], partial: true }),
	];

	test("recall, hit, found, median rank and MRR cover answerable questions only", () => {
		const s = summarize(outcomes);
		expect(s.questions).toBe(5);
		expect(s.answerable).toBe(3);
		expect(s.recall.at1).toBeCloseTo(1 / 3, 5);
		expect(s.recall.at5).toBeCloseTo(2 / 3, 5);
		expect(s.recall.at10).toBeCloseTo(2 / 3, 5);
		expect(s.hit.at1).toBeCloseTo(1 / 3, 5);
		expect(s.found).toBeCloseTo(2 / 3, 5);
		expect(s.medianTopRank).toBe(1);
		expect(s.meanReciprocalRank).toBeCloseTo((1 + 0.5 + 0) / 3, 5);
	});

	test("questions without an answer: share that returned nothing and share answered partial", () => {
		const s = summarize(outcomes);
		expect(s.noAnswer).toEqual({
			questions: 2,
			emptyRate: 0.5,
			partialRate: 0.5,
		});
	});

	test("partialRate counts partial answers over all questions", () => {
		expect(summarize(outcomes).partialRate).toBeCloseTo(1 / 5, 5);
	});

	test("a method that does not report completeness has no partial rate", () => {
		const s = summarize(outcomes.map((o) => ({ ...o, partial: null })));
		expect(s.partialRate).toBeNull();
		expect(s.noAnswer.partialRate).toBeNull();
	});

	test("an empty list gives nulls without throwing", () => {
		const s = summarize([]);
		expect(s.questions).toBe(0);
		expect(s.recall.at10).toBeNull();
		expect(s.partialRate).toBeNull();
	});

	test("failed searches are counted", () => {
		const s = summarize([
			outcome({ ranked: [], expected: ["a"], failed: true, partial: true }),
		]);
		expect(s.failedQueries).toBe(1);
		expect(s.recall.at10).toBe(0);
	});

	test("summarizeBy groups in first-seen order", () => {
		const groups = summarizeBy(
			[
				outcome({ ranked: ["a"], expected: ["a"], kind: "k2" }),
				outcome({ ranked: ["b"], expected: ["a"], kind: "k1" }),
				outcome({ ranked: ["a"], expected: ["a"], kind: "k2" }),
			],
			(o) => o.kind,
		);
		expect(Object.keys(groups)).toEqual(["k2", "k1"]);
		expect(groups.k2?.recall.at1).toBe(1);
		expect(groups.k1?.recall.at1).toBe(0);
	});
});
