import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TokenizerPort } from "../src/contracts/ports.js";
import { createCharclassTokenizer } from "../src/core/extract/index.js";
import {
	insideRepository,
	japaneseOnly,
	listNotes,
	measure,
	score,
	wilson,
} from "./kg-heldout.js";
import { scriptJson } from "./kg-heldout/page.js";

const made: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "kg-heldout-"));
	made.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(resolve(dir), { recursive: true, force: true });
});

/** Every Japanese run is a proper name: the sample has names to draw without a dictionary. */
const allProper: TokenizerPort = {
	id: "all-proper",
	tokenize: (text) =>
		createCharclassTokenizer()
			.tokenize(text)
			.map((t) => (t.kind === "noun" ? { ...t, proper: true } : t)),
};

describe("kg-heldout", () => {
	test("notes and output must lie outside the repository", () => {
		expect(insideRepository(resolve("."))).toBe(true);
		expect(insideRepository(resolve("scripts/x"))).toBe(true);
		expect(insideRepository(temp())).toBe(false);
		const notes = temp();
		writeFileSync(join(notes, "a.md"), "Lantern。");
		expect(() =>
			measure({ notes, out: resolve("verification/x"), tokenizers: [] }),
		).toThrow("outside the repository");
	});

	test("measure counts per tokenizer, draws a fixed sample, and writes a page no note escapes", () => {
		const notes = temp();
		mkdirSync(join(notes, "sub"));
		mkdirSync(join(notes, ".hidden"));
		writeFileSync(
			join(notes, "a.md"),
			"# 会議\n森田と高橋が浜松工場で Lantern を見た。\n",
		);
		writeFileSync(
			join(notes, "sub", "b.md"),
			"森田と高橋が話した。</script><img src=x onerror=alert(1)>\n```ts\nconst 秘密 = 1;\n```\n",
		);
		writeFileSync(join(notes, ".hidden", "c.md"), "隠れた森田。");
		writeFileSync(join(notes, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));
		expect(listNotes(notes).map((f) => f.slice(notes.length + 1))).toEqual([
			"a.md",
			"bad.md",
			"sub/b.md",
		]);
		const out = temp();
		const run = () =>
			measure({
				notes,
				out,
				tokenizers: [
					{ engine: "charclass", tokenizer: createCharclassTokenizer() },
					{ engine: "sudachi-napi", tokenizer: allProper },
				],
				sample: 3,
			});
		const { summary, items } = run();
		expect(summary).toMatchObject({
			documents: 2,
			skippedFiles: 1,
			sampledNames: 3,
		});
		const by = summary.tokenizers as Record<string, Record<string, number>>;
		expect(by.charclass?.japaneseOnlyProper).toBe(0);
		expect(by["sudachi-napi"]?.japaneseOnlyProper).toBeGreaterThanOrEqual(3);
		expect(by["sudachi-napi"]?.japaneseProperPairs).toBeGreaterThan(0);
		// Code is no name.
		expect(items.some((i) => i.kind === "name" && i.name === "秘密")).toBe(
			false,
		);
		// The same notes and seed draw the same sample.
		const again = run();
		expect(again.items).toEqual(items);
		const page = readFileSync(join(out, "judge.html"), "utf8");
		expect(page).not.toContain("</script><img");
		expect(page.match(/<\/script>/g)).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toEqual(
			again.summary,
		);
	});

	test("score counts the judgments of this sample only", () => {
		const notes = temp();
		writeFileSync(
			join(notes, "a.md"),
			"森田と高橋が浜松工場で会った。森田は東京へ。\n",
		);
		const out = temp();
		const { items } = measure({
			notes,
			out,
			tokenizers: [{ engine: "sudachi-napi", tokenizer: allProper }],
			sample: 4,
		});
		const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8"));
		const names = items.filter((i) => i.kind === "name");
		const edges = items.filter((i) => i.kind === "edge");
		const judgments: Record<string, string> = {};
		names.forEach((n, i) => {
			judgments[n.id] = i === 0 ? "not_proper" : "proper";
		});
		if (edges[0]) judgments[edges[0].id] = "C";
		const results = join(out, "judgments.json");
		writeFileSync(
			results,
			JSON.stringify({ sampleDigest: sample.sampleDigest, judgments }),
		);
		const s = score(out, results) as {
			names: Record<string, unknown>;
			edges: Record<string, unknown>;
		};
		expect(s.names.proper).toBe(names.length - 1);
		expect(s.names.not_proper).toBe(1);
		expect(s.names.properShare).toBe(
			+((names.length - 1) / names.length).toFixed(3),
		);
		expect(s.edges.C).toBe(edges.length > 0 ? 1 : 0);
		writeFileSync(
			results,
			JSON.stringify({ sampleDigest: "other", judgments }),
		);
		expect(() => score(out, results)).toThrow("another sample");
	});

	test("helpers", () => {
		expect(japaneseOnly("森田さくら")).toBe(true);
		expect(japaneseOnly("第2回")).toBe(true);
		expect(japaneseOnly("GPT-4カスタム")).toBe(false);
		expect(japaneseOnly("123")).toBe(false);
		expect(wilson(0, 0)).toBeNull();
		expect(wilson(6, 40)).toEqual([0.071, 0.291]);
		expect(scriptJson({ a: "</script>\u2028" })).toBe(
			'{"a":"\\u003c/script>\\u2028"}',
		);
	});
});
