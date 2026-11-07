import { describe, expect, test } from "bun:test";
import { MAX_FRAGMENT_BYTES } from "../../contracts/index.js";
import { sha256Hex } from "../bytes.js";
import { chunkMarkdown } from "./chunk.js";
import {
	buildMarkdown,
	E_ACUTE_NFD,
	FLAG,
	GA_NFD,
	randomMarkdown,
	THUMB,
	ZWJ_FAMILY,
} from "./markdown.fixture.js";
import { verifyFragments } from "./verify.js";

const encode = (text: string) => new TextEncoder().encode(text);
const chunk = (text: string, maxBytes?: number) =>
	chunkMarkdown(encode(text), text, maxBytes === undefined ? {} : { maxBytes });

/** Grapheme boundaries of the whole text as UTF-8 byte offsets (independent of the chunker). */
function graphemeBoundaries(text: string): Set<number> {
	const boundaries = new Set<number>();
	let b = 0;
	for (const s of new Intl.Segmenter("und", {
		granularity: "grapheme",
	}).segment(text)) {
		boundaries.add(b);
		b += Buffer.byteLength(s.segment);
	}
	boundaries.add(b);
	return boundaries;
}

const variants = [
	{ name: "LF", eol: "\n" as const, bom: false },
	{ name: "CRLF", eol: "\r\n" as const, bom: false },
	{ name: "LF+BOM", eol: "\n" as const, bom: true },
	{ name: "CRLF+BOM", eol: "\r\n" as const, bom: true },
];
const caps = [64, 65, 100, 128, 256, 512, 1000, 1024, 2048, 4096];

describe.each(variants)("chunkMarkdown $name", ({ eol, bom }) => {
	const md = buildMarkdown(eol, bom);
	const bytes = Buffer.from(md, "utf8");
	const boundaries = graphemeBoundaries(md);

	for (const maxBytes of caps) {
		test(`cap=${maxBytes}: ranges decode to text, sha256 matches, no gap or overlap`, () => {
			const fragments = chunk(md, maxBytes);
			expect(fragments.length).toBeGreaterThan(0);
			expect(verifyFragments(bytes, fragments, { maxBytes })).toEqual([]);
			expect(fragments[0]?.byteStart).toBe(0);
			expect(fragments.at(-1)?.byteEnd).toBe(bytes.length);
			for (const [i, f] of fragments.entries()) {
				expect(f.ordinal).toBe(i);
				expect(f.byteEnd - f.byteStart).toBeLessThanOrEqual(maxBytes);
				if (i > 0)
					expect(f.byteStart).toBe(fragments[i - 1]?.byteEnd as number);
				expect(
					Buffer.from(bytes.subarray(f.byteStart, f.byteEnd)).toString("utf8"),
				).toBe(f.text);
			}
			expect(fragments.map((f) => f.text).join("")).toBe(md);
			// The pieces, re-joined from the byte ranges, hash like the whole body.
			const rejoined = Buffer.concat(
				fragments.map((f) => bytes.subarray(f.byteStart, f.byteEnd)),
			);
			expect(sha256Hex(rejoined)).toBe(sha256Hex(bytes));
		});

		test(`cap=${maxBytes}: no boundary inside a grapheme cluster (CRLF included)`, () => {
			for (const f of chunk(md, maxBytes)) {
				expect(boundaries.has(f.byteStart)).toBe(true);
				expect(boundaries.has(f.byteEnd)).toBe(true);
			}
		});
	}

	test("default bound is MAX_FRAGMENT_BYTES", () => {
		const fragments = chunk(md);
		expect(fragments).toEqual(chunk(md, MAX_FRAGMENT_BYTES));
		expect(verifyFragments(bytes, fragments)).toEqual([]);
	});

	test("headings split the body; # in fences and frontmatter is not a heading", () => {
		const fragments = chunk(md, 4096);
		expect(fragments.map((f) => f.headingPath.join(">"))).toEqual([
			"",
			"",
			"第1章 はじめに",
			"第1章 はじめに>1.1 コードブロック",
			"第1章 はじめに>1.2 表",
			"第2章 長い行",
			"第2章 長い行>2.0.1 深い見出し",
		]);
		expect(fragments[0]?.text.startsWith(bom ? "﻿---" : "---")).toBe(true);
		expect(fragments[0]?.text).toContain("# yaml comment");
		expect(fragments[3]?.text).toContain("# これは見出しではない");
		expect(fragments[3]?.text).toContain("## これも見出しではない");
	});

	test("an oversized section keeps its heading path on every fragment", () => {
		const fragments = chunk(md, 100).filter(
			(f) => f.headingPath[0] === "第2章 長い行",
		);
		expect(fragments.length).toBeGreaterThan(3);
		for (const f of fragments) expect(f.headingPath[0]).toBe("第2章 長い行");
	});

	test("ZWJ emoji are never cut, and no fragment dangles on a ZWJ", () => {
		for (const f of chunk(md, 100)) {
			expect(f.text.startsWith("‍")).toBe(false);
			expect(f.text.endsWith("‍")).toBe(false);
		}
	});
});

