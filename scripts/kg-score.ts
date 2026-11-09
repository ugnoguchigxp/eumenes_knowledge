// `bun scripts/kg-score.ts --judgments <file> <run dir>...`: scores runs on one extraction from
// their databases (kg.md §8.8), all with the same, latest judgments, so the table does not depend
// on when each run was made. For every run directory (knowledge.db, and report.json if present):
//   - the evaluation against expected.json on every name of every mention (`fullGraph`; the graph
//     API answer has at most namesPerNode names per node and can miss an alias in a large node);
//   - the judged pairs whose truth is known: in one node or apart;
//   - the model's `same` links (any instruction but `keys`) and how many of them are judged right.
// Prints a Markdown table and the numbers as JSON; writes nothing. No model is asked.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	CORPUS,
	type Expected,
	evaluate,
	fullGraph,
	pairKey,
	readCorpusFromDb,
	readCurrentLinks,
	readMentions,
	sameNode,
} from "./kg-common.js";

type Truth = "same" | "different" | null;

function parseArgs(argv: readonly string[]) {
	let judgments: string | null = null;
	const dirs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--judgments") {
			const value = argv[++i];
			if (!value) throw new Error("missing value for --judgments");
			judgments = resolve(value);
		} else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else dirs.push(resolve(arg));
	}
	if (!judgments || dirs.length === 0)
		throw new Error("usage: kg-score.ts --judgments <file> <run dir>...");
	for (const d of dirs)
		if (!existsSync(join(d, "knowledge.db")))
			throw new Error(`no knowledge.db in ${basename(d)}`);
	return { judgments, dirs };
}

/** The identity calls of a run, from its report: its own link or vote calls. */
function identityCalls(report: Record<string, unknown> | null): number | null {
	if (!report) return null;
	const r = report as {
		inference?: { link?: { calls?: number } };
		vote?: { inference?: { vote?: { calls?: number } } } | null;
	};
	return r.inference?.link?.calls ?? r.vote?.inference?.vote?.calls ?? 0;
}

const { judgments: file, dirs } = parseArgs(process.argv.slice(2));
const expected = JSON.parse(
	await readFile(join(CORPUS, "expected.json"), "utf8"),
) as Expected;
const pairs = (
	JSON.parse(await readFile(file, "utf8")) as {
		pairs: Record<string, { truth?: Truth }>;
	}
).pairs;

const rows = [];
for (const dir of dirs) {
	const reportFile = join(dir, "report.json");
	const report = existsSync(reportFile)
		? (JSON.parse(await readFile(reportFile, "utf8")) as Record<
				string,
				unknown
			>)
		: null;
	const db = new Database(join(dir, "knowledge.db"), { readonly: true });
	try {
		const { corpus, docIdByPath } = readCorpusFromDb(db, basename(dir));
		const evaluation = evaluate(
			fullGraph(db),
			expected,
			corpus,
			docIdByPath,
		).summary;
		const together = sameNode(db);
		const judged = {
			same: { together: 0, apart: 0 },
			different: { together: 0, apart: 0 },
		};
		for (const [pair, v] of Object.entries(pairs)) {
			if (v.truth !== "same" && v.truth !== "different") continue;
			const [a, b] = pair.split("-").map(Number) as [number, number];
			judged[v.truth][together(a, b) ? "together" : "apart"]++;
		}
		const modelLinks = readCurrentLinks(db, readMentions(db)).filter(
			(l) => l.decision === "same" && l.instruction !== "keys",
		);
		const model = {
			links: modelLinks.length,
			right: 0,
			wrong: 0,
			unknown: 0,
			unjudged: 0,
		};
		for (const l of modelLinks) {
			const v = pairs[pairKey(l.a, l.b)];
			if (!v) model.unjudged++;
			else if (v.truth === "same") model.right++;
			else if (v.truth === "different") model.wrong++;
			else model.unknown++;
		}
		rows.push({
			run: basename(dir),
			identityCalls: identityCalls(report),
			evaluation,
			judged,
			model,
		});
	} finally {
		db.close();
	}
}

const truthCount = (t: Truth) =>
	Object.values(pairs).filter((v) => v.truth === t).length;
console.log(
	`| 実行 | 同一視の LLM 呼出し | 1 ノードにまとまった数 | 被覆 | 関係の再現 | 混ぜてはいけない組 | 2 実体以上のノード | 正解 same の組が同じノード（${truthCount("same")}） | 正解 different の組が同じノード（${truthCount("different")}） | モデルの same のリンク（正しい／誤り／決められない／未判定） |`,
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
	const e = r.evaluation;
	const pct = (x: number | null) => (x === null ? "—" : x.toFixed(2));
	console.log(
		`| ${r.run} | ${r.identityCalls ?? "—"} | ${e.mergedIntoOneNode}/${e.crossDocumentEntities} | ${pct(e.meanBestNodeCoverage)} | ${Math.round((e.relationRecall ?? 0) * expected.relations.length)}/${expected.relations.length} | ${e.distinctViolations} | ${e.impureNodes} | ${r.judged.same.together} | ${r.judged.different.together} | ${r.model.links}（${r.model.right}／${r.model.wrong}／${r.model.unknown}／${r.model.unjudged}） |`,
	);
}
console.log(`\n${JSON.stringify(rows)}`);
