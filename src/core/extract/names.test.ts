import { describe, expect, test } from "bun:test";
import type { NameToken, TokenizerPort } from "../../contracts/ports.js";
import {
	blankOut,
	createCharclassTokenizer,
	namesFromTokens,
} from "./names.js";

const charclass = createCharclassTokenizer();
const names = (text: string, tokenizer: TokenizerPort = charclass) => {
	const blanked = blankOut(text);
	return namesFromTokens(blanked, tokenizer.tokenize(blanked));
};
const kinds = (text: string) =>
	names(text).map((n) => [n.surface, n.proper ? "proper" : "noun"]);

describe("the text the rules read", () => {
	test("URLs and home paths become spaces; full-width ASCII becomes ASCII; the length stays", () => {
		const text =
			"詳しくは https://example.com/a?b=1 と /Users/someone/notes.md と ＭｙＳＱＬ　と全角の．！？";
		const blanked = blankOut(text);
		expect(blanked.length).toBe(text.length);
		expect(blanked).not.toContain("example.com");
		expect(blanked).not.toContain("someone");
		expect(blanked).toContain("MySQL ");
		// The full-width sentence ends stay.
		expect(blanked.endsWith("．！？")).toBe(true);
	});
});

describe("what is blanked out (rules version 5)", () => {
	test("only the ASCII characters of a URL or a path: the Japanese after it stays", () => {
		const text =
			"詳細は[リンク](https://example.com/a)です。パスは/Users/me/x.txtです。次に東京と大阪。";
		// 「次」 is one character: no name.
		expect(names(text).map((n) => n.surface)).toEqual([
			"詳細",
			"リンク",
			"パス",
			"東京",
			"大阪",
		]);
		// A trailing full stop or comma stays: the sentence still ends there.
		expect(blankOut("see /tmp/x/y.log, then C:\\Users\\me\\a.txt. ok")).toBe(
			"see             , then                  . ok",
		);
	});

	test("e-mail addresses and secret-like strings are no names", () => {
		const text =
			// Built from parts so that no secret scanner takes the test for a leaked key.
			`key ${"sk-"}proj-AbC123xyz987 and ${"AKIA"}IOSFODNN7EXAMPLE and a@b.com password=Hunter2Hunter2 LANTERN_TOKEN=abc123`;
		const blanked = blankOut(text);
		expect(blanked.length).toBe(text.length);
		for (const secret of ["sk-proj", "AKIA", "a@b.com", "Hunter2", "abc123"])
			expect(blanked).not.toContain(secret);
		expect(names(text).map((n) => n.surface)).toEqual([
			"key",
			"password",
			"LANTERN_TOKEN",
		]);
	});

	test("a token-like string is no name; an identifier with separators stays", () => {
		expect(
			names(
				`hash ${"0123456789abcdef".repeat(4)} と Ab3${"x".repeat(30)} と eumenes_knowledge_integration_test_v2`,
			).map((n) => n.surface),
		).toEqual(["hash", "eumenes_knowledge_integration_test_v2"]);
	});
});