describe("grapheme clusters", () => {
	const cluster = (unit: string) => `# H\n\n${unit.repeat(40)}\n`;
	const units = [
		["ZWJ family", ZWJ_FAMILY],
		["flag", FLAG],
		["skin tone", THUMB],
		["combining acute", `a${E_ACUTE_NFD}`],
		["decomposed ga", GA_NFD],
		["CRLF-separated lines", "あ\r\n"],
		["emoji", "😀"],
	] as const;
	for (const [name, unit] of units) {
		test(`${name}: every cap from 25 to 90 bytes cuts only between clusters`, () => {
			const md = cluster(unit);
			const bytes = encode(md);
			const boundaries = graphemeBoundaries(md);
			for (let cap = 25; cap <= 90; cap++) {
				const fragments = chunk(md, cap);
				expect(verifyFragments(bytes, fragments, { maxBytes: cap })).toEqual(
					[],
				);
				for (const f of fragments) {
					expect(boundaries.has(f.byteStart)).toBe(true);
					expect(boundaries.has(f.byteEnd)).toBe(true);
				}
			}
		});
	}

	test("a line is cut between clusters when it exceeds the bound", () => {
		const md = `${ZWJ_FAMILY.repeat(20)}\n`;
		const fragments = chunk(md, 64);
		expect(fragments.every((f) => f.byteEnd - f.byteStart <= 64)).toBe(true);
		for (const f of fragments.slice(0, -1)) {
			expect(f.text.replaceAll(ZWJ_FAMILY, "")).toBe("");
		}
	});

	test("never cuts between CR and LF", () => {
		const md = `# 見出し\r\n${"あ".repeat(21)}\r\nい\r\n`;
		for (let cap = 4; cap <= 80; cap++) {
			const fragments = chunk(md, cap);
			expect(fragments.map((f) => f.text).join("")).toBe(md);
			for (const f of fragments) {
				expect(f.text.endsWith("\r") && !f.text.endsWith("\r\n")).toBe(false);
				expect(f.text.startsWith("\n")).toBe(false);
			}
			expect(verifyFragments(encode(md), fragments, { maxBytes: cap })).toEqual(
				[],
			);
		}
	});

	test("one cluster over the bound is cut between code points, never inside a UTF-8 character", () => {
		const zalgo = `a${"́".repeat(80)}`; // 1 + 160 bytes, one grapheme
		const md = `# H\n\n${zalgo}😀\n`;
		const bytes = encode(md);
		const fragments = chunk(md, 64);
		expect(verifyFragments(bytes, fragments, { maxBytes: 64 })).toEqual([]);
		expect(fragments.map((f) => f.text).join("")).toBe(md);
		for (const f of fragments) {
			expect(f.byteEnd - f.byteStart).toBeLessThanOrEqual(64);
		}
	});

	test("emoji of 4 bytes with the smallest bound", () => {
		const md = "😀😀😀\n";
		const fragments = chunk(md, 4);
		expect(fragments.map((f) => f.text)).toEqual(["😀", "😀", "😀", "\n"]);
	});
});

