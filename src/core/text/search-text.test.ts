import { describe, expect, test } from "bun:test";
import { normalizeForSearch } from "./normalize.js";
import { byteOffsetOfIndex, buildByteMap, utf8ByteLength } from "./offsets.js";

describe("normalizeForSearch", () => {
	test("NFKC: full-width alphanumerics become ASCII", () => {
		expect(normalizeForSearch("ＡＢＣ１２３")).toBe("abc123");
	});

	test("NFKC: half-width katakana (with dakuten) become full-width", () => {
		expect(normalizeForSearch("ｶﾞｲﾄﾞ")).toBe("ガイド");
		expect(normalizeForSearch("ﾃｽﾄ")).toBe("テスト");
	});

	test("NFKC: compatibility characters expand", () => {
		expect(normalizeForSearch("㌔")).toBe("キロ");
		expect(normalizeForSearch("㈱")).toBe("(株)");
		expect(normalizeForSearch("ﬁ")).toBe("fi");
		expect(normalizeForSearch("①")).toBe("1");
	});

	test("NFKC composes decomposed forms", () => {
		expect(normalizeForSearch("é")).toBe("é");
		expect(normalizeForSearch("が")).toBe("が");
	});

	test("lower case", () => {
		expect(normalizeForSearch("Hello WORLD")).toBe("hello world");
		expect(normalizeForSearch("ÀÉ")).toBe("àé");
	});

	test("does not depend on the process locale (Turkish dotted I stays root-locale)", () => {
		expect(normalizeForSearch("I")).toBe("i");
		expect(normalizeForSearch("İ")).toBe("i̇");
	});

	test("full-width upper case reaches the same form as ASCII lower case", () => {
		expect(normalizeForSearch("ＤＯＣ")).toBe(normalizeForSearch("doc"));
	});

	test("is idempotent and keeps the empty string", () => {
		expect(normalizeForSearch("")).toBe("");
		for (const s of ["㌔Ａ", "ｶﾞ", "ÀÉ", "日本語 Text"]) {
			expect(normalizeForSearch(normalizeForSearch(s))).toBe(
				normalizeForSearch(s),
			);
		}
	});
});

describe("utf8ByteLength", () => {
	const samples = ["", "a", "é", "日本語", "😀", "a日😀b", "👨‍👩‍👧‍👦", "﻿", "\r\n"];
	test("matches the encoder", () => {
		for (const s of samples) {
			expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
		}
	});
	test("a lone surrogate counts as its replacement character", () => {
		for (const s of [
			"\uD800",
			"\uDC00",
			"a\uD800",
			"\uD800a",
			"\uDC00\uD800",
		]) {
			expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
		}
	});
});

describe("byteOffsetOfIndex", () => {
	const s = "aé日😀b";
	test("converts UTF-16 positions to UTF-8 byte offsets", () => {
		expect(byteOffsetOfIndex(s, 0)).toBe(0);
		expect(byteOffsetOfIndex(s, 1)).toBe(1);
		expect(byteOffsetOfIndex(s, 2)).toBe(3);
		expect(byteOffsetOfIndex(s, 3)).toBe(6);
		expect(byteOffsetOfIndex(s, 5)).toBe(10);
		expect(byteOffsetOfIndex(s, s.length)).toBe(11);
		expect(byteOffsetOfIndex(s, s.length)).toBe(Buffer.byteLength(s));
	});
	test("UTF-16 position and byte offset differ for non-ASCII text", () => {
		const index = s.indexOf("b");
		expect(index).toBe(5);
		expect(byteOffsetOfIndex(s, index)).not.toBe(index);
	});
	test("refuses the middle of a surrogate pair, out of range and non-integers", () => {
		expect(() => byteOffsetOfIndex(s, 4)).toThrow("invalid_input");
		expect(() => byteOffsetOfIndex(s, -1)).toThrow("invalid_input");
		expect(() => byteOffsetOfIndex(s, s.length + 1)).toThrow("invalid_input");
		expect(() => byteOffsetOfIndex(s, 1.5)).toThrow("invalid_input");
	});
	test("a body with a BOM counts the BOM's 3 bytes", () => {
		expect(byteOffsetOfIndex("﻿a", 1)).toBe(3);
	});
});

describe("buildByteMap", () => {
	test("maps every UTF-16 position; the low half of a pair repeats", () => {
		const s = "aé日😀b";
		const m = buildByteMap(s);
		expect(Array.from(m)).toEqual([0, 1, 3, 6, 6, 10, 11]);
		for (let i = 0; i <= s.length; i++) {
			if (i === 4) continue;
			expect(m[i]).toBe(byteOffsetOfIndex(s, i));
		}
	});
});
