import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../eval-search.js";
import { fakeSearchImplementation } from "./package-search.js";
import {
	buildResultFile,
	canonicalJson,
	checkDeterminism,
	deterministicDigest,
	renderMarkdown,
	timestampName,
	writeResult,
	type ResultFile,
} from "./report.js";
import {
	RESULT_SCHEMA,
	SYNTHETIC_NOTICE,
	runEvaluation,
	type EvalRun,
} from "./run.js";
import { loadFixture } from "./fixture.js";

const tempRoots: string[] = [];
function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-knowledge-eval-test-"));
	tempRoots.push(dir);
	return dir;
}
afterAll(() => {
	// Only directories this file created itself, by absolute path.
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

const implementation = fakeSearchImplementation;
const fixture = loadFixture();

let cachedRuns: EvalRun[] | undefined;
async function twoRuns(): Promise<EvalRun[]> {
	cachedRuns ??= [
		await runEvaluation({ implementation, fixture }),
		await runEvaluation({ implementation, fixture }),
	];
	return cachedRuns;
}

describe("a run", () => {
	test("covers every question with every method and counts what the ports did", async () => {
		const [run] = await twoRuns();
		if (!run) throw new Error("no run");
		const d = run.deterministic;
		expect(d.schema).toBe(RESULT_SCHEMA);
		expect(d.notice).toBe(SYNTHETIC_NOTICE);
		expect(d.methods.map((m) => m.id)).toEqual([
			"package-integrated",
			"package-text",
			"package-vector",
			"package-entity",
			"package-relation",
			"baseline-fts-trigram",
			"baseline-ledger",
		]);
		for (const m of d.methods) {
			expect(m.questions).toHaveLength(fixture.questions.length);
			expect(m.summary.questions).toBe(fixture.questions.length);
			expect(m.searchCalls.inference).toBe(0);
		}
		// One inference call per fragment, embedding batches of at most 64 texts.
		expect(d.ingest.extractionCalls).toBe(d.ingest.fragments);
		expect(d.ingest.inferenceCalls).toBe(
			d.ingest.extractionCalls + d.ingest.linkCalls,
		);
		expect(d.ingest.embeddingTexts).toBe(d.ingest.fragments);
		expect(d.ingest.embeddingCalls).toBeLessThanOrEqual(
			Math.ceil(d.ingest.fragments / 64) + d.ingest.documents,
		);
		// Search-time embeddings are counted apart from the ingest ones: one per query on the
		// methods that use the vector route, none on the others.
		const byId = Object.fromEntries(d.methods.map((m) => [m.id, m]));
		expect(
			byId["package-vector"]?.searchCalls.embedding.byKind.query.calls,
		).toBe(fixture.questions.length);
		expect(byId["package-text"]?.searchCalls.embedding.calls).toBe(0);
		expect(byId["baseline-ledger"]?.searchCalls.embedding.calls).toBe(0);
		expect(
			byId["package-vector"]?.searchCalls.embedding.byKind.passage.calls,
		).toBe(0);
	});

	test("the baselines are measured on the same questions with their documented rules", async () => {
		const [run] = await twoRuns();
		const methods = Object.fromEntries(
			(run?.deterministic.methods ?? []).map((m) => [m.id, m]),
		);
		const ledger = methods["baseline-ledger"];
		const fts = methods["baseline-fts-trigram"];
		// The ledger (no NFKC) misses the width variants; the trigram index (NFKC) finds them.
		expect(ledger?.byKind.variant_width?.recall.at10).toBeLessThan(
			fts?.byKind.variant_width?.recall.at10 ?? 0,
		);
		// The trigram index cannot find 2-character words; the substring scan can.
		expect(fts?.byKind.short2?.recall.at10).toBe(0);
		expect(ledger?.byKind.short2?.recall.at10).toBe(1);
		// Neither baseline has a completeness notion.
		expect(ledger?.summary.partialRate).toBeNull();
		expect(fts?.summary.partialRate).toBeNull();
		// Nothing is answered for a question with no answer.
		expect(ledger?.summary.noAnswer.emptyRate).toBe(1);
		expect(fts?.summary.noAnswer.emptyRate).toBe(1);
	});

	test("every question's record carries its rank, the documents returned and the partial flag", async () => {
		const [run] = await twoRuns();
		const text = run?.deterministic.methods.find(
			(m) => m.id === "baseline-ledger",
		);
		const verbatim = text?.questions.find((q) => q.kind === "verbatim");
		expect(verbatim?.firstRank).toBeGreaterThanOrEqual(1);
		expect(verbatim?.top.length).toBeGreaterThan(0);
		expect(verbatim?.partial).toBeNull();
	});
});

describe("determinism", () => {
	test("two runs on the same inputs differ in timing only", async () => {
		const runs = await twoRuns();
		const determinism = checkDeterminism(runs);
		expect(determinism.runs).toBe(2);
		expect(determinism.identical).toBe(true);
		expect(canonicalJson(runs[0]?.deterministic)).toBe(
			canonicalJson(runs[1]?.deterministic),
		);
		// The latency really is outside the compared part.
		expect(runs[0]?.latency).not.toBe(runs[1]?.latency);
		expect(JSON.stringify(runs[0]?.deterministic)).not.toContain(
			"perQuestionMs",
		);
		expect(JSON.stringify(runs[0]?.deterministic)).not.toContain("startedAt");
	});

	test("a different answer is detected", async () => {
		const [a] = await twoRuns();
		if (!a) throw new Error("no run");
		const changed: EvalRun = structuredClone(a);
		const first = changed.deterministic.methods[0];
		if (!first) throw new Error("no method");
		first.questions[0] = { ...first.questions[0]!, firstRank: 99 };
		const determinism = checkDeterminism([a, changed]);
		expect(determinism.identical).toBe(false);
		expect(deterministicDigest(a.deterministic)).not.toBe(
			deterministicDigest(changed.deterministic),
		);
	});

	test("canonicalJson does not depend on key order", () => {
		expect(canonicalJson({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe(
			canonicalJson({ a: { c: [{ x: 2, y: 1 }], d: 1 }, b: 1 }),
		);
	});
});

describe("the written result", () => {
	async function written(): Promise<{ dir: string; file: ResultFile }> {
		const runs = await twoRuns();
		const determinism = checkDeterminism(runs);
		const file = buildResultFile(runs, determinism);
		const dir = writeResult(file, tempRoot());
		return { dir, file };
	}

	test("a directory named by time and short digest holds result.json and report.md", async () => {
		const { dir, file } = await written();
		const name = dir.split("/").pop() ?? "";
		expect(name).toMatch(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/);
		expect(name.endsWith(file.digest.slice(0, 8))).toBe(true);
		expect(name.startsWith(timestampName(file.run.conditions.startedAt))).toBe(
			true,
		);
		expect(readdirSync(dir).sort()).toEqual(["report.md", "result.json"]);
	});

	test("result.json states the conditions, the input digests, the versions and the notice", async () => {
		const { dir } = await written();
		const json = JSON.parse(
			readFileSync(join(dir, "result.json"), "utf8"),
		) as ResultFile;
		expect(json.schema).toBe(RESULT_SCHEMA);
		expect(json.notice).toContain("意味の品質を示さない");
		const c = json.run.conditions;
		expect(c.bun).toBe(Bun.version);
		expect(c.platform.length).toBeGreaterThan(0);
		expect(c.cpuCount).toBeGreaterThan(0);
		const inputs = json.deterministic.inputs;
		for (const entry of [inputs.corpus, inputs.extraction, inputs.questions]) {
			expect(entry.version).toBeGreaterThanOrEqual(1);
			expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(inputs.corpus.unseen.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(inputs.questions.unseen.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(inputs.package.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
		expect(inputs.ports.synthetic).toBe(true);
		for (const m of json.deterministic.methods) {
			expect(m.version.length).toBeGreaterThan(0);
			expect(m.summary.recall).toHaveProperty("at1");
			expect(m.summary.recall).toHaveProperty("at5");
			expect(m.summary.recall).toHaveProperty("at10");
		}
		expect(json.run.latency).toHaveLength(2);
		for (const lat of json.run.latency)
			for (const m of json.deterministic.methods) {
				const l = lat.byMethod[m.id];
				expect(l?.samples).toBe(fixture.questions.length);
				expect(l?.p50Ms).not.toBeNull();
				expect(l?.p95Ms).not.toBeNull();
			}
		expect(json.run.determinism.identical).toBe(true);
	});

	test("report.md carries the notice, the digests and a row for every method", async () => {
		const { dir, file } = await written();
		const md = readFileSync(join(dir, "report.md"), "utf8");
		expect(md).toContain("意味の品質を示さない");
		expect(md).toContain(file.deterministic.inputs.corpus.digest);
		expect(md).toContain(file.deterministic.inputs.extraction.digest);
		expect(md).toContain(file.deterministic.inputs.questions.digest);
		for (const m of file.deterministic.methods) expect(md).toContain(m.label);
		expect(md).toContain("recall@10");
		expect(md).toContain("未見の組");
		expect(md).toBe(renderMarkdown(file));
	});

	test("an existing output directory is never overwritten", async () => {
		const runs = await twoRuns();
		const file = buildResultFile(runs, checkDeterminism(runs));
		const root = tempRoot();
		writeResult(file, root);
		expect(() => writeResult(file, root)).toThrow("output_exists");
	});
});

describe("command line", () => {
	test("options", () => {
		expect(parseArgs([])).toMatchObject({ repeat: 2, search: "package" });
		expect(parseArgs(["--repeat", "3", "--search", "fake"])).toMatchObject({
			repeat: 3,
			search: "fake",
		});
		expect(() => parseArgs(["--repeat", "0"])).toThrow("invalid_option");
		expect(() => parseArgs(["--search", "real"])).toThrow("invalid_option");
		expect(() => parseArgs(["--endpoint", "http://x"])).toThrow(
			"invalid_option",
		);
	});

	test("main writes a result and succeeds when the runs agree", async () => {
		const root = tempRoot();
		const code = await main(["--search", "fake", "--out", root]);
		expect(code).toBe(0);
		const dirs = readdirSync(root);
		expect(dirs).toHaveLength(1);
		expect(existsSync(join(root, dirs[0] ?? "", "result.json"))).toBe(true);
	});
});

describe("ports", () => {
	test("the evaluation code reads no environment variable and opens no connection", () => {
		const dir = import.meta.dir;
		const files = [
			...readdirSync(dir)
				.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
				.map((f) => join(dir, f)),
			join(dir, "..", "eval-search.ts"),
		];
		expect(files.length).toBeGreaterThan(8);
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(
				/process\.env|Bun\.env|import\.meta\.env/,
			);
			expect(source, file).not.toMatch(
				/\bfetch\(|WebSocket|Bun\.serve|\.listen\(|node:net|node:http/,
			);
		}
	});
});
