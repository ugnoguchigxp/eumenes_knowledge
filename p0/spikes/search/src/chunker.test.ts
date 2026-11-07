import { describe, expect, test } from "bun:test";
import { chunkMarkdown, sha256Hex, buildByteMap, type Fragment } from "./chunker.ts";
import { verifyCitation } from "./citation.ts";
import { buildMarkdown, GLYPHS } from "./fixtures.ts";
import { normalizeFragment, normalizeText } from "./normalize-map.ts";

const variants = [
	{ name: "LF", eol: "\n" as const, bom: false },
	{ name: "CRLF", eol: "\r\n" as const, bom: false },
	{ name: "LF+BOM", eol: "\n" as const, bom: true },
	{ name: "CRLF+BOM", eol: "\r\n" as const, bom: true },
];
const caps = [64, 100, 256, 4096];

/** 実装の外にある、独立した検証: byte 範囲の切り出しが断片と一致するか */
function checkFragments(md: string, frags: Fragment[], bytes: Uint8Array) {
	const failures: string[] = [];
	for (const f of frags) {
		const sliced = Buffer.from(md, "utf8").subarray(f.start, f.end).toString("utf8");
		if (sliced !== f.text) failures.push(`slice#${f.index}`);
		if (sha256Hex(bytes.subarray(f.start, f.end)) !== f.sha256) failures.push(`digest#${f.index}`);
	}
	return failures;
}

describe.each(variants)("chunkMarkdown $name", ({ eol, bom }) => {
	const md = buildMarkdown(eol, bom);
	const docBytes = Buffer.from(md, "utf8");
	for (const maxBytes of caps) {
		test(`cap=${maxBytes}: byte 範囲の切り出しと digest が全断片で一致`, () => {
			const r = chunkMarkdown(md, { maxBytes });
			expect(r.fragments.length).toBeGreaterThan(0);
			expect(checkFragments(md, r.fragments, docBytes)).toEqual([]);
			for (const f of r.fragments) {
				const c = verifyCitation(docBytes, { start: f.start, end: f.end, sha256: f.sha256 });
				expect(c.ok).toBe(true);
				if (c.ok) expect(c.text).toBe(f.text);
			}
		});
		test(`cap=${maxBytes}: 断片は隙間・重なりなしで本文全体（BOM と改行を含む）を覆い、連結で原文に戻る`, () => {
			const r = chunkMarkdown(md, { maxBytes });
			expect(r.fragments[0]!.start).toBe(0);
			expect(r.fragments.at(-1)!.end).toBe(docBytes.length);
			for (let i = 1; i < r.fragments.length; i++) expect(r.fragments[i]!.start).toBe(r.fragments[i - 1]!.end);
			expect(r.fragments.map((f) => f.text).join("")).toBe(md);
		});
		test(`cap=${maxBytes}: UTF-8 byte 上限を守り、書記素の途中で切らない（切った場合は印が付く）`, () => {
			const r = chunkMarkdown(md, { maxBytes });
			const seg = new Intl.Segmenter("und", { granularity: "grapheme" });
			// 文書全体の書記素境界（byte）。CRLF は 1 書記素なので \r と \n の間は境界ではない
			const boundaries = new Set<number>();
			let b = 0;
			for (const s of seg.segment(md)) { boundaries.add(b); b += Buffer.byteLength(s.segment); }
			boundaries.add(b);
			for (const f of r.fragments) {
				expect(f.end - f.start).toBeLessThanOrEqual(maxBytes);
				if (!f.brokeGrapheme) {
					expect(boundaries.has(f.start)).toBe(true);
					expect(boundaries.has(f.end)).toBe(true);
				}
			}
		});
	}
	test("cap=4096: 見出し構造に沿って分割される（フェンス内の # は見出しではない）", () => {
		const r = chunkMarkdown(md, { maxBytes: 4096 });
		const kinds = r.fragments.map((f) => `${f.kind}:${f.headingPath.join(">")}`);
		expect(kinds).toEqual([
			"frontmatter:",
			"preamble:",
			"section:第1章 はじめに",
			"section:第1章 はじめに>1.1 コードブロック",
			"section:第1章 はじめに>1.2 表",
			"section:第2章 長い行",
			"section:第2章 長い行>2.0.1 深い見出し",
		]);
		expect(r.hasBom).toBe(bom);
		expect(r.fragments[0]!.text.startsWith(bom ? "﻿---" : "---")).toBe(true); // BOM は除去されず先頭断片に含まれる
		expect(r.fragments[0]!.start).toBe(0);
	});
	test("cap=100: 超長い ZWJ 絵文字列も書記素単位で切れ、25 byte の書記素が分断されない", () => {
		const r = chunkMarkdown(md, { maxBytes: 100 });
		const hit = r.fragments.filter((f) => f.text.includes(GLYPHS.ZWJ_FAMILY));
		expect(hit.length).toBeGreaterThan(0);
		for (const f of r.fragments) {
			// ZWJ(U+200D) が断片の先頭/末尾にぶら下がっていない = ZWJ 結合の途中で切っていない
			expect(f.text.startsWith("‍")).toBe(false);
			expect(f.text.endsWith("‍")).toBe(false);
		}
		expect(r.fragments.some((f) => f.brokeGrapheme)).toBe(false);
	});
	test("文書全体の digest は bytes 全体（BOM 含む）の sha256", () => {
		const r = chunkMarkdown(md, { maxBytes: 4096 });
		expect(r.docSha256).toBe(sha256Hex(docBytes));
		expect(r.bytes.length).toBe(docBytes.length);
	});
});

