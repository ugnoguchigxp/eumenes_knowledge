// `bun scripts/kg-heldout.ts measure --notes <dir> --out <dir> [--js-modules <dir>] [--sample <n>] [--seed <n>]`
// `bun scripts/kg-heldout.ts score --out <dir> --results <judgments.json>`
//
// The held-out check of kg2.md §7.10–7.11 (C, S4): a person's own notes, which no rule was made
// from, read by the model-free extractor with each tokenizer. Nothing is ingested and no model is
// asked. The notes and what is drawn from them never enter the repository: `--notes` and `--out`
// must lie outside it, and only the numbers of summary.json and score.json are meant to be
// recorded (kg2.md).
//
// measure writes to --out:
//   summary.json  numbers per tokenizer (documents, size, time, names, proper shares, pairs)
//   sample.json   the drawn names and edges with their sentences (personal: stays local)
//   judge.html    a page to judge them in a browser, from disk (personal: stays local)
// The sample is drawn from the last tokenizer (sudachi-napi when --js-modules is given): names
// written in Japanese alone that it takes for proper names, and pairs of two proper names of one
// sentence. A fixed seed draws the same sample from the same notes.
//
// score reads the page's export and writes score.json: the share of proper names among the names
// judged (S4: 70 % or more), and the edges' A/B/C, with Wilson 95 % intervals.
//
// sudachi-napi needs NAPI_SUDACHI_ROOT and SUDACHI_DICT_PATH in the environment (kg-alt).

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { TokenizerPort } from "../src/contracts/ports.js";
import {
	extractNames,
	fragmentStructures,
	NAME_TYPES,
} from "../src/core/extract/index.js";
import { chunkMarkdown } from "../src/core/text/index.js";
import { type Engine, loadTokenizer } from "./kg-alt/candidates.js";
import {
	EDGE_CHOICES,
	type JudgeItem,
	judgePage,
	NAME_CHOICES,
} from "./kg-heldout/page.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** Written in Japanese alone: a kana or kanji, and no ASCII letter. */
export const japaneseOnly = (name: string): boolean =>
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name) &&
	!/[A-Za-z]/.test(name);

/** The path, symbolic links resolved as far as they exist. */
function real(path: string): string {
	const abs = resolve(path);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

/** Whether `path` is the repository or inside it (personal notes and samples must not be). */
export function insideRepository(path: string, repo = REPO): boolean {
	const rel = relative(real(repo), real(path));
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
	);
}

/** Markdown files under `dir`, sorted; hidden directories and node_modules are skipped. */
export function listNotes(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
				out.push(p);
		}
	};
	walk(dir);
	return out.sort();
}

/** A seeded generator (mulberry32): the same seed draws the same sample. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function draw<T>(items: readonly T[], n: number, seed: number): T[] {
	const next = random(seed);
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
	}
	return copy.slice(0, n);
}

type NameSeen = {
	key: string;
	name: string;
	proper: boolean;
	documents: Set<number>;
	sentence: string;
};
type PairSeen = {
	key: string;
	source: string;
	target: string;
	japanese: boolean;
	documents: Set<number>;
	sentence: string;
};

/** Every name and every pair of two proper names one tokenizer finds in the notes. */
function read(
	docs: readonly { text: string }[],
	tokenizer: TokenizerPort,
): {
	ms: number;
	fragments: number;
	mentions: number;
	names: Map<string, NameSeen>;
	pairs: Map<string, PairSeen>;
	truncatedDocuments: number;
} {
	const names = new Map<string, NameSeen>();
	const pairs = new Map<string, PairSeen>();
	let fragments = 0;
	let mentions = 0;
	let truncatedDocuments = 0;
	const t0 = performance.now();
	docs.forEach((doc, d) => {
		const bytes = Buffer.from(doc.text, "utf8");
		const frags = chunkMarkdown(bytes, doc.text);
		if (frags.length === 0) return;
		const structures = fragmentStructures(frags.map((f) => f.text));
		let truncated = false;
		frags.forEach((fragment, i) => {
			fragments += 1;
			const x = extractNames(fragment, tokenizer, structures[i]);
			if (x.status !== "ok") return;
			if (x.dropped.some((r) => r.reason === "proper_over_limit"))
				truncated = true;
			const quote = (e: { byteStart: number; byteEnd: number }) =>
				bytes.subarray(e.byteStart, e.byteEnd).toString("utf8");
			const byId = new Map(x.entities.map((e) => [e.id, e]));
			// The model-free extractor keys every entity; the name stands in for a missing key.
			const keyOf = (e: { key?: string; name: string }) => e.key ?? e.name;
			for (const e of x.entities) {
				mentions += 1;
				const proper = e.type === NAME_TYPES.proper;
				const seen = names.get(keyOf(e));
				if (seen) {
					seen.proper ||= proper;
					seen.documents.add(d);
				} else {
					names.set(keyOf(e), {
						key: keyOf(e),
						name: e.name,
						proper,
						documents: new Set([d]),
						sentence: e.evidence[0] ? quote(e.evidence[0]) : "",
					});
				}
			}
			for (const r of x.relations) {
				const a = byId.get(r.source);
				const b = byId.get(r.target);
				if (!a || !b) continue;
				if (a.type !== NAME_TYPES.proper || b.type !== NAME_TYPES.proper)
					continue;
				const [s, t] = keyOf(a) < keyOf(b) ? [a, b] : [b, a];
				const key = `${keyOf(s)}\u0000${keyOf(t)}`;
				const seen = pairs.get(key);
				if (seen) seen.documents.add(d);
				else
					pairs.set(key, {
						key,
						source: s.name,
						target: t.name,
						japanese: japaneseOnly(s.name) && japaneseOnly(t.name),
						documents: new Set([d]),
						sentence: r.evidence[0] ? quote(r.evidence[0]) : "",
					});
			}
		});
		if (truncated) truncatedDocuments += 1;
	});
	return {
		ms: performance.now() - t0,
		fragments,
		mentions,
		names,
		pairs,
		truncatedDocuments,
	};
}

