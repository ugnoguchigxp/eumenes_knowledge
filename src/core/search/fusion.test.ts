import { describe, expect, test } from "bun:test";
import { RRF_K, fuseRanks } from "./fusion.js";

describe("fuseRanks", () => {
	test("sums 1/(k+rank) over the lists and orders by it", () => {
		const fused = fuseRanks([
			["a", "b", "c"],
			["c", "b", "d"],
		]);
		expect(fused.map((f) => f.key)).toEqual(["c", "b", "a", "d"]);
		const b = fused.find((f) => f.key === "b")!;
		expect(b.ranks).toEqual([2, 2]);
		expect(b.score).toBeCloseTo(2 / (RRF_K + 2), 12);
		expect(fused.find((f) => f.key === "d")!.ranks).toEqual([undefined, 3]);
	});

	test("an item in two lists beats an item first in only one", () => {
		const fused = fuseRanks([["x", "y"], ["z", "y"], ["w"]]);
		expect(fused[0]!.key).toBe("y");
	});

	test("ties go to the better single rank, then to the first seen", () => {
		// a: rank 1 in list 0 only; z: rank 1 in list 1 only; equal scores, equal best rank
		const fused = fuseRanks([["a"], ["z"]]);
		expect(fused.map((f) => f.key)).toEqual(["a", "z"]);
		const swapped = fuseRanks([["z"], ["a"]]);
		expect(swapped.map((f) => f.key)).toEqual(["z", "a"]);
		// same score by symmetry (1/61 + 1/63 either way is not a tie, so use equal totals)
		const tie = fuseRanks([
			["p", "q"],
			["q", "p"],
		]);
		expect(tie.map((f) => f.key)).toEqual(["p", "q"]);
	});

	test("empty input and duplicates inside one list", () => {
		expect(fuseRanks([])).toEqual([]);
		expect(fuseRanks([[], []])).toEqual([]);
		const dup = fuseRanks([["a", "a", "b"]]);
		expect(dup.map((f) => [f.key, f.ranks[0]])).toEqual([
			["a", 1],
			["b", 3],
		]);
	});

	test("only ranks matter: the same order gives the same fusion", () => {
		const one = fuseRanks([
			[1, 2, 3],
			[3, 1],
		]);
		const two = fuseRanks([
			[1, 2, 3],
			[3, 1],
		]);
		expect(one).toEqual(two);
	});
});