describe("UTF-16 index と byte offset の取り違えを検出できる", () => {
	const md = buildMarkdown("\n", false);
	const bytes = Buffer.from(md, "utf8");
	const { fragments } = chunkMarkdown(md, { maxBytes: 256 });

	test("fixture は byte 長 > UTF-16 長（取り違えが顕在化する前提）", () => {
		expect(bytes.length).toBeGreaterThan(md.length * 1.4);
	});
	test("md.slice(start, end)（UTF-16 index 扱い）では断片と一致しない断片が存在する", () => {
		const wrong = fragments.filter((f) => md.slice(f.start, f.end) !== f.text);
		expect(wrong.length).toBeGreaterThan(0);
	});
	test("検証関数は UTF-16 index で作った引用を拒否する（digest 不一致または UTF-8 境界違反）", () => {
		const f = fragments[fragments.length - 1]!;
		const u16s = md.length - [...f.text].reduce((a, c) => a + c.length, 0);
		const bad = { start: u16s, end: md.length, sha256: sha256Hex(Buffer.from(md.slice(u16s), "utf8")) };
		const r = verifyCitation(bytes, bad);
		expect(r.ok).toBe(false);
	});
	test("バグを持つ chunker（UTF-16 index を byte として保持）を模擬すると、独立検証が全体で失敗を報告する", () => {
		const buggy: Fragment[] = [];
		let u = 0;
		for (const f of fragments) { buggy.push({ ...f, start: u, end: u + f.text.length }); u += f.text.length; }
		const failures = checkFragments(md, buggy, bytes);
		expect(failures.length).toBeGreaterThan(0);
	});
	test("BOM を TextDecoder 既定（除去する）で読むと byte offset が 3 ずれる = BOM を除去しない読み方が必要", () => {
		const withBom = Buffer.from(buildMarkdown("\n", true), "utf8");
		const stripped = new TextDecoder("utf-8").decode(withBom); // 既定は BOM を除去
		expect(stripped.startsWith("﻿")).toBe(false);
		expect(Buffer.from(stripped, "utf8").length).toBe(withBom.length - 3);
		const kept = new TextDecoder("utf-8", { ignoreBOM: true }).decode(withBom);
		expect(kept.startsWith("﻿")).toBe(true);
		expect(Buffer.from(kept, "utf8").length).toBe(withBom.length);
		// bytes から作ると BOM は範囲に含まれ、後続の断片 start も 3 だけ後ろにずれて整合する
		const noBom = chunkMarkdown(buildMarkdown("\n", false), { maxBytes: 4096 });
		const yesBom = chunkMarkdown(withBom, { maxBytes: 4096 });
		expect(yesBom.fragments[0]!.end).toBe(noBom.fragments[0]!.end + 3);
		expect(yesBom.fragments[1]!.start).toBe(noBom.fragments[1]!.start + 3);
	});
	test("buildByteMap: ASCII/2/3/4 byte と サロゲートペアの対応", () => {
		const s = "aé日😀b";
		const m = buildByteMap(s);
		expect(Array.from(m)).toEqual([0, 1, 3, 6, 6, 10, 11]); // [a, é, 日, 😀(高), 😀(低:境界でない), b, 末尾]
		expect(m[s.length]).toBe(Buffer.byteLength(s));
	});
});

