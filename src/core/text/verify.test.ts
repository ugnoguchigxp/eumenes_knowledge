import { describe, expect, test } from "bun:test";
import type { Fragment } from "../../contracts/index.js";
import { chunkMarkdown } from "./chunk.js";
import { buildMarkdown } from "./markdown.fixture.js";
import { verifyFragments } from "./verify.js";

const md = buildMarkdown("\r\n", true);
const bytes = new TextEncoder().encode(md);
const good = chunkMarkdown(bytes, md, { maxBytes: 256 });
const codes = (fragments: readonly Fragment[], maxBytes = 256) =>
	verifyFragments(bytes, fragments, { maxBytes }).map((v) => v.code);
const withFragment = (i: number, patch: Partial<Fragment>) =>
	good.map((f, j) => (j === i ? { ...f, ...patch } : f));

describe("verifyFragments", () => {
	test("accepts the chunker's output", () => {
		expect(verifyFragments(bytes, good, { maxBytes: 256 })).toEqual([]);
	});

	test("empty body and empty list agree; a non-empty body needs fragments", () => {
		expect(verifyFragments(new Uint8Array(0), [])).toEqual([]);
		expect(verifyFragments(bytes, [])).toEqual([
			{ ordinal: null, code: "coverage" },
		]);
	});

	test("detects a gap", () => {
		const gap = good.map((f, i) =>
			i === 1 ? { ...f, byteStart: f.byteStart + 1 } : f,
		);
		expect(codes(gap)).toContain("continuity");
	});

	test("detects an overlap", () => {
		const overlap = withFragment(2, {
			byteStart: (good[2] as Fragment).byteStart - 1,
		});
		expect(codes(overlap)).toContain("continuity");
	});

	test("detects missing head and tail", () => {
		expect(codes(good.slice(1))).toContain("continuity");
		expect(
			verifyFragments(bytes, good.slice(0, -1), { maxBytes: 256 }),
		).toContainEqual({
			ordinal: null,
			code: "coverage",
		});
	});

	test("detects a wrong ordinal", () => {
		expect(codes(withFragment(1, { ordinal: 5 }))).toContain("ordinal");
	});

	test("detects a fragment over the bound", () => {
		expect(codes(good, 100)).toContain("too_large");
	});

	test("detects text that does not match the range", () => {
		expect(codes(withFragment(0, { text: "x" }))).toContain("text_mismatch");
	});

	test("detects a boundary inside a UTF-8 character", () => {
		const i = good.findIndex((f) => f.text.includes("日"));
		const f = good[i] as Fragment;
		const at = bytes.indexOf(
			new TextEncoder().encode("日")[0] as number,
			f.byteStart,
		);
		const cut = good.flatMap((g, j) =>
			j === i
				? [
						{ ...g, byteEnd: at + 1, text: "?" },
						{ ...g, ordinal: g.ordinal + 1, byteStart: at + 1, text: "?" },
					]
				: [{ ...g, ordinal: j > i ? j + 1 : j }],
		);
		expect(codes(cut)).toContain("utf8_boundary");
	});

	test("detects a cut between CR and LF", () => {
		const i = good.findIndex((f) => f.text.endsWith("\r\n"));
		const f = good[i] as Fragment;
		const cut = good.flatMap((g, j) =>
			j === i
				? [
						{ ...g, byteEnd: g.byteEnd - 1, text: g.text.slice(0, -1) },
						{
							...g,
							ordinal: g.ordinal + 1,
							byteStart: g.byteEnd - 1,
							text: "\n",
						},
					]
				: [{ ...g, ordinal: j > i ? j + 1 : j }],
		);
		expect(f.text.endsWith("\r\n")).toBe(true);
		expect(codes(cut)).toContain("crlf_split");
	});

	test("detects out-of-range and non-integer ranges", () => {
		expect(codes(withFragment(0, { byteEnd: bytes.length + 5 }))).toContain(
			"range",
		);
		expect(codes(withFragment(0, { byteStart: 0.5 }))).toContain("range");
		expect(codes(withFragment(0, { byteEnd: 0 }))).toContain("range");
	});

	test("stops at the limit", () => {
		const all = good.map((f) => ({ ...f, ordinal: 99 }));
		expect(
			verifyFragments(bytes, all, { maxBytes: 256, limit: 3 }),
		).toHaveLength(3);
	});
});