const share = (n: number, d: number) => (d === 0 ? null : +(n / d).toFixed(3));

export type MeasureOptions = {
	notes: string;
	out: string;
	tokenizers: { engine: Engine; tokenizer: TokenizerPort }[];
	sample?: number;
	seed?: number;
};

export function measure(options: MeasureOptions): {
	summary: Record<string, unknown>;
	items: JudgeItem[];
} {
	const { notes, out } = options;
	if (insideRepository(notes) || insideRepository(out))
		throw new Error(
			"--notes and --out must lie outside the repository (personal notes)",
		);
	const files = listNotes(notes);
	if (files.length === 0) throw new Error("--notes holds no Markdown file");
	// A file that is not UTF-8 is left out (counted): the package refuses it as well.
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const docs: { text: string }[] = [];
	let skipped = 0;
	for (const f of files) {
		try {
			docs.push({ text: decoder.decode(readFileSync(f)) });
		} catch {
			skipped += 1;
		}
	}
	const bytes = docs.reduce((n, d) => n + Buffer.byteLength(d.text, "utf8"), 0);
	const n = options.sample ?? 40;
	const seed = options.seed ?? 1;

	const perTokenizer: Record<string, unknown> = {};
	let last: ReturnType<typeof read> | null = null;
	for (const { engine, tokenizer } of options.tokenizers) {
		const r = read(docs, tokenizer);
		last = r;
		const all = [...r.names.values()];
		const ja = all.filter((x) => japaneseOnly(x.name));
		const pairs = [...r.pairs.values()];
		perTokenizer[engine] = {
			msPerMb: Math.round(r.ms / (bytes / 1e6)),
			fragments: r.fragments,
			mentions: r.mentions,
			names: all.length,
			properShare: share(all.filter((x) => x.proper).length, all.length),
			namesInTwoDocumentsOrMore: all.filter((x) => x.documents.size >= 2)
				.length,
			properInTwoDocumentsOrMore: all.filter(
				(x) => x.proper && x.documents.size >= 2,
			).length,
			japaneseOnlyNames: ja.length,
			japaneseOnlyProper: ja.filter((x) => x.proper).length,
			properPairs: pairs.length,
			japaneseProperPairs: pairs.filter((p) => p.japanese).length,
			truncatedDocuments: r.truncatedDocuments,
		};
	}
	if (!last) throw new Error("no tokenizer");

	const names = draw(
		[...last.names.values()]
			.filter((x) => x.proper && japaneseOnly(x.name) && x.sentence)
			.sort((x, y) => (x.key < y.key ? -1 : 1)),
		n,
		seed,
	);
	const edges = draw(
		[...last.pairs.values()]
			.filter((p) => p.sentence)
			.sort((x, y) => (x.key < y.key ? -1 : 1)),
		n,
		seed + 1,
	);
	const items: JudgeItem[] = [
		...names.map((x, i) => ({
			id: `n${i + 1}`,
			kind: "name" as const,
			name: x.name,
			sentence: x.sentence,
		})),
		...edges.map((p, i) => ({
			id: `e${i + 1}`,
			kind: "edge" as const,
			source: p.source,
			target: p.target,
			sentence: p.sentence,
		})),
	];
	const sampleDigest = createHash("sha256")
		.update(JSON.stringify(items))
		.digest("hex")
		.slice(0, 16);
	const summary = {
		kind: "kg-heldout",
		documents: docs.length,
		skippedFiles: skipped,
		mb: +(bytes / 1e6).toFixed(3),
		seed,
		sampleFrom: options.tokenizers.at(-1)?.engine,
		sampledNames: names.length,
		sampledEdges: edges.length,
		sampleDigest,
		tokenizers: perTokenizer,
	};
	mkdirSync(out, { recursive: true });
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	writeFileSync(
		join(out, "sample.json"),
		`${JSON.stringify({ sampleDigest, items }, null, 1)}\n`,
	);
	writeFileSync(join(out, "judge.html"), judgePage(sampleDigest, items));
	return { summary, items };
}