describe("引用検証 verifyCitation", () => {
	const md = buildMarkdown("\r\n", true);
	const bytes = Buffer.from(md, "utf8");
	const { fragments } = chunkMarkdown(md, { maxBytes: 4096 });
	const f = fragments[2]!;
	test("正しい範囲 + digest は ok", () => expect(verifyCitation(bytes, { start: f.start, end: f.end, sha256: f.sha256 }).ok).toBe(true));
	test("範囲外・逆順・非整数は range", () => {
		expect(verifyCitation(bytes, { start: 0, end: bytes.length + 1, sha256: "x" })).toEqual({ ok: false, reason: "range" });
		expect(verifyCitation(bytes, { start: 5, end: 4, sha256: "x" })).toEqual({ ok: false, reason: "range" });
		expect(verifyCitation(bytes, { start: 0.5, end: 4, sha256: "x" })).toEqual({ ok: false, reason: "range" });
	});
	test("文字の途中（UTF-8 継続 byte）で始まる/終わる範囲は utf8_boundary", () => {
		const i = bytes.indexOf(Buffer.from("日"));
		expect(verifyCitation(bytes, { start: i + 1, end: i + 3, sha256: "x" })).toEqual({ ok: false, reason: "utf8_boundary" });
		expect(verifyCitation(bytes, { start: i, end: i + 2, sha256: "x" })).toEqual({ ok: false, reason: "utf8_boundary" });
	});
	test("本文が 1 byte でも変わると digest 不一致", () => {
		const changed = Buffer.from(bytes);
		changed[f.start + 3] = changed[f.start + 3]! ^ 1;
		const r = verifyCitation(changed, { start: f.start, end: f.end, sha256: f.sha256 });
		expect(r.ok).toBe(false);
	});
	test("前に 1 文字挿入された本文では同じ範囲が別内容 = digest 不一致（版が変わった引用は通らない）", () => {
		const shifted = Buffer.concat([Buffer.from("あ"), bytes]);
		expect(verifyCitation(shifted, { start: f.start, end: f.end, sha256: f.sha256 }).ok).toBe(false);
	});
});