describe("names from tokens (rules version 5)", () => {
	test("the probe sentence of kg2.md §7.3: English words, width, markers, options, units", () => {
		expect(
			kinds(
				"We keep the pages. ＭｙＳＱＬ と ＬＡＮＴＥＲＮ＿ＴＯＫＥＮ、steward のこと。Quality Assurance (品質保証部) has many tables. TODO: --full で 16GB、.values を見る。",
			),
		).toEqual([
			["keep", "noun"],
			["pages", "noun"],
			["MySQL", "proper"],
			["LANTERN_TOKEN", "proper"],
			["steward", "proper"],
			["Quality Assurance", "proper"],
			["品質保証部", "noun"],
			["many", "noun"],
			["tables", "noun"],
			["values", "proper"],
		]);
	});

	test("capitalized English words join across one space; a sentence's full stop is not part of a name", () => {
		expect(kinds("記憶の減衰（Memory Decay）と M1. と mem0ai/mem0。")).toEqual([
			["記憶", "noun"],
			["減衰", "noun"],
			["Memory Decay", "proper"],
			["M1", "proper"],
			["mem0ai/mem0", "proper"],
		]);
	});

	test("one occurrence each, in text order, with offsets into the text", () => {
		const text = "Lantern は Lantern の置き換え。";
		const found = names(text);
		// 「置」「換」 are one character each: no name.
		expect(found.map((n) => n.surface)).toEqual(["Lantern", "Lantern"]);
		for (const n of found) expect(text.slice(n.start, n.end)).toBe(n.surface);
	});

	test("a tokenizer's tags: proper nouns, prefixes and suffixes, normalized keys", () => {
		// 「お」「さん」 are a prefix and a suffix around a proper noun.
		const tokens: NameToken[] = [
			{
				surface: "お",
				start: 0,
				end: 1,
				kind: "prefix",
				proper: false,
				norm: "お",
			},
			{
				surface: "佐々木",
				start: 1,
				end: 4,
				kind: "noun",
				proper: true,
				norm: "佐々木",
			},
			{
				surface: "さん",
				start: 4,
				end: 6,
				kind: "suffix",
				proper: false,
				norm: "さん",
			},
			{
				surface: "の",
				start: 6,
				end: 7,
				kind: "other",
				proper: false,
				norm: "の",
			},
			{
				surface: "サーバ",
				start: 7,
				end: 10,
				kind: "noun",
				proper: false,
				norm: "サーバー",
			},
		];
		const tokenizer: TokenizerPort = { id: "fixed", tokenize: () => tokens };
		expect(names("お佐々木さんのサーバ", tokenizer)).toEqual([
			{ surface: "佐々木", start: 1, end: 4, key: "佐々木", proper: true },
			{ surface: "サーバ", start: 7, end: 10, key: "サーバー", proper: false },
		]);
	});

	test("tokens that do not describe the text are refused", () => {
		const bad = (tokens: NameToken[]) => () =>
			namesFromTokens("abc def", tokens);
		const t = (surface: string, start: number, end: number): NameToken => ({
			surface,
			start,
			end,
			kind: "noun",
			proper: false,
			norm: surface,
		});
		expect(bad([t("abd", 0, 3)])).toThrow(RangeError);
		expect(bad([t("abc", 0, 3), t("bc", 1, 3)])).toThrow(RangeError);
		expect(bad([t("def", 4, 9)])).toThrow(RangeError);
		expect(
			namesFromTokens("abc def", [t("abc", 0, 3), t("def", 4, 7)]),
		).toHaveLength(2);
	});
});

describe("the dictionary-free tokenizer", () => {
	test("runs of one script; hiragana splits a name (送り仮名), nothing is proper by its tag", () => {
		const blanked = blankOut(
			"時間推論とランタンの書き込み、eumenes_memory 2.0。",
		);
		const tokens = charclass.tokenize(blanked);
		expect(tokens.map((t) => t.surface).join("")).toBe(blanked);
		expect(tokens.every((t) => !t.proper)).toBe(true);
		expect(names("時間推論とランタンの書き込み").map((n) => n.surface)).toEqual(
			["時間推論", "ランタン"],
		);
	});
});