describe("fenced code blocks", () => {
	const headings = (md: string) =>
		chunk(md, 4096)
			.map((f) => f.headingPath.join(">"))
			.filter((p) => p !== "");

	test("# inside ``` and ~~~ is not a heading", () => {
		const md = "# A\n```\n# no\n```\n~~~\n## no\n~~~\n## B\n";
		expect(headings(md)).toEqual(["A", "A>B"]);
	});

	test("a longer fence is closed only by an equal or longer fence of the same character", () => {
		const md = "# A\n````\n```\n# no\n~~~~\n# no\n````\n# B\n";
		expect(headings(md)).toEqual(["A", "B"]);
	});

	test("an unclosed fence runs to the end of the body", () => {
		const md = "# A\n```\n# no\ntext\n";
		expect(headings(md)).toEqual(["A"]);
	});

	test("a backtick fence with a backtick in its info string is not a fence", () => {
		const md = "# A\n``` a`b\n# B\n";
		expect(headings(md)).toEqual(["A", "B"]);
	});

	test("an indented fence marker (4 spaces) does not open a fence", () => {
		expect(headings("# A\n    ```\n# B\n")).toEqual(["A", "B"]);
	});

	test("blank lines inside a fence are not paragraph boundaries", () => {
		const code = "```\na\n\n\nb\n```\n";
		const md = `# A\n\n${"x".repeat(60)}\n\n${code}`;
		const fragments = chunk(md, 70);
		const withCode = fragments.find((f) => f.text.includes("```"));
		expect(withCode?.text.startsWith("```")).toBe(true);
		expect(withCode?.text).toContain("a\n\n\nb");
	});

	test("an oversized fenced block is still split by lines and covered", () => {
		const md = `# A\n\`\`\`\n${"# line\n".repeat(200)}\`\`\`\n`;
		const fragments = chunk(md, 64);
		expect(verifyFragments(encode(md), fragments, { maxBytes: 64 })).toEqual(
			[],
		);
		expect(fragments.filter((f) => f.headingPath.length > 0)).toHaveLength(
			fragments.length,
		);
		expect(fragments.every((f) => f.headingPath.join(">") === "A")).toBe(true);
	});
});

describe("headings", () => {
	const paths = (md: string) => chunk(md, 4096).map((f) => f.headingPath);

	test("levels nest, siblings and shallower headings pop the path", () => {
		const md = "# A\n## B\n### C\n## D\n# E\n### F\n";
		expect(paths(md)).toEqual([
			["A"],
			["A", "B"],
			["A", "B", "C"],
			["A", "D"],
			["E"],
			["E", "F"],
		]);
	});

	test("only 1-6 # followed by a space/tab or the end are headings; closing # are dropped", () => {
		const md =
			"#not\n####### seven\n    # indented\n#\t tab title ##  \n#\n## \n### x # y\n";
		const titles = chunk(md, 4096).map((f) => f.headingPath.at(-1));
		expect(titles).toEqual([undefined, "tab title", "", "", "x # y"]);
	});

	test("up to 3 leading spaces are allowed", () => {
		expect(paths("   # A\n")).toEqual([["A"]]);
	});

	test("the text before the first heading is its own fragment with an empty path", () => {
		const fragments = chunk("intro\n\n# A\nbody\n", 4096);
		expect(fragments.map((f) => [f.headingPath, f.text])).toEqual([
			[[], "intro\n\n"],
			[["A"], "# A\nbody\n"],
		]);
	});

	test("the returned paths are separate arrays", () => {
		const fragments = chunk("# A\n" + "line\n".repeat(100), 64);
		expect(fragments.length).toBeGreaterThan(2);
		expect(fragments[0]?.headingPath).not.toBe(fragments[1]?.headingPath);
	});
});

