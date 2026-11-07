// Runs the comparison against the package's own `search` when the package exports it. Skipped
// (by an early return) while the package has no search; the contract-typed stand-in covers the
// comparison itself in report.test.ts.
import { expect, test } from "bun:test";
import { loadFixture } from "./fixture.js";
import { loadPackageSearch } from "./package-search.js";
import { checkDeterminism } from "./report.js";
import { runEvaluation } from "./run.js";

const fixture = loadFixture();

test("with the package's search: every answer fits the contract, nothing fails, runs agree", async () => {
	const implementation = await loadPackageSearch();
	if (!implementation) return;
	expect(implementation.source).toBe("package");
	const runs = [
		await runEvaluation({ implementation, fixture }),
		await runEvaluation({ implementation, fixture }),
	];
	expect(checkDeterminism(runs).identical).toBe(true);
	const methods = runs[0]?.deterministic.methods ?? [];
	for (const m of methods) expect(m.summary.failedQueries).toBe(0);
	const byId = Object.fromEntries(methods.map((m) => [m.id, m]));
	// Package methods report themselves; the baselines do not.
	expect(byId["package-integrated"]?.summary.partialRate).not.toBeNull();
	expect(byId["baseline-ledger"]?.summary.partialRate).toBeNull();
	// The integrated search is not worse than its own text route on the same questions.
	expect(
		byId["package-integrated"]?.summary.recall.at10 ?? 0,
	).toBeGreaterThanOrEqual(byId["package-text"]?.summary.recall.at10 ?? 1);
	// Baseline 1 and the text route see the same documents for any query the trigram index can answer.
	const text = byId["package-text"];
	const fts = byId["baseline-fts-trigram"];
	for (const q of fixture.questions) {
		if ([...q.query.normalize("NFKC")].length < 3) continue;
		const a = text?.questions.find((x) => x.id === q.id);
		const b = fts?.questions.find((x) => x.id === q.id);
		expect(new Set(a?.top), q.id).toEqual(new Set(b?.top));
	}
});
