// 合成 Markdown（実文書ではない）。frontmatter / 見出し / リンク / コード / 表 / CJK / 絵文字(ZWJ・旗・肌色) / 結合文字 / 超長行。
const ZWJ_FAMILY = "👨‍👩‍👧‍👦"; // 7 code points, 25 bytes, 11 UTF-16 units, 1 grapheme
const FLAG = "🇯🇵";
const THUMB = "👍🏽";
const E_ACUTE_NFD = "é";
const GA_NFD = "が"; // が の分解形

export function buildMarkdown(eol: "\n" | "\r\n" = "\n", bom = false): string {
	const lines = [
		"---",
		"title: 合成文書 ✨",
		"tags: [テスト, \"日本語\"]",
		"---",
		"前置きの段落。見出しより前にある。",
		"",
		"# 第1章 はじめに",
		"",
		`絵文字: ${ZWJ_FAMILY} と ${FLAG} と ${THUMB}。結合文字: caf${E_ACUTE_NFD} と ${GA_NFD}。`,
		"",
		"[リンク](https://example.com/日本語/パス?q=値&r=1) と [参照][ref1] を含む段落。",
		"",
		"[ref1]: https://example.com/ref \"タイトル\"",
		"",
		"## 1.1 コードブロック",
		"",
		"```ts",
		"# これは見出しではない（フェンス内）",
		"const s = \"日本語\"; // コメント 🙂",
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
		"日本語の長い一文。".repeat(30) + "終わり。",
		"",
		ZWJ_FAMILY.repeat(12),
		"",
		"### 2.0.1 深い見出し ###",
		"",
		"最後の段落（末尾改行なし）",
	];
	return (bom ? "﻿" : "") + lines.join(eol);
}
export const GLYPHS = { ZWJ_FAMILY, FLAG, THUMB, E_ACUTE_NFD, GA_NFD };
