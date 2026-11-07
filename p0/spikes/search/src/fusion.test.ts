import { expect, test } from "bun:test";
import { rrf } from "./fusion-bench.ts";
test("RRF: 両方の list に出る文書が上位に来る。順位だけを使う", () => {
	const r = rrf([[1, 2, 3], [3, 4, 1]], 60, 10);
	expect(r.map((x) => x.id).slice(0, 2).sort()).toEqual([1, 3]);
	expect(r.length).toBe(4);
	expect(rrf([[1], []], 60, 10)).toEqual([{ id: 1, score: 1 / 61 }]);
});
test("RRF: 件数上限を守る", () => expect(rrf([[1, 2, 3, 4], [5, 6, 7, 8]], 60, 3).length).toBe(3));
