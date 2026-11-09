// `bun scripts/kg-heldout.ts measure --notes <dir> --out <dir> [--js-modules <dir>] [--sample <n>] [--seed <n>]`
// `bun scripts/kg-heldout.ts edges --notes <dir> --out <dir> [--seed <n>]`
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
// edges (kg2.md §7.13) scores the pairs of names of one sentence by document NPMI (in 3 documents
// or more, no hub at either end), and writes the best 40 and 40 drawn at random from the pairs of
// 2 documents or more, mixed, to judge (charclass; sample.json keeps which set each is of).
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
	type EdgeTexts,
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
/** Any two names of one sentence (an edge of the graph today), with a sentence per document. */
type AnyPairSeen = {
	key: string;
	sourceKey: string;
	targetKey: string;
	source: string;
	target: string;
	documents: Set<number>;
	/** The first sentence of each document, for the first `PAIR_SENTENCES` documents. */
	sentences: Map<number, string>;
};
const PAIR_SENTENCES = 2;

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
	anyPairs: Map<string, AnyPairSeen>;
	truncatedDocuments: number;
} {
	const names = new Map<string, NameSeen>();
	const pairs = new Map<string, PairSeen>();
	const anyPairs = new Map<string, AnyPairSeen>();
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
				{
					const [s, t] = keyOf(a) < keyOf(b) ? [a, b] : [b, a];
					const key = `${keyOf(s)}\u0000${keyOf(t)}`;
					let seen = anyPairs.get(key);
					if (!seen) {
						seen = {
							key,
							sourceKey: keyOf(s),
							targetKey: keyOf(t),
							source: s.name,
							target: t.name,
							documents: new Set(),
							sentences: new Map(),
						};
						anyPairs.set(key, seen);
					}
					seen.documents.add(d);
					if (
						r.evidence[0] &&
						!seen.sentences.has(d) &&
						seen.sentences.size < PAIR_SENTENCES
					)
						seen.sentences.set(d, quote(r.evidence[0]));
				}
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
		anyPairs,
		truncatedDocuments,
	};
}

const share = (n: number, d: number) => (d === 0 ? null : +(n / d).toFixed(3));

/** The Markdown notes under `notes`; a file that is not UTF-8 is left out (counted), as the package refuses it. */
function readNotes(notes: string): {
	docs: { text: string }[];
	skipped: number;
	bytes: number;
} {
	const files = listNotes(notes);
	if (files.length === 0) throw new Error("--notes holds no Markdown file");
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
	return { docs, skipped, bytes };
}

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
	const { docs, skipped, bytes } = readNotes(notes);
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

/** The texts of the page for deep edges (kg2.md §7.13). */
export const DEEP_EDGE_TEXTS: EdgeTexts = {
	heading: "辺（同じ文に出た 2 つの名前）",
	legend: [
		"A: 関係が深い（文が 2 つの関係を述べている。一方が他方の部品・道具・担当・対象など）",
		"B: 一緒に出るが、関係は浅い（並べているだけ）",
		"C: 誤り（名前がおかしい、雑音）",
	],
	buttons: ["A 関係が深い", "B 浅い", "C 誤り"],
};

export type EdgeOptions = {
	notes: string;
	out: string;
	tokenizer: TokenizerPort;
	sample?: number;
	seed?: number;
	/** Documents a pair must share to be scored. Default 3. */
	minDocuments?: number;
	/** A name in more than this share of the documents is a hub: no pair of it is scored. Default 0.1. */
	hubShare?: number;
};

/**
 * Pairs scored by document NPMI (kg2.md §7.13): of the pairs of names of one sentence in
 * `minDocuments` documents or more whose ends are no hub, the best `sample`; and as many drawn at
 * random from the pairs of 2 documents or more (the graph's filter today), never the same pair.
 * Both are mixed in one page; which set an item is of is kept in sample.json only.
 */