describe("frontmatter", () => {
	test("is part of the body: its own fragment, covered by byte ranges", () => {
		const md = "---\ntitle: x\n---\n\n# A\n";
		const fragments = chunk(md, 4096);
		expect(fragments.map((f) => f.text)).toEqual([
			"---\ntitle: x\n---\n\n",
			"# A\n",
		]);
		expect(chunk("\n\n# A\n", 4096).map((f) => f.text)).toEqual(["\n\n# A\n"]);
		expect(fragments[0]?.byteStart).toBe(0);
	});

	test("frontmatter only", () => {
		const fragments = chunk("---\na: 1\n---\n", 64);
		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.headingPath).toEqual([]);
	});

	test("`...` closes it; an unclosed --- is not frontmatter", () => {
		expect(chunk("---\na: 1\n...\n# A\n", 4096).map((f) => f.text)).toEqual([
			"---\na: 1\n...\n",
			"# A\n",
		]);
		const open = chunk("---\n# H\ntext\n", 4096);
		expect(open.map((f) => f.headingPath)).toEqual([[], ["H"]]);
	});

	test("a BOM before the opening --- is allowed and stays in the range", () => {
		const md = "﻿---\na: 1\n---\n# A\n";
		const fragments = chunk(md, 4096);
		expect(fragments.map((f) => f.headingPath)).toEqual([[], ["A"]]);
		expect(fragments[0]?.byteEnd).toBe(3 + "---\na: 1\n---\n".length);
	});

	test("a long frontmatter is split like any text", () => {
		const md = `---\n${"key: value\n".repeat(100)}---\n`;
		const fragments = chunk(md, 64);
		expect(verifyFragments(encode(md), fragments, { maxBytes: 64 })).toEqual(
			[],
		);
		expect(fragments.length).toBeGreaterThan(10);
	});
});

describe("paragraphs, lines", () => {
	test("paragraphs are packed, not cut mid-paragraph, when they fit", () => {
		const para = (n: number) => `${String(n).repeat(30)}\n\n`;
		const md = `# A\n\n${[1, 2, 3, 4, 5, 6].map(para).join("")}`;
		const fragments = chunk(md, 100);
		expect(fragments.map((f) => f.text).join("")).toBe(md);
		for (const f of fragments) {
			for (const p of f.text.split("\n\n")) {
				if (p.length > 0 && !p.startsWith("# A")) {
					expect(p).toMatch(/^(\d)\1{29}$/);
				}
			}
		}
	});

	test("an oversized paragraph is cut at line breaks first", () => {
		const lines = Array.from(
			{ length: 30 },
			(_, i) => `line ${String(i).padStart(2, "0")} ${"x".repeat(10)}`,
		);
		const md = `${lines.join("\n")}\n`;
		const fragments = chunk(md, 100);
		expect(fragments.length).toBeGreaterThan(3);
		for (const f of fragments) expect(f.text.endsWith("\n")).toBe(true);
	});

	test("a small paragraph before an oversized one is not mixed into the oversized one's lines", () => {
		const big = `${"y".repeat(200)}\n${"z".repeat(200)}\n`;
		const md = `small\n\n${big}`;
		const fragments = chunk(md, 250);
		expect(fragments[0]?.text).toBe("small\n\n");
	});

	test("lone CR line breaks", () => {
		const md = `# A\r${"text\r".repeat(50)}`;
		const fragments = chunk(md, 64);
		expect(verifyFragments(encode(md), fragments, { maxBytes: 64 })).toEqual(
			[],
		);
		expect(fragments[0]?.headingPath).toEqual(["A"]);
	});

	test("no trailing newline and a body of only newlines", () => {
		expect(chunk("text", 64).map((f) => f.text)).toEqual(["text"]);
		const blank = "\n\n\n";
		const fragments = chunk(blank, 64);
		expect(fragments.map((f) => f.text).join("")).toBe(blank);
		expect(chunk("﻿", 64).map((f) => f.text)).toEqual(["﻿"]);
	});

	test("leading blank lines stay with the first paragraph", () => {
		const fragments = chunk(`\n\n\nfirst\n\nsecond\n`, 12);
		expect(fragments.map((f) => f.text)).toEqual([
			"\n\n\nfirst\n\n",
			"second\n",
		]);
	});
});

