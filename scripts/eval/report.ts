// Writes a run to `verification/eval-search/<UTC time>-<short digest>/` as JSON and Markdown.
// The short digest is the digest of the deterministic part, so two runs on the same inputs
// differ in the time prefix only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetricSummary } from "./metrics.js";
import type {
	DeterministicRecord,
	EvalRun,
	LatencyRecord,
	MethodResult,
	RunConditions,
} from "./run.js";

export const DEFAULT_OUTPUT_ROOT = resolve(
	import.meta.dir,
	"..",
	"..",
	"verification",
	"eval-search",
);

/** JSON with object keys in code-unit order, so equal data gives equal text. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: v,
	);
}

export const deterministicDigest = (record: DeterministicRecord): string =>
	createHash("sha256").update(canonicalJson(record)).digest("hex");

export type Determinism = {
	runs: number;
	/** The deterministic parts of all runs are byte-identical (timings excluded). */
	identical: boolean;
	digest: string;
	digests: string[];
};

export function checkDeterminism(runs: readonly EvalRun[]): Determinism {
	const digests = runs.map((r) => deterministicDigest(r.deterministic));
	return {
		runs: runs.length,
		identical: digests.every((d) => d === digests[0]),
		digest: digests[0] ?? "",
		digests,
	};
}

export type ResultFile = {
	schema: string;
	notice: string;
	/** sha256 of the canonical deterministic part. */
	digest: string;
	deterministic: DeterministicRecord;
	run: {
		conditions: RunConditions;
		determinism: Determinism;
		/** One entry per run, in order. */
		latency: LatencyRecord[];
	};
};

export function buildResultFile(
	runs: readonly EvalRun[],
	determinism: Determinism,
): ResultFile {
	const first = runs[0];
	if (!first) throw new Error("no_runs");
	return {
		schema: first.deterministic.schema,
		notice: first.deterministic.notice,
		digest: determinism.digest,
		deterministic: first.deterministic,
		run: {
			conditions: first.conditions,
			determinism,
			latency: runs.map((r) => r.latency),
		},
	};
}

const pct = (v: number | null) =>
	v === null ? "-" : `${(v * 100).toFixed(1)}%`;
const num = (v: number | null, digits = 1) =>
	v === null ? "-" : v.toFixed(digits);
const ms = (v: number | null) => (v === null ? "-" : v.toFixed(2));