export function drawEdges(options: EdgeOptions): {
	summary: Record<string, unknown>;
	items: JudgeItem[];
	sets: Record<string, "top" | "random">;
} {
	const { notes, out } = options;
	if (insideRepository(notes) || insideRepository(out))
		throw new Error(
			"--notes and --out must lie outside the repository (personal notes)",
		);
	const { docs, skipped, bytes } = readNotes(notes);
	const n = options.sample ?? 40;
	const seed = options.seed ?? 1;
	const minDocuments = options.minDocuments ?? 3;
	const hubShare = options.hubShare ?? 0.1;
	const r = read(docs, options.tokenizer);
	const N = docs.length;
	const docsOf = (key: string) => r.names.get(key)?.documents.size ?? 0;
	const hub = (key: string) => docsOf(key) > hubShare * N;
	const npmi = (p: AnyPairSeen): number => {
		const ab = p.documents.size;
		if (ab >= N) return 1;
		return (
			Math.log((ab * N) / (docsOf(p.sourceKey) * docsOf(p.targetKey))) /
			-Math.log(ab / N)
		);
	};
	const all = [...r.anyPairs.values()].sort((x, y) =>
		x.key < y.key ? -1 : x.key > y.key ? 1 : 0,
	);
	const candidates = all
		.filter(
			(p) =>
				p.documents.size >= minDocuments &&
				!hub(p.sourceKey) &&
				!hub(p.targetKey),
		)
		.map((p) => ({ p, score: npmi(p) }))
		.sort(
			(x, y) =>
				y.score - x.score ||
				y.p.documents.size - x.p.documents.size ||
				(x.p.key < y.p.key ? -1 : 1),
		);
	const top = candidates.slice(0, n);
	const topKeys = new Set(top.map((c) => c.p.key));
	const random = draw(
		all.filter((p) => p.documents.size >= 2 && !topKeys.has(p.key)),
		n,
		seed,
	);
	const mixed = draw(
		[
			...top.map((c) => ({ p: c.p, set: "top" as const })),
			...random.map((p) => ({ p, set: "random" as const })),
		],
		top.length + random.length,
		seed + 7,
	);
	const sets: Record<string, "top" | "random"> = {};
	const items: JudgeItem[] = mixed.map(({ p, set }, i) => {
		const id = `e${i + 1}`;
		sets[id] = set;
		return {
			id,
			kind: "edge",
			source: p.source,
			target: p.target,
			sentence: [...p.sentences.values()].join("\n――\n"),
		};
	});
	const sampleDigest = createHash("sha256")
		.update(JSON.stringify(items))
		.digest("hex")
		.slice(0, 16);
	const summary = {
		kind: "kg-heldout-edges",
		documents: N,
		skippedFiles: skipped,
		mb: +(bytes / 1e6).toFixed(3),
		seed,
		minDocuments,
		hubShare,
		names: r.names.size,
		hubs: [...r.names.keys()].filter(hub).length,
		pairs: all.length,
		pairsInTwoDocumentsOrMore: all.filter((p) => p.documents.size >= 2).length,
		pairsInMinDocumentsOrMore: all.filter(
			(p) => p.documents.size >= minDocuments,
		).length,
		candidates: candidates.length,
		topScores: top.length
			? [+(top[0]?.score ?? 0).toFixed(3), +(top.at(-1)?.score ?? 0).toFixed(3)]
			: [],
		sampledTop: top.length,
		sampledRandom: random.length,
		sampleDigest,
	};
	mkdirSync(out, { recursive: true });
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	writeFileSync(
		join(out, "sample.json"),
		`${JSON.stringify({ sampleDigest, items, sets }, null, 1)}\n`,
	);
	writeFileSync(
		join(out, "judge.html"),
		judgePage(sampleDigest, items, DEEP_EDGE_TEXTS),
	);
	return { summary, items, sets };
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
		/** kg2.md §7.13: which set each edge is of. */
		sets?: Record<string, string>;
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
		set?: string,
	): Record<string, number> => {
		const c: Record<string, number> = Object.fromEntries(
			choices.map((x) => [x, 0]),
		);
		let unjudged = 0;
		for (const item of sample.items.filter(
			(i) =>
				i.kind === kind && (set === undefined || sample.sets?.[i.id] === set),
		)) {
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
		// kg2.md §7.13: the best pairs pass with A 20 or more and C 6 or fewer of 40.
		...(sample.sets
			? {
					sets: Object.fromEntries(
						["top", "random"].map((set) => {
							const c = count("edge", EDGE_CHOICES, set);
							const decidedInSet = (c.A ?? 0) + (c.B ?? 0) + (c.C ?? 0);
							return [
								set,
								{
									...c,
									aShare: share(c.A ?? 0, decidedInSet),
									aWilson95: wilson(c.A ?? 0, decidedInSet),
									cShare: share(c.C ?? 0, decidedInSet),
									...(set === "top"
										? { passed: (c.A ?? 0) >= 20 && (c.C ?? 0) <= 6 }
										: {}),
								},
							];
						}),
					),
				}
			: {}),
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
	} else if (command === "edges") {
		const notes = option(rest, "--notes");
		if (!notes || !statSync(notes).isDirectory())
			throw new Error("--notes <dir> is required");
		const seed = option(rest, "--seed");
		const { summary } = drawEdges({
			notes,
			out,
			tokenizer: await loadTokenizer("charclass", null),
			...(seed ? { seed: Number(seed) } : {}),
		});
		console.log(JSON.stringify(summary, null, 2));
		console.log(`judge: ${join(resolve(out), "judge.html")}`);
	} else if (command === "score") {
		const results = option(rest, "--results");
		if (!results) throw new Error("--results <judgments.json> is required");
		console.log(JSON.stringify(score(out, results), null, 2));
	} else {
		throw new Error("usage: kg-heldout.ts measure|edges|score ...");
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