/** Wilson 95 % interval of k in n. */
export function wilson(k: number, n: number): [number, number] | null {
	if (n === 0) return null;
	const z = 1.96;
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [+((c - m) / d).toFixed(3), +((c + m) / d).toFixed(3)];
}

export function score(
	out: string,
	resultsPath: string,
): Record<string, unknown> {
	const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as {
		sampleDigest: string;
		items: JudgeItem[];
	};
	const results = JSON.parse(readFileSync(resultsPath, "utf8")) as {
		sampleDigest?: unknown;
		judgments?: Record<string, unknown>;
	};
	if (results.sampleDigest !== sample.sampleDigest)
		throw new Error("the results are of another sample");
	const judged = results.judgments ?? {};
	const count = (
		kind: JudgeItem["kind"],
		choices: readonly string[],
	): Record<string, number> => {
		const c: Record<string, number> = Object.fromEntries(
			choices.map((x) => [x, 0]),
		);
		let unjudged = 0;
		for (const item of sample.items.filter((i) => i.kind === kind)) {
			const v = judged[item.id];
			if (typeof v === "string" && choices.includes(v)) c[v] = (c[v] ?? 0) + 1;
			else unjudged += 1;
		}
		return { ...c, unjudged };
	};
	const names = count("name", NAME_CHOICES);
	const edges = count("edge", EDGE_CHOICES);
	const decided = (names.proper ?? 0) + (names.not_proper ?? 0);
	const edgeDecided = (edges.A ?? 0) + (edges.B ?? 0) + (edges.C ?? 0);
	const result = {
		kind: "kg-heldout-score",
		sampleDigest: sample.sampleDigest,
		names: {
			...names,
			properShare: share(names.proper ?? 0, decided),
			wilson95: wilson(names.proper ?? 0, decided),
			s4Passed: decided > 0 ? (names.proper ?? 0) / decided >= 0.7 : null,
		},
		edges: {
			...edges,
			cShare: share(edges.C ?? 0, edgeDecided),
			cWilson95: wilson(edges.C ?? 0, edgeDecided),
		},
	};
	writeFileSync(
		join(out, "score.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	return result;
}

function option(args: string[], name: string): string | null {
	const i = args.indexOf(name);
	if (i < 0) return null;
	const v = args[i + 1];
	if (v === undefined || v.startsWith("--"))
		throw new Error(`${name} needs a value`);
	return v;
}

async function main(args: string[]) {
	const [command, ...rest] = args;
	const out = option(rest, "--out");
	if (!out) throw new Error("--out <dir> is required (outside the repository)");
	if (command === "measure") {
		const notes = option(rest, "--notes");
		if (!notes || !statSync(notes).isDirectory())
			throw new Error("--notes <dir> is required");
		const modules = option(rest, "--js-modules");
		const engines: Engine[] = modules
			? ["charclass", "sudachi-napi"]
			: ["charclass"];
		const tokenizers = [];
		for (const engine of engines)
			tokenizers.push({
				engine,
				tokenizer: await loadTokenizer(engine, modules),
			});
		const sample = option(rest, "--sample");
		const seed = option(rest, "--seed");
		const { summary } = measure({
			notes,
			out,
			tokenizers,
			...(sample ? { sample: Number(sample) } : {}),
			...(seed ? { seed: Number(seed) } : {}),
		});
		console.log(JSON.stringify(summary, null, 2));
		console.log(`judge: ${join(resolve(out), "judge.html")}`);
	} else if (command === "score") {
		const results = option(rest, "--results");
		if (!results) throw new Error("--results <judgments.json> is required");
		console.log(JSON.stringify(score(out, results), null, 2));
	} else {
		throw new Error("usage: kg-heldout.ts measure|score ...");
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
