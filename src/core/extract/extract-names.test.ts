import { describe, expect, test } from "bun:test";
import type {
	EvidenceRange,
	FragmentExtraction,
} from "../../contracts/index-data.js";
import type { TokenizerPort } from "../../contracts/ports.js";
import { sha256Hex } from "../bytes.js";
import {
	extractNames,
	fragmentStructures,
	NAME_TYPES,
	NAMES_LIMITS,
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
		expect(x.model).toBe("names:charclass@rules8");
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

	test("two names in one sentence make no relation (rules version 8, kg2.md §7.14)", () => {
		const text =
			"Lantern と MySQL を使う。Mira Okafor が書いた！ 次は Lantern と Mira Okafor。";
		const x = extract(text);
		// 「使」「書」「次」 are one character each: no name.
		expect(x.entities.map((e) => e.name)).toEqual([
			"Lantern",
			"MySQL",
			"Mira Okafor",
		]);
		expect(x.relations).toEqual([]);
		expect(x.dropped).toEqual([]);
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

	test("at most four quotations per entity", () => {
		const text = "Alpha と Beta。".repeat(6);
		const x = extract(text);
		expect(x.entities.map((e) => [e.name, e.evidence.length])).toEqual([
			["Alpha", NAMES_LIMITS.evidencePerItem],
			["Beta", NAMES_LIMITS.evidencePerItem],
		]);
	});

	test("entities beyond the limit are dropped in order of first occurrence; proper ones are proper_over_limit", () => {
		const names = Array.from(
			{ length: 120 },
			(_, i) => `N${String(i).padStart(3, "0")}`,
		);
		const x = extract(names.map((n) => `${n}。`).join(""));
		expect(x.entities).toHaveLength(NAMES_LIMITS.entities);
		expect(x.entities.at(-1)?.name).toBe("N099");
		expect(x.relations).toEqual([]);
		expect(x.dropped).toEqual([{ reason: "proper_over_limit", count: 20 }]);
	});

	test("an enumeration of many names in one sentence: every name, nothing dropped", () => {
		// 18 proper names (identifiers) and 6 common nouns (kanji) in one sentence.
		const K = "甲乙丙丁戊己";
		const proper = Array.from(
			{ length: 18 },
			(_, i) => `P${String(i).padStart(2, "0")}`,
		);
		const nouns = Array.from({ length: 6 }, (_, i) => `${K[i]}${K[i]}子`);
		const x = extract(`${[...proper, ...nouns].join(" と ")}。`);
		expect(x.entities.map((e) => [e.name, e.type])).toEqual([
			...proper.map((p) => [p, NAME_TYPES.proper]),
			...nouns.map((n) => [n, NAME_TYPES.noun]),
		]);
		expect(x.relations).toEqual([]);
		expect(x.dropped).toEqual([]);
	});

	test("a long sentence is quoted by a window around each name", () => {
		const filler = "あ".repeat(500);
		const text = `Alpha と Beta${filler}Omega。`;
		const x = extract(text);
		expect(x.entities.map((e) => e.name)).toEqual(["Alpha", "Beta", "Omega"]);
		for (const e of x.entities) {
			const [quote] = e.evidence.map((v) => quoteAt(text, v));
			expect(quote?.length).toBeLessThanOrEqual(NAMES_LIMITS.quoteChars);
			expect(quote).toContain(e.name);
		}
		expect(x.dropped).toEqual([]);
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
		const words = Array.from({ length: 60 }, () => "Wordy").join(" ");
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

	test("two surfaces of one key are two entities of one key (one entity when read)", () => {
		const x = extract("GitHub と github と Lantern を使う。");
		expect(x.entities.map((e) => [e.name, e.key])).toEqual([
			["GitHub", "github"],
			["github", "github"],
			["Lantern", "lantern"],
		]);
		expect(x.relations).toEqual([]);
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
				model: "names:wrong@rules8",
			});
		}
	});
});

describe("the Markdown structure across fragments (rules version 7)", () => {
	test("a code block or a frontmatter that spans fragments is code in each part", () => {
		const texts = [
			"---\ntitle: Lantern\n",
			"---\nLantern は MySQL を使う。\n```ts\nconst pool = ",
			"createPool(config);\n```\nMira Okafor が書いた。\n```\nlet Unclosed = 1;\n",
		];
		const structures = fragmentStructures(texts);
		expect(structures).toEqual([
			{ code: [], frontmatter: { start: 0, end: texts[0]!.length } },
			{
				code: [
					{
						start: texts[1]!.indexOf("```"),
						end: texts[1]!.length,
					},
				],
				frontmatter: { start: 0, end: 4 },
			},
			{
				code: [
					{ start: 0, end: texts[2]!.indexOf("Mira") },
					{ start: texts[2]!.indexOf("```\nlet"), end: texts[2]!.length },
				],
				frontmatter: null,
			},
		]);
		const namesOf = (i: number) =>
			ok(
				extractNames(
					{ ordinal: i, byteStart: 0, text: texts[i] as string },
					charclass,
					structures[i],
				),
			).entities.map((e) => e.name);
		expect(namesOf(0)).toEqual(["Lantern"]);
		expect(namesOf(1)).toEqual(["Lantern", "MySQL"]);
		expect(namesOf(2)).toEqual(["Mira Okafor"]);
		// Without the structure the fragment is read as prose.
		expect(
			ok(
				extractNames(
					{ ordinal: 2, byteStart: 0, text: texts[2] as string },
					charclass,
				),
			).entities.map((e) => e.name),
		).toEqual(expect.arrayContaining(["createPool", "Unclosed"]));
		expect(fragmentStructures([])).toEqual([]);
	});

	test("a fragment that starts inside a frontmatter line finds keys from its next line", () => {
		const texts = [
			"---\ndescription: a long",
			" line: of prose\ntitle: X\n---\nbody",
		];
		const [, second] = fragmentStructures(texts);
		expect(second?.frontmatter).toEqual({
			start: " line: of prose\n".length,
			end: " line: of prose\ntitle: X\n---\n".length,
		});
		// A fragment cut inside the last line of the frontmatter has nothing of it to read keys in.
		expect(
			fragmentStructures(["---\nab", "cd: e\n---\n"])[1]?.frontmatter,
		).toEqual({ start: "cd: e\n".length, end: "cd: e\n---\n".length });
		expect(
			fragmentStructures(["---\nti", "tle: e\n---\n"].map((t) => t))[1]
				?.frontmatter?.start,
		).toBe("tle: e\n".length);
	});
});

describe("what a fragment's limits leave out (kg2.md §7.10)", () => {
	const dropped = (text: string) =>
		Object.fromEntries(extract(text).dropped.map((d) => [d.reason, d.count]));

	test("proper names beyond the limit are a loss (proper_over_limit); common nouns are not", () => {
		const proper = Array.from({ length: 120 }, (_, i) => `N${i + 100}`);
		// 20 names beyond the limit.
		const x = dropped(`${proper.join(" ")}。`);
		expect(x).toEqual({ proper_over_limit: 20 });
		// Common nouns (small letters in an English sentence) beyond the limit: over_limit only.
		const letters = "abcdefghij";
		const common = Array.from(
			{ length: 120 },
			(_, i) => `zq${letters[Math.floor(i / 10)]}${letters[i % 10]}`,
		);
		const y = dropped(`Lantern ${common.join(" ")}.`);
		expect(y.over_limit).toBeGreaterThan(0);
		expect(y.proper_over_limit).toBeUndefined();
	});
});
