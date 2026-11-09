import { describe, expect, test } from "bun:test";
import type {
	EvidenceRange,
	FragmentExtraction,
} from "../../contracts/index-data.js";
import type { TokenizerPort } from "../../contracts/ports.js";
import { sha256Hex } from "../bytes.js";
import {
	extractNames,
	NAME_TYPES,
	NAMES_LIMITS,
	SAME_SENTENCE_RELATION,
	TokenizerFailure,
} from "./extract-names.js";
import { createCharclassTokenizer } from "./names.js";

const charclass = createCharclassTokenizer();
const BYTE_START = 100;
const fragmentOf = (text: string) => ({
	ordinal: 3,
	byteStart: BYTE_START,
	text,
});
const ok = (x: FragmentExtraction) => {
	if (x.status !== "ok") throw new Error("expected an ok extraction");
	return x;
};
const extract = (text: string) => ok(extractNames(fragmentOf(text), charclass));

/** The quotation the evidence points at, read from the fragment's bytes and checked by its hash. */
function quoteAt(text: string, e: EvidenceRange): string {
	const bytes = Buffer.from(text, "utf8").subarray(
		e.byteStart - BYTE_START,
		e.byteEnd - BYTE_START,
	);
	expect(e.fragmentOrdinal).toBe(3);
	expect(sha256Hex(bytes)).toBe(e.quoteSha256);
	const quote = bytes.toString("utf8");
	// The bytes are whole characters: they encode back to themselves.
	expect(Buffer.from(quote, "utf8").equals(bytes)).toBe(true);
	return quote;
}
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("model-free extraction of one fragment", () => {
	test("names as entities, the model string, the types; the quotation is the sentence", () => {
		const text = "# 設計\nLantern と ＭｙＳＱＬ を使う。\n\n日本語の説明。";
		const x = extract(text);
		expect(x.model).toBe("names:charclass@rules5");
		expect(x.fragmentOrdinal).toBe(3);
		expect(x.dropped).toEqual([]);
		expect(
			x.entities.map((e) => [e.id, e.name, e.type, e.description]),
		).toEqual([
			["e1", "設計", NAME_TYPES.noun, ""],
			["e2", "Lantern", NAME_TYPES.proper, ""],
			// As written in the original text, full width.
			["e3", "ＭｙＳＱＬ", NAME_TYPES.proper, ""],
			["e4", "日本語", NAME_TYPES.noun, ""],
			["e5", "説明", NAME_TYPES.noun, ""],
		]);
		const quotes = x.entities.map((e) =>
			e.evidence.map((v) => quoteAt(text, v)),
		);
		expect(quotes).toEqual([
			["# 設計"],
			["Lantern と ＭｙＳＱＬ を使う。"],
			["Lantern と ＭｙＳＱＬ を使う。"],
			["日本語の説明。"],
			["日本語の説明。"],
		]);
	});

	test("two names in one sentence are one undirected relation 同じ文, never across sentences", () => {
		const text =
			"Lantern と MySQL を使う。Mira Okafor が書いた！ 次は Lantern と Mira Okafor。";
		const x = extract(text);
		const name = new Map(x.entities.map((e) => [e.id, e.name]));
		// 「使」「書」「次」 are one character each: no name.
		expect(x.entities.map((e) => e.name)).toEqual([
			"Lantern",
			"MySQL",
			"Mira Okafor",
		]);
		const relations = x.relations.map((r) => ({
			pair: [name.get(r.source), name.get(r.target)],
			quotes: r.evidence.map((v) => quoteAt(text, v)),
		}));
		expect(relations).toEqual([
			{ pair: ["Lantern", "MySQL"], quotes: ["Lantern と MySQL を使う。"] },
			{
				pair: ["Lantern", "Mira Okafor"],
				quotes: ["次は Lantern と Mira Okafor。"],
			},
		]);
		for (const r of x.relations) {
			expect(r.relation).toBe(SAME_SENTENCE_RELATION);
			expect(r.directed).toBe(false);
			expect(r.description).toBe("");
			expect(r.keywords).toEqual([]);
			expect(r.qualifiers).toEqual({
				negated: false,
				condition: null,
				certainty: "stated",
			});
		}
	});

	test("one entity per name; a sentence once per entity; a repeated sentence is ambiguous", () => {
		const text = "Lantern を使う。Lantern を使う。Lantern と Lantern。";
		const x = extract(text);
		expect(x.entities).toHaveLength(1);
		const [lantern] = x.entities;
		expect(
			lantern?.evidence.map((v) => [quoteAt(text, v), v.ambiguous]),
		).toEqual([
			["Lantern を使う。", true],
			["Lantern を使う。", true],
			["Lantern と Lantern。", false],
		]);
		// The two quotations of one text are located where each is, not both at the first.
		expect(lantern?.evidence[0]?.byteStart).not.toBe(
			lantern?.evidence[1]?.byteStart,
		);
		// A name with itself is no relation.
		expect(x.relations).toEqual([]);
	});

	test("at most four quotations per entity and per relation", () => {
		const text = "Alpha と Beta。".repeat(6);
		const x = extract(text);
		expect(x.entities.map((e) => [e.name, e.evidence.length])).toEqual([
			["Alpha", NAMES_LIMITS.evidencePerItem],
			["Beta", NAMES_LIMITS.evidencePerItem],
		]);
		expect(x.relations.map((r) => r.evidence.length)).toEqual([
			NAMES_LIMITS.evidencePerItem,
		]);
	});

	test("entities beyond the limit are dropped in order of first occurrence, counted over_limit", () => {
		const names = Array.from(
			{ length: 120 },
			(_, i) => `N${String(i).padStart(3, "0")}`,
		);
		const x = extract(names.map((n) => `${n}。`).join(""));
		expect(x.entities).toHaveLength(NAMES_LIMITS.entities);
		expect(x.entities.at(-1)?.name).toBe("N099");
		expect(x.relations).toEqual([]);
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 20 }]);
	});

	test("relations beyond the limit are dropped, counted over_limit", () => {
		// 25 names in one sentence: 300 pairs.
		const names = Array.from(
			{ length: 25 },
			(_, i) => `N${String(i).padStart(2, "0")}`,
		);
		const x = extract(`${names.join(" と ")}。`);
		expect(x.entities).toHaveLength(25);
		expect(x.relations).toHaveLength(NAMES_LIMITS.relations);
		expect(x.relations.map((r) => r.id).at(-1)).toBe(
			`r${NAMES_LIMITS.relations}`,
		);
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 100 }]);
	});

	test("over the limit, pairs of two common nouns are dropped first; the order stays otherwise", () => {
		// 22 common nouns (kanji) and two proper names (identifiers) in one sentence: 276 pairs.
		const K = "甲乙丙丁戊己庚辛壬癸";
		const nouns = Array.from(
			{ length: 22 },
			(_, i) => `${K[i % 10]}${K[Math.floor(i / 10)]}子`,
		);
		const x = extract(`${nouns.join("と")}と A1 と B2。`);
		const name = new Map(x.entities.map((e) => [e.id, e]));
		expect(
			x.entities.filter((e) => e.type === NAME_TYPES.proper).map((e) => e.name),
		).toEqual(["A1", "B2"]);
		expect(x.relations).toHaveLength(NAMES_LIMITS.relations);
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 76 }]);
		const proper = x.relations.map(
			(r) =>
				Number(name.get(r.source)?.type === NAME_TYPES.proper) +
				Number(name.get(r.target)?.type === NAME_TYPES.proper),
		);
		// 1 pair of two proper names, 44 of one, then 155 of the 231 pairs of two nouns.
		expect(proper.filter((n) => n === 2)).toHaveLength(1);
		expect(proper.filter((n) => n === 1)).toHaveLength(44);
		expect(proper.slice(0, 45).every((n) => n > 0)).toBe(true);
		// Among the pairs of two nouns, the first kept is the first pair of the sentence.
		const first = x.relations[45];
		expect([
			name.get(first?.source ?? "")?.name,
			name.get(first?.target ?? "")?.name,
		]).toEqual([nouns[0], nouns[1]]);
	});

	test("a long sentence is quoted by a window around the names; names too far apart are no relation", () => {
		const filler = "あ".repeat(500);
		const text = `Alpha と Beta${filler}Omega。`;
		const x = extract(text);
		expect(x.entities.map((e) => e.name)).toEqual(["Alpha", "Beta", "Omega"]);
		for (const e of x.entities) {
			const [quote] = e.evidence.map((v) => quoteAt(text, v));
			expect(quote?.length).toBeLessThanOrEqual(NAMES_LIMITS.quoteChars);
			expect(quote).toContain(e.name);
		}
		const name = new Map(x.entities.map((e) => [e.id, e.name]));
		expect(
			x.relations.map((r) => [name.get(r.source), name.get(r.target)]),
		).toEqual([["Alpha", "Beta"]]);
		// Alpha–Omega and Beta–Omega cannot be quoted within the limit.
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 2 }]);
	});

	test("a window never splits a surrogate pair", () => {
		// The window of Alpha ends inside 😀, the window of Omega starts inside 😀.
		const text = `Alpha${"😀".repeat(300)}Omega${"🎉".repeat(300)}。`;
		const x = extract(text);
		expect(x.entities.map((e) => e.name)).toEqual(["Alpha", "Omega"]);
		for (const e of x.entities)
			for (const v of e.evidence) {
				const quote = quoteAt(text, v);
				expect(LONE_SURROGATE.test(quote)).toBe(false);
				expect(quote).toContain(e.name);
			}
	});

	test("the bytes are those of the original text, URLs and home paths included", () => {
		const text =
			"ＭｙＳＱＬ は https://example.com/x と /Users/someone/a.md で動く。";
		const x = extract(text);
		expect(x.entities.map((e) => e.name)).toEqual(["ＭｙＳＱＬ"]);
		expect(x.entities[0]?.evidence.map((v) => quoteAt(text, v))).toEqual([
			text,
		]);
	});

	test("a name longer than nameChars is dropped as over_limit", () => {
		const x = extract(`${"漢".repeat(NAMES_LIMITS.nameChars + 1)}。Lantern。`);
		expect(x.entities.map((e) => e.name)).toEqual(["Lantern"]);
		expect(x.entities[0]?.id).toBe("e1");
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 1 }]);
		// Capitalized words joined across one space are one name, and as long.
		const words = Array.from({ length: 60 }, (_, i) => `Wd${i}x`).join(" ");
		expect(extract(`${words}。`).dropped).toEqual([
			{ reason: "over_limit", count: 1 },
		]);
	});

	test("over the entity limit, proper names are kept first; ids follow the text", () => {
		const K = "甲乙丙丁戊己庚辛壬癸";
		const nouns = Array.from(
			{ length: 110 },
			(_, i) =>
				`${K[i % 10]}${K[Math.floor(i / 10) % 10]}${K[Math.floor(i / 100)]}`,
		);
		const x = extract(`${nouns.join("。")}。A1。B2。`);
		expect(x.entities).toHaveLength(NAMES_LIMITS.entities);
		expect(x.entities.slice(-2).map((e) => [e.id, e.name])).toEqual([
			["e99", "A1"],
			["e100", "B2"],
		]);
		// The last 12 common nouns are the ones dropped.
		expect(x.entities.at(-3)?.name).toBe(nouns[97]);
		expect(x.dropped).toEqual([{ reason: "over_limit", count: 12 }]);
	});

	test("one pair is one relation, whichever name comes first in each sentence", () => {
		const text = "東京と大阪を比べる。\n大阪と東京は遠い。";
		const x = extract(text);
		expect(x.entities.map((e) => [e.id, e.name])).toEqual([
			["e1", "東京"],
			["e2", "大阪"],
		]);
		expect(x.relations).toHaveLength(1);
		const [r] = x.relations;
		expect([r?.source, r?.target]).toEqual(["e1", "e2"]);
		expect(r?.evidence.map((v) => quoteAt(text, v))).toEqual([
			"東京と大阪を比べる。",
			"大阪と東京は遠い。",
		]);
	});

	test("a host's name that crosses a sentence end has no quotation (no_evidence)", () => {
		const across: TokenizerPort = {
			id: "across",
			tokenize: () => [
				{
					surface: "foo。bar",
					start: 0,
					end: 7,
					kind: "noun",
					proper: false,
					norm: "foo。bar",
				},
			],
		};
		const x = ok(extractNames(fragmentOf("foo。bar"), across));
		expect(x.entities).toEqual([]);
		expect(x.dropped).toEqual([{ reason: "no_evidence", count: 1 }]);
	});

	test("an empty or name-less fragment gives nothing", () => {
		expect(extract("").entities).toEqual([]);
		expect(extract("   \n\n").entities).toEqual([]);
		expect(extract("これはそれです。").entities).toEqual([]);
	});

	test("a tokenizer that throws is a TokenizerFailure without its message", () => {
		const failing: TokenizerPort = {
			id: "failing",
			tokenize: () => {
				throw new Error("dictionary missing at /Users/someone");
			},
		};
		let thrown: unknown;
		try {
			extractNames(fragmentOf("Lantern"), failing);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TokenizerFailure);
		expect(String(thrown)).not.toContain("someone");
	});

	test("tokens that do not describe the text fail the fragment alone (invalid_tokens)", () => {
		const token = (surface: string, start: number, end: number) => ({
			surface,
			start,
			end,
			kind: "noun" as const,
			proper: false,
			norm: surface,
		});
		const answers: unknown[] = [
			[token("x", 0, 1)],
			null,
			[null],
			// Splits the surrogate pair of 𠮷.
			[token("\uD842", 0, 1), token("\uDFB7野家", 1, 4)],
		];
		for (const answer of answers) {
			const x = extractNames(fragmentOf("𠮷野家"), {
				id: "wrong",
				tokenize: () => answer as never,
			});
			expect(x).toEqual({
				fragmentOrdinal: 3,
				status: "failed",
				errorCode: "invalid_tokens",
				model: "names:wrong@rules5",
			});
		}
	});
});
