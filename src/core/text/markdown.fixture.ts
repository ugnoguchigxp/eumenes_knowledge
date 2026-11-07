// Synthetic Markdown (not a real document): frontmatter, headings, links, fenced code, a
// table, CJK, emoji (ZWJ, flag, skin tone), combining marks and very long lines.
export const ZWJ_FAMILY = "👨‍👩‍👧‍👦"; // 7 code points, 25 bytes, 11 UTF-16 units, 1 grapheme
export const FLAG = "🇯🇵";
export const THUMB = "👍🏽";
export const E_ACUTE_NFD = "é";
export const GA_NFD = "が";

export function buildMarkdown(eol: "\n" | "\r\n" = "\n", bom = false): string {
	const lines = [
		"---",
		"title: 合成文書 ✨",
		'tags: [テスト, "日本語"]',
		"# yaml comment, not a heading",
		"---",
		"前置きの段落。見出しより前にある。",
		"",
		"# 第1章 はじめに",
		"",
		`絵文字: ${ZWJ_FAMILY} と ${FLAG} と ${THUMB}。結合文字: caf${E_ACUTE_NFD} と ${GA_NFD}。`,
		"",
		"[リンク](https://example.com/日本語/パス?q=値&r=1) と [参照][ref1] を含む段落。",
		"",
		'[ref1]: https://example.com/ref "タイトル"',
		"",
		"## 1.1 コードブロック",
		"",
		"```ts",
		"# これは見出しではない（フェンス内）",
		"",
		'const s = "日本語"; // コメント 🙂',
		"```",
		"",
		"~~~",
		"## これも見出しではない",
		"~~~",
		"",
		"## 1.2 表",
		"",
		"| 名前 | 値 |",
		"| --- | --- |",
		"| 東京 | １２３ |",
		"| ｶﾞｲﾄﾞ | ABC |",
		"",
		"# 第2章 長い行",
		"",
		`${"日本語の長い一文。".repeat(30)}終わり。`,
		"",
		ZWJ_FAMILY.repeat(12),
		"",
		"### 2.0.1 深い見出し ###",
		"",
		"最後の段落（末尾改行なし）",
	];
	return (bom ? "﻿" : "") + lines.join(eol);
}

/** Deterministic pseudo-random generator (mulberry32). */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	"# 見出し\n",
	"## Sub heading ##\n",
	"### h3\r\n",
	"```\n",
	"~~~~\n",
	"```js\n",
	"\n",
	"\r\n",
	"  \n",
	"本文の行です。\n",
	"plain ascii line\n",
	"日本語の文が続く。",
	"abc ",
	ZWJ_FAMILY,
	FLAG + FLAG,
	THUMB,
	`e${E_ACUTE_NFD}`,
	GA_NFD,
	"😀",
	"| a | b |\n",
	"---\n",
	"#hashtag\n",
	"\r",
	"\n",
];

/** A random document built from structural pieces; every grapheme in it is at most 25 bytes. */
export function randomMarkdown(seed: number, pieces = 120): string {
	const next = prng(seed);
	let out = next() < 0.3 ? "﻿" : "";
	for (let i = 0; i < pieces; i++) {
		out += PIECES[Math.floor(next() * PIECES.length)] as string;
	}
	return out;
}
