// `bun run eval:search`: compares the package's search (each route alone and all together) with
// two baselines (FTS trigram only; the substring search of Eumenes' collected-document ledger) on
// a synthetic Japanese corpus ingested through the example host. See p3.md section 6.
//
// The result is a fixture result (synthetic documents, scripted inference, meaningless embeddings):
// it shows that the comparison works, not how good the search is. The ports are the mocks; no
// environment variable names an endpoint and nothing connects anywhere. A real-model run is a
// P6-and-later opt-in that needs a caller-supplied `EvalPorts` (see scripts/eval/ports.ts).
//
// Options:
//   --out <dir>        output root (default verification/eval-search)
//   --repeat <n>       how many times to run for the determinism check (default 2)
//   --search fake      use the minimal stand-in search instead of the package's
import { resolve } from "node:path";
import {
	buildResultFile,
	checkDeterminism,
	DEFAULT_OUTPUT_ROOT,
	writeResult,
} from "./eval/report.js";
import {
	fakeSearchImplementation,
	loadPackageSearch,
	type SearchImplementation,
} from "./eval/package-search.js";
import { runEvaluation, type EvalRun } from "./eval/run.js";

export type CliOptions = {
	out: string;
	repeat: number;
	search: "package" | "fake";
};

export function parseArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		out: DEFAULT_OUTPUT_ROOT,
		repeat: 2,
		search: "package",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === "--out" && value) {
			options.out = resolve(value);
			i += 1;
		} else if (arg === "--repeat" && value) {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 1 || n > 10)
				throw new Error("invalid_option: --repeat takes 1..10");
			options.repeat = n;
			i += 1;
		} else if (
			arg === "--search" &&
			(value === "fake" || value === "package")
		) {
			options.search = value;
			i += 1;
		} else {
			throw new Error(`invalid_option: ${arg ?? ""}`);
		}
	}
	return options;
}

export async function main(argv: readonly string[]): Promise<number> {
	const options = parseArgs(argv);
	let implementation: SearchImplementation | null;
	if (options.search === "fake") implementation = fakeSearchImplementation;
	else implementation = await loadPackageSearch();
	if (!implementation) {
		console.error(
			"package_search_not_available: the package does not export `search` and `createVectorIndex` yet. Run with `--search fake` to check the comparison itself.",
		);
		return 2;
	}
	const runs: EvalRun[] = [];
	for (let i = 0; i < options.repeat; i += 1) {
		runs.push(await runEvaluation({ implementation }));
	}
	const determinism = checkDeterminism(runs);
	const file = buildResultFile(runs, determinism);
	const dir = writeResult(file, options.out);
	console.log(`eval:search: wrote ${dir}`);
	console.log(
		`eval:search: ${determinism.runs} runs, deterministic part ${determinism.identical ? "identical" : "DIFFERENT"} (${determinism.digest.slice(0, 16)})`,
	);
	console.log(`eval:search: ${file.notice}`);
	return determinism.identical ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2)).catch(
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			return 1;
		},
	);
}