describe("chunker のエッジ", () => {
	test("空文書・frontmatter のみ・見出しなし", () => {
		expect(chunkMarkdown("", { maxBytes: 64 }).fragments).toEqual([]);
		const fm = chunkMarkdown("---\na: 1\n---\n", { maxBytes: 64 });
		expect(fm.fragments.map((f) => f.kind)).toEqual(["frontmatter"]);
		const plain = chunkMarkdown("見出しなしの本文\n", { maxBytes: 64 });
		expect(plain.fragments.map((f) => f.kind)).toEqual(["preamble"]);
	});
	test("閉じない frontmatter 風の --- は frontmatter にしない", () => {
		const r = chunkMarkdown("---\n# 見出し\n本文\n", { maxBytes: 4096 });
		expect(r.fragments.some((f) => f.kind === "frontmatter")).toBe(false);
	});
	test("maxBytes 64 未満は拒否、不正 UTF-8 は拒否", () => {
		expect(() => chunkMarkdown("a", { maxBytes: 10 })).toThrow("max_bytes_too_small");
		expect(() => chunkMarkdown(new Uint8Array([0xff, 0xfe, 0x41]), { maxBytes: 64 })).toThrow();
	});
	test("書記素 1 個が上限を超える（結合文字を 80 個重ねる）と code point 境界で切り、brokeGrapheme の印を付ける", () => {
		const zalgo = "a" + "́".repeat(80); // 1 + 160 byte, 1 grapheme
		const md = `# H\n\n${zalgo}\n`;
		const r = chunkMarkdown(md, { maxBytes: 64 });
		expect(r.fragments.some((f) => f.brokeGrapheme)).toBe(true);
		expect(r.fragments.map((f) => f.text).join("")).toBe(md);
		for (const f of r.fragments) expect(f.end - f.start).toBeLessThanOrEqual(64);
	});
	test("CRLF の \\r と \\n の間では切らない", () => {
		const md = "# 見出し\r\n" + "あ".repeat(21) + "\r\n" + "い\r\n"; // 行が cap 付近で \r\n をまたぎやすい
		for (const cap of [64, 65, 66, 67, 68, 69, 70]) {
			const r = chunkMarkdown(md, { maxBytes: cap });
			for (const f of r.fragments) {
				expect(f.text.endsWith("\r") && !f.text.endsWith("\r\n")).toBe(false);
				expect(f.text.startsWith("\n")).toBe(false);
			}
			expect(r.fragments.map((f) => f.text).join("")).toBe(md);
		}
	});
	test("表は上限内なら 1 断片に残る", () => {
		const r = chunkMarkdown(buildMarkdown(), { maxBytes: 4096 });
		const t = r.fragments.find((f) => f.headingPath.at(-1) === "1.2 表")!;
		expect(t.text).toContain("| 東京 | １２３ |");
		expect(t.text).toContain("| ｶﾞｲﾄﾞ | ABC |");
	});
});