describe("input checks", () => {
	test("empty body gives no fragment", () => {
		expect(chunkMarkdown(new Uint8Array(0), "")).toEqual([]);
	});

	test("text that is not exactly the decoded bytes is invalid_input", () => {
		const md = "﻿# 日本語\n";
		const bytes = encode(md);
		expect(chunkMarkdown(bytes, md)).toHaveLength(1);
		// BOM stripped by a default TextDecoder
		expect(() => chunkMarkdown(bytes, md.slice(1))).toThrow("invalid_input");
		expect(() => chunkMarkdown(bytes, "# 日本語\r\n")).toThrow("invalid_input");
		expect(() => chunkMarkdown(bytes, `${md}x`)).toThrow("invalid_input");
		expect(() => chunkMarkdown(bytes.subarray(0, 5), md)).toThrow(
			"invalid_input",
		);
	});

	test("a lone surrogate in text is refused, and so are invalid UTF-8 bytes", () => {
		const text = "a\uD800b";
		expect(() => chunkMarkdown(encode(text), text)).toThrow("invalid_input");
		const bad = new Uint8Array([0x61, 0xff, 0x62]);
		expect(() => chunkMarkdown(bad, "a\uFFFDb")).toThrow("invalid_input");
	});

	test("invalid maxBytes is refused", () => {
		for (const maxBytes of [
			0,
			3,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(() => chunkMarkdown(encode("a"), "a", { maxBytes })).toThrow(
				"invalid_input",
			);
		}
	});
});

describe("UTF-16 position confusion is detectable", () => {
	const md = buildMarkdown("\n", false);
	const bytes = encode(md);
	const fragments = chunk(md, 256);

	test("the fixture has more UTF-8 bytes than UTF-16 units", () => {
		expect(bytes.length).toBeGreaterThan(md.length * 1.4);
	});

	test("md.slice(byteStart, byteEnd) does not reproduce the text", () => {
		expect(
			fragments.some((f) => md.slice(f.byteStart, f.byteEnd) !== f.text),
		).toBe(true);
	});

	test("ranges taken from UTF-16 positions are rejected by verifyFragments", () => {
		let u = 0;
		const buggy = fragments.map((f) => {
			const range = { byteStart: u, byteEnd: u + f.text.length };
			u += f.text.length;
			return { ...f, ...range };
		});
		const codes = new Set(verifyFragments(bytes, buggy).map((v) => v.code));
		expect(codes.size).toBeGreaterThan(0);
		expect(codes.has("coverage")).toBe(true);
	});

	test("a BOM-stripped decoding shifts every range by 3 bytes", () => {
		const withBom = encode(buildMarkdown("\n", true));
		const stripped = new TextDecoder("utf-8").decode(withBom);
		expect(stripped.startsWith("﻿")).toBe(false);
		expect(() => chunkMarkdown(withBom, stripped)).toThrow("invalid_input");
		const kept = new TextDecoder("utf-8", { ignoreBOM: true }).decode(withBom);
		const withBomFragments = chunkMarkdown(withBom, kept, { maxBytes: 4096 });
		const plain = chunk(buildMarkdown("\n", false), 4096);
		expect(withBomFragments[0]?.byteEnd).toBe(
			(plain[0]?.byteEnd as number) + 3,
		);
		expect(withBomFragments[1]?.byteStart).toBe(
			(plain[1]?.byteStart as number) + 3,
		);
	});
});

describe("randomized documents", () => {
	test("invariants hold for 150 random bodies x caps", () => {
		for (let seed = 1; seed <= 150; seed++) {
			const md = randomMarkdown(seed);
			const bytes = encode(md);
			const boundaries = graphemeBoundaries(md);
			for (const cap of [26, 64, 100, 333, 2048]) {
				const fragments = chunk(md, cap);
				expect(verifyFragments(bytes, fragments, { maxBytes: cap })).toEqual(
					[],
				);
				for (const f of fragments) {
					expect(boundaries.has(f.byteStart)).toBe(true);
					expect(boundaries.has(f.byteEnd)).toBe(true);
				}
				expect(fragments.map((f) => f.text).join("")).toBe(md);
			}
		}
	});
});

describe("performance (8 MiB)", () => {
	const eightMiB = 8 * 2 ** 20;
	function build(unit: (i: number) => string): string {
		const parts: string[] = [];
		let size = 0;
		for (let i = 0; size < eightMiB; i++) {
			const part = unit(i);
			parts.push(part);
			size += Buffer.byteLength(part);
		}
		return parts.join("");
	}
	function time(md: string, maxBytes: number) {
		const bytes = encode(md);
		const start = performance.now();
		const fragments = chunkMarkdown(bytes, md, { maxBytes });
		const ms = performance.now() - start;
		return { bytes, fragments, ms };
	}

	test("many headings and paragraphs, cap 2048 and 256: under 1 second", () => {
		const md = build(
			(i) => `## 見出し${i}\n\n${"これはテスト用の合成文章。".repeat(8)}\n\n`,
		);
		for (const cap of [2048, 256]) {
			const { bytes, fragments, ms } = time(md, cap);
			console.log(
				`perf headings cap=${cap}: ${fragments.length} fragments, ${ms.toFixed(0)} ms`,
			);
			expect(bytes.length).toBeGreaterThanOrEqual(eightMiB);
			expect(ms).toBeLessThan(1000);
			expect(verifyFragments(bytes, fragments, { maxBytes: cap })).toEqual([]);
		}
	});

	test("no headings, oversized paragraphs of short lines: under 1 second", () => {
		const md = build(
			(i) =>
				`${Array.from({ length: 80 }, (_, j) => `行${i}-${j} text`).join("\n")}\n\n`,
		);
		const { bytes, fragments, ms } = time(md, 2048);
		console.log(
			`perf lines: ${fragments.length} fragments, ${ms.toFixed(0)} ms`,
		);
		expect(ms).toBeLessThan(1000);
		expect(verifyFragments(bytes, fragments)).toEqual([]);
	});

	test("a huge fenced block with many blank lines: under 1 second", () => {
		const md = `# A\n\`\`\`\n${build((i) => `# l${i}\n\n`)}\`\`\`\n`;
		const { bytes, fragments, ms } = time(md, 2048);
		console.log(
			`perf fence: ${fragments.length} fragments, ${ms.toFixed(0)} ms`,
		);
		expect(ms).toBeLessThan(1000);
		expect(verifyFragments(bytes, fragments)).toEqual([]);
	});

	test("CRLF with a BOM, only newlines and tiny lines: under 1 second", () => {
		const md = `﻿${build((i) => `${i % 7 === 0 ? "# h" : "a"}\r\n`)}`;
		const { bytes, fragments, ms } = time(md, 2048);
		console.log(
			`perf tiny lines: ${fragments.length} fragments, ${ms.toFixed(0)} ms`,
		);
		expect(ms).toBeLessThan(1000);
		expect(verifyFragments(bytes, fragments)).toEqual([]);
	});

	test("one 8 MiB line (grapheme-level cutting) stays linear", () => {
		const md = build(() => "日本語のとても長い一行。👨‍👩‍👧‍👦");
		const { bytes, fragments, ms } = time(md, 2048);
		console.log(
			`perf single line: ${fragments.length} fragments, ${ms.toFixed(0)} ms`,
		);
		expect(ms).toBeLessThan(5000);
		expect(verifyFragments(bytes, fragments)).toEqual([]);
	});
});

test("a BOM before the first heading does not hide it: headingPath includes it", () => {
	for (const eol of ["\n", "\r\n"]) {
		const text = `﻿# Title${eol}body${eol}## Sub${eol}x${eol}`;
		const bytes = Buffer.from(text, "utf8");
		for (const maxBytes of [12, 64, 2048]) {
			const fragments = chunkMarkdown(bytes, text, { maxBytes });
			expect(fragments.map((f) => f.text).join("")).toBe(text);
			expect(fragments[0]!.byteStart).toBe(0);
			expect(fragments[0]!.headingPath).toEqual(["Title"]);
			const sub = fragments.find((f) => f.text.includes("## Sub"))!;
			expect(sub.headingPath).toEqual(["Title", "Sub"]);
		}
	}
});
