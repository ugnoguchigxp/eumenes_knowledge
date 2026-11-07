import { expect, test } from "bun:test";
import { stages, summarize } from "./verify.js";

test("the stages run in the documented order", () => {
	expect(stages("/repo").map((s) => s.name.split(" ")[0])).toEqual([
		"contexts:check",
		"format",
		"lint",
		"typecheck",
		"typecheck",
		"test",
	]);
});

test("summarize passes only when every stage passed", () => {
	const ok = { name: "a", ok: true, exitCode: 0, ms: 5 };
	expect(summarize([ok, ok]).ok).toBe(true);
	const mixed = summarize([
		ok,
		{ name: "b", ok: false, exitCode: 2, ms: 7 },
		ok,
	]);
	expect(mixed.ok).toBe(false);
	expect(mixed.text).toContain("FAIL  b (exit 2)");
	expect(mixed.text).toContain("1 of 3 stage(s) failed");
	expect(summarize([]).ok).toBe(false);
});