describe("検索用 NFKC 正規化テキストから元の byte 範囲へ戻る", () => {
	const md = buildMarkdown("\r\n", true);
	const bytes = Buffer.from(md, "utf8");
	const { fragments } = chunkMarkdown(md, { maxBytes: 4096 });
	const tableFrag = fragments.find((f) => f.headingPath.at(-1) === "1.2 表")!;
	const nf = normalizeFragment(tableFrag.text, tableFrag.start);

	test("全角数字 １２３ を半角 123 で引くと、元の全角 byte 範囲（9 byte）に戻る", () => {
		const hits = nf.findAll("123");
		expect(hits.length).toBe(1);
		const slice = bytes.subarray(hits[0]!.start, hits[0]!.end).toString("utf8");
		expect(slice).toBe("１２３");
		expect(hits[0]!.end - hits[0]!.start).toBe(9);
	});
	test("半角カナ濁点 ｶﾞｲﾄﾞ（2 code point で 1 文字相当）を ガイド で引ける。正規化で長さが縮む例", () => {
		const hits = nf.findAll("ガイド");
		expect(hits.length).toBe(1);
		const slice = bytes.subarray(hits[0]!.start, hits[0]!.end).toString("utf8");
		expect(slice).toBe("ｶﾞｲﾄﾞ");
		expect(normalizeText(slice)).toBe("ガイド");
	});
	test("大文字小文字: abc で ABC に戻る", () => {
		const hits = nf.findAll("abc");
		expect(bytes.subarray(hits[0]!.start, hits[0]!.end).toString("utf8")).toBe("ABC");
	});
	test("展開する例: ㌔(1字) -> キロ(2字)、㈱ -> (株)、ﬁ -> fi、① -> 1。元の 1 字範囲に戻る", () => {
		const text = "# H\n\n単位㌔と㈱とﬁと①。\n";
		const b = Buffer.from(text, "utf8");
		const r = chunkMarkdown(text, { maxBytes: 4096 });
		const f = r.fragments[0]!;
		const n = normalizeFragment(f.text, f.start);
		const cases: [string, string][] = [["キロ", "㌔"], ["(株)", "㈱"], ["fi", "ﬁ"], ["1", "①"]];
		for (const [q, orig] of cases) {
			const hits = n.findAll(q);
			expect(hits.length).toBeGreaterThan(0);
			expect(b.subarray(hits[0]!.start, hits[0]!.end).toString("utf8")).toBe(orig);
		}
		// 部分一致（キ だけ）でも書記素単位に外側へ丸め、元の ㌔ 全体に戻る
		const part = n.findAll("キ");
		expect(b.subarray(part[0]!.start, part[0]!.end).toString("utf8")).toBe("㌔");
	});
	test("NFD の が（か+U+3099）を NFC の が で引き、元の 6 byte 範囲に戻る。ZWJ 絵文字・サロゲートが混ざる断片でも byte がずれない", () => {
		const f = fragments.find((x) => x.text.includes(GLYPHS.GA_NFD) && x.text.includes(GLYPHS.ZWJ_FAMILY))!;
		const n = normalizeFragment(f.text, f.start);
		const hits = n.findAll("が");
		expect(hits.length).toBeGreaterThan(0);
		const got = bytes.subarray(hits[0]!.start, hits[0]!.end).toString("utf8");
		expect(got.normalize("NFC")).toBe("が");
		expect(got).toBe(GLYPHS.GA_NFD);
		// 絵文字の後ろの語でも引用検証を通る
		const cafe = n.findAll("café");
		const range = cafe[0]!;
		const slice = bytes.subarray(range.start, range.end);
		expect(slice.toString("utf8")).toBe("café");
		// その範囲で digest を作り、検証が通る
		expect(verifyCitation(bytes, { ...range, sha256: sha256Hex(slice) }).ok).toBe(true);
	});
	test("性質: 全断片・全位置で、正規化後の任意部分文字列について、戻した範囲の原文を同じ手順で正規化すると部分文字列を含む", () => {
		let checked = 0;
		for (const frag of chunkMarkdown(md, { maxBytes: 256 }).fragments) {
			const n = normalizeFragment(frag.text, frag.start);
			for (let i = 0; i < n.normalized.length; i += 3) {
				const j = Math.min(n.normalized.length, i + 4);
				// 正規化後文字列の途中（サロゲートペアの片割れ）は切らない
				if (/[\udc00-\udfff]/.test(n.normalized[i]!)) continue;
				if (j < n.normalized.length && /[\udc00-\udfff]/.test(n.normalized[j]!)) continue;
				const r = n.toOriginal(i, j);
				const orig = bytes.subarray(r.start, r.end).toString("utf8");
				expect(normalizeText(orig).includes(n.normalized.slice(i, j))).toBe(true);
				expect(r.start).toBeGreaterThanOrEqual(frag.start);
				expect(r.end).toBeLessThanOrEqual(frag.end);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(100);
	});
	test("範囲外の正規化区間は拒否", () => {
		expect(() => nf.toOriginal(5, 5)).toThrow();
		expect(() => nf.toOriginal(0, nf.normalized.length + 1)).toThrow();
	});
});

describe("読み込み API の BOM の扱い（実測）", () => {
	test("Bun.file().text() は BOM を除去する。arrayBuffer() の bytes から ignoreBOM でデコードすれば BOM が残る", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(process.env.SPIKE_TMP ?? tmpdir(), "bom-"));
		try {
			const p = join(dir, "bom.md");
			writeFileSync(p, Buffer.from("﻿# t\nあ\n", "utf8"));
			const viaText = await Bun.file(p).text();
			expect(viaText.startsWith("﻿")).toBe(false);
			const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
			expect(bytes.length).toBe(Buffer.byteLength("﻿# t\nあ\n"));
			const r = chunkMarkdown(bytes, { maxBytes: 4096 });
			expect(r.hasBom).toBe(true);
			expect(r.fragments[0]!.start).toBe(0);
			expect(r.fragments[0]!.text.startsWith("﻿")).toBe(true);
			// 文字列から作り直すと BOM が無く、全 offset が 3 ずれる
			const rText = chunkMarkdown(viaText, { maxBytes: 4096 });
			expect(rText.bytes.length).toBe(bytes.length - 3);
			expect(rText.docSha256).not.toBe(r.docSha256);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