/** `YYYYMMDD-HHMMSS` in UTC. */
export function timestampName(iso: string): string {
	return iso.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function metricRow(
	method: MethodResult,
	summary: MetricSummary,
	latency?: { p50Ms: number | null; p95Ms: number | null },
): string {
	const cells = `| ${method.label} | ${pct(summary.recall.at1)} | ${pct(summary.recall.at5)} | ${pct(summary.recall.at10)} | ${pct(summary.found)} | ${num(summary.medianTopRank)} | ${num(summary.meanReciprocalRank, 3)} | ${pct(summary.noAnswer.emptyRate)} | ${pct(summary.partialRate)} |`;
	return latency
		? `${cells} ${ms(latency.p50Ms)} / ${ms(latency.p95Ms)} |`
		: cells;
}

const TABLE_HEAD = `| 方式 | recall@1 | recall@5 | recall@10 | 見つかった | 最上位の順位（中央値） | MRR | 正解なしで空 | partial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`;
const TABLE_HEAD_LATENCY = `${TABLE_HEAD.split("\n")[0]} 遅延 p50 / p95 (ms) |
${TABLE_HEAD.split("\n")[1]} ---: |`;

export function renderMarkdown(file: ResultFile): string {
	const d = file.deterministic;
	const c = file.run.conditions;
	const latency = file.run.latency[file.run.latency.length - 1];
	const lat = (id: string) => latency?.byMethod[id];
	const lines: string[] = [];
	const push = (...l: string[]) => lines.push(...l);

	push(
		"# 検索の比較評価（eval:search）",
		"",
		`> **${file.notice}**`,
		"",
		`結果の digest: \`${file.digest}\``,
		"",
		"## 実行条件",
		"",
		"| 項目 | 値 |",
		"| --- | --- |",
		`| 開始 | ${c.startedAt} |`,
		`| Bun | ${c.bun} |`,
		`| マシン | ${c.platform} ${c.arch} ${c.osRelease} / ${c.cpuModel} x ${c.cpuCount} / ${c.memoryGiB} GiB |`,
		`| パッケージ | ${d.inputs.package.name} ${d.inputs.package.version} |`,
		`| 検索の実装 | ${d.inputs.search.source} |`,
		`| ports | ${d.inputs.ports.label}（合成: ${d.inputs.ports.synthetic ? "はい" : "いいえ"}） |`,
		`| 主体の namespace | ${d.inputs.principal.namespaces.join(", ")} |`,
		`| 1 質問あたりの取得上限 | ${d.inputs.fetchLimit} |`,
		"",
		"## 入力の版と digest",
		"",
		"| 入力 | 版 | 件数 | digest |",
		"| --- | ---: | ---: | --- |",
		`| 資料（全体） | ${d.inputs.corpus.version} | ${d.inputs.corpus.seen.count + d.inputs.corpus.unseen.count} | \`${d.inputs.corpus.digest}\` |`,
		`| 資料（既知の組） | ${d.inputs.corpus.version} | ${d.inputs.corpus.seen.count} | \`${d.inputs.corpus.seen.digest}\` |`,
		`| 資料（未見の組） | ${d.inputs.corpus.version} | ${d.inputs.corpus.unseen.count} | \`${d.inputs.corpus.unseen.digest}\` |`,
		`| 台本（抽出の応答） | ${d.inputs.extraction.version} | - | \`${d.inputs.extraction.digest}\` |`,
		`| 質問（全体） | ${d.inputs.questions.version} | ${d.inputs.questions.seen.count + d.inputs.questions.unseen.count} | \`${d.inputs.questions.digest}\` |`,
		`| 質問（既知の組） | ${d.inputs.questions.version} | ${d.inputs.questions.seen.count} | \`${d.inputs.questions.seen.digest}\` |`,
		`| 質問（未見の組） | ${d.inputs.questions.version} | ${d.inputs.questions.unseen.count} | \`${d.inputs.questions.unseen.digest}\` |`,
		"",
		`質問の種類（実行した ${d.inputs.questionsAsked} 件）: ${Object.entries(
			d.inputs.questionKinds,
		)
			.map(([k, n]) => `${k} ${n}`)
			.join(", ")}`,
		"",
		"## 取り込み",
		"",
		"| 項目 | 値 |",
		"| --- | ---: |",
		`| 文書 | ${d.ingest.documents} |`,
		`| 断片 | ${d.ingest.fragments} |`,
		`| 推論の呼出し（取り込み時） | ${d.ingest.inferenceCalls}（抽出 ${d.ingest.extractionCalls}、同一視・要約 ${d.ingest.linkCalls}） |`,
		`| 埋め込みの呼出し（取り込み時） | ${d.ingest.embeddingCalls}（${d.ingest.embeddingTexts} 文） |`,
		`| 台本の対象 / 関係 | ${d.ingest.scriptedEntities} / ${d.ingest.scriptedRelations} |`,
		"",
		"## 方式と版",
		"",
		"| 方式 | id | 版 |",
		"| --- | --- | --- |",
		...d.methods.map((m) => `| ${m.label} | \`${m.id}\` | \`${m.version}\` |`),
		"",
		"## 全質問",
		"",
		"recall は正解文書のうち上位 k 件の文書に入った割合の平均（正解のある質問だけ）。「正解なしで空」は、正解のない質問で何も返さなかった割合。partial は `complete: false` で答えた割合（基準は完全性を持たないため `-`）。",
		"",
		"取得の深さは方式によって違う。本パッケージと基準 1 は 1 質問あたり最大 `取得上限` 件の**断片**を返し、それを文書に重複排除して順位を付ける（同じ文書の断片が多いと、上位 10 件に届く文書が 10 件より少なくなり、recall@10 で不利になり得る）。基準 2 は最大 `取得上限` 件の**文書**を返す。",
		"",
		"推論の呼出し（検索時）は、本パッケージの検索が推論を呼ばない設計のため構造上 0 であり、実測値ではない。",
		"",
		TABLE_HEAD_LATENCY,
		...d.methods.map((m) => metricRow(m, m.summary, lat(m.id))),
		"",
	);

	for (const set of ["seen", "unseen"] as const) {
		const heading =
			set === "seen"
				? "## 既知の組の質問（資料を見て作った質問）"
				: "## 未見の組の質問（語句・対象・場面を変えた資料と質問）";
		push(heading, "", TABLE_HEAD);
		for (const m of d.methods) {
			const s = m.bySet[set];
			if (s) push(metricRow(m, s));
		}
		push("");
	}

	push(
		"## 質問の種類ごとの recall@10",
		"",
		`| 方式 | ${Object.keys(d.inputs.questionKinds).join(" | ")} |`,
		`| --- | ${Object.keys(d.inputs.questionKinds)
			.map(() => "---:")
			.join(" | ")} |`,
	);
	for (const m of d.methods) {
		push(
			`| ${m.label} | ${Object.keys(d.inputs.questionKinds)
				.map((kind) => {
					const s = m.byKind[kind];
					if (!s) return "-";
					return s.answerable === 0
						? `空 ${pct(s.noAnswer.emptyRate)}`
						: pct(s.recall.at10);
				})
				.join(" | ")} |`,
		);
	}
	push("", "（no_answer の列は、何も返さなかった割合。）", "");

	push(
		"## 推論と埋め込みの呼出し数",
		"",
		"取り込み時は全方式で共通（1 回の取り込み）。検索時は方式ごとに、全質問の合計。検索は推論の port を受け取らないため、検索時の推論は 0 件。",
		"",
		"| 方式 | 検索時の推論 | 検索時の埋め込み（呼出し / 文） |",
		"| --- | ---: | ---: |",
		...d.methods.map(
			(m) =>
				`| ${m.label} | ${m.searchCalls.inference} | ${m.searchCalls.embedding.calls} / ${m.searchCalls.embedding.texts} |`,
		),
		"",
	);

	const reporting = d.methods.filter(
		(m) => Object.keys(m.lexicalModes).length > 0,
	);
	if (reporting.length > 0) {
		push(
			"## 本パッケージの応答の自己申告",
			"",
			"| 方式 | lexicalMode | partialReasons | 経路の状態 |",
			"| --- | --- | --- | --- |",
			...reporting.map(
				(m) =>
					`| ${m.label} | ${fmtCounts(m.lexicalModes)} | ${fmtCounts(m.partialReasons)} | ${fmtCounts(m.routeStatuses)} |`,
			),
			"",
		);
	}

	push(
		"## 決定性",
		"",
		`同じ入力で ${file.run.determinism.runs} 回実行し、遅延と実行条件を除く結果が${file.run.determinism.identical ? "一致した" : "**一致しなかった**"}。`,
		"",
		"## 読むときの注意",
		"",
		"- 資料・台本・質問はすべて合成で、推論の応答は台本（呼出し順で選ぶ）、埋め込みは意味を持たないハッシュ。結果は意味の品質を示さない。",
		"- vector 経路は、意味を持たない埋め込みでは偶然以上のことができず、どの質問にも候補を返す（だから統合は「正解なし」の質問で空にならない）。vector の recall が偶然の水準（文書数に対する k の割合）に近いときは、意味のある一致ではない。semantic の質問は、実モデルでの比較のための枠として置いてある。",
		"- entity・relation 経路の質問は、台本が書いた対象・関係の語句を引く。台本は著者が書いたもので、モデルの出力の性質を示さない。",
		"- 基準 2 は SQLite の `lower()`（ASCII のみ）と `instr` で、NFKC もかな漢字の対応も行わない。基準 1 は NFKC と小文字化のあと trigram で引き、3 文字未満の語は引けない。",
		"- 遅延は 1 質問ずつ順に測った 1 回分の実時間で、実行環境によって変わる。決定性の確認には含めない。",
		"",
	);
	return `${lines.join("\n")}\n`;
}

const fmtCounts = (record: Record<string, number>) =>
	Object.keys(record).length === 0
		? "-"
		: Object.entries(record)
				.map(([k, n]) => `${k} ${n}`)
				.join(", ");

/** Writes `result.json` and `report.md` into a new directory under `root`; never overwrites. */
export function writeResult(
	file: ResultFile,
	root = DEFAULT_OUTPUT_ROOT,
): string {
	const dir = join(
		root,
		`${timestampName(file.run.conditions.startedAt)}-${file.digest.slice(0, 8)}`,
	);
	if (existsSync(dir)) throw new Error(`output_exists: ${dir}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "result.json"), `${JSON.stringify(file, null, 2)}\n`);
	writeFileSync(join(dir, "report.md"), renderMarkdown(file));
	return dir;
}