describe("rules version 6 (kg2.md §7.9, from Wikipedia text)", () => {
	const marked = (text: string) =>
		names(text).map((n) => `${n.surface}${n.proper ? "*" : ""}`);

	test("math (TeX) and lines that cite give no name; the length stays", () => {
		const math =
			"損失は {\\displaystyle L({\\hat {y}},y)={\\begin{cases}1&{\\text{if }}\\end{cases}}} と $$\\sum_i x_i$$ で書く。";
		expect(blankOut(math).length).toBe(math.length);
		expect(marked(math)).toEqual(["損失"]);
		const cite =
			"本文の Lantern。\n我妻幸長：「BERT実践入門」、翔泳社、ISBN 978-4-7981-7781-6 (2023年7月20日).\n次の行の MySQL。";
		// The citing line gives nothing; 「次」「行」 are one character each.
		expect(marked(cite)).toEqual(["本文", "Lantern*", "MySQL*"]);
	});

	test("a citation blanks its part of the line up to a Japanese sentence end, not the paragraph", () => {
		expect(
			marked(
				"これはGPT-4の話で、論文はarXiv:2005.14165に載っている。OpenAIが公開した。\n次の行 Tokyo",
			),
		).toEqual(["OpenAI*", "公開", "Tokyo*"]);
		// An English bibliography entry has no Japanese sentence end: the whole entry goes.
		expect(
			marked(
				"Brown, Tom B.; Mann, Benjamin (2020). Language Models. arXiv:2005.14165.",
			),
		).toEqual([]);
		// The word alone, without a number, cites nothing.
		expect(marked("ISBNとは書籍の番号である。")).toEqual([
			"ISBN*",
			"書籍",
			"番号",
		]);
		// Prose longer than a bibliography entry loses only the number.
		const prose = `We build on ${"the Lantern project described in detail ".repeat(8)}(arXiv:2005.14165) and Tokyo.`;
		expect(blankOut(prose)).not.toContain("2005");
		expect(marked(prose)).toContain("Tokyo*");
	});

	test("math delimiters stay within a paragraph; escaped braces are no groups; the blanking is linear", () => {
		expect(
			marked("echo $$ と Alpha\n\nBeta Gamma 東京\n\necho $$ done"),
		).toEqual(["echo*", "Alpha*", "Beta Gamma*", "東京", "echo", "done"]);
		expect(
			marked("{\\displaystyle \\left\\{x\\right.} の後の Lantern"),
		).toEqual(["Lantern*"]);
		// Groups inside a group already blanked are skipped (this took tens of seconds before).
		const nested = "{\\displaystyle ".repeat(20000);
		const started = performance.now();
		expect(blankOut(nested).trim()).toBe("");
		expect(blankOut(`${"\\(".repeat(20000)}x`).length).toBe(40001);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("katakana words joined by a middle dot are one name", () => {
		expect(marked("OpenAIとサム・アルトマンを相手取る。")).toEqual([
			"OpenAI*",
			"サム・アルトマン",
			"相手取",
		]);
	});

	test("only plain capitalized words join across a space; an identifier meets Japanese as two names", () => {
		expect(
			marked("Google PaLMとGPT-4 Turbo、その後GPT-4カスタムモデルとAIモデル。"),
		).toEqual([
			"Google*",
			"PaLM*",
			"GPT-4*",
			"Turbo*",
			"GPT-4*",
			"カスタムモデル",
			"AI*",
			"モデル",
		]);
		expect(
			marked("Microsoft Azure と Quality Assurance と Google翻訳。"),
		).toEqual(["Microsoft Azure*", "Quality Assurance*", "Google翻訳*"]);
	});

	test("small-letter English in parentheses is a gloss, not a proper name; capitals stay proper", () => {
		expect(
			marked(
				"大規模言語モデル（英: large language model、LLM）と in-context learning。",
			),
		).toEqual([
			"大規模言語モデル",
			"large",
			"language",
			"model",
			"LLM*",
			"in-context*",
			"learning*",
		]);
	});

	test("a gloss is no proper name even when the tokenizer tags it proper", () => {
		// A tokenizer that tags every ASCII word proper, as Sudachi does with some unknown words.
		const tagging: TokenizerPort = {
			id: "tagging",
			tokenize: (text) =>
				charclass
					.tokenize(text)
					.map((t) => ({ ...t, proper: /^[A-Za-z]/.test(t.surface) })),
		};
		expect(
			names("関数呼び出し (function calling) と Lantern。", tagging).map(
				(n) => `${n.surface}${n.proper ? "*" : ""}`,
			),
		).toEqual(["関数呼", "function", "calling", "Lantern*"]);
		// Only parentheses closed within the line hold a gloss: ":(" holds nothing.
		expect(marked("顔文字 :( と numpy と Lantern")).toEqual([
			"顔文字",
			"numpy*",
			"Lantern*",
		]);
		expect(marked("パッケージ（numpy）と Lantern")).toEqual([
			"パッケージ",
			"numpy",
			"Lantern*",
		]);
	});

	test("a middle dot left before a suffix is not part of the name", () => {
		const tokens: NameToken[] = [
			{
				surface: "サム",
				start: 0,
				end: 2,
				kind: "noun",
				proper: true,
				norm: "サム",
			},
			{
				surface: "・",
				start: 2,
				end: 3,
				kind: "other",
				proper: false,
				norm: "・",
			},
			{
				surface: "チャン",
				start: 3,
				end: 6,
				kind: "suffix",
				proper: false,
				norm: "チャン",
			},
		];
		expect(
			names("サム・チャン", { id: "fixed", tokenize: () => tokens }),
		).toEqual([
			{ surface: "サム", start: 0, end: 2, key: "サム", proper: true },
		]);
	});
});
