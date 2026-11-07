import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	EXTRACTION_LIMITS,
	type EvidenceRange,
	type Fragment,
	type FragmentExtraction,
	type VerifiedEntity,
} from "../../contracts/index-data.js";
import type { InferenceResult, InferenceUsage } from "../../contracts/ports.js";
import { mergeGleaning, verifyExtraction } from "./verify.js";

const usage: InferenceUsage = {
	inputTokens: null,
	cachedTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	calls: null,
};
const ok = (text: string, model: string | null = "m-1"): InferenceResult => ({
	ok: true,
	text,
	model,
	usage,
	durationMs: 1,
});
const answer = (value: unknown) => ok(JSON.stringify(value));

const qualifiers = {
	negated: false,
	condition: null,
	certainty: "stated" as const,
};
const entity = (id: string, name: string, evidence: string[]) => ({
	id,
	name,
	type: "t",
	description: `d ${name}`,
	evidence,
});
const relation = (
	id: string,
	source: string,
	target: string,
	evidence: string[],
	directed = false,
) => ({
	id,
	source,
	target,
	directed,
	relation: "r",
	description: "d",
	keywords: [],
	qualifiers,
	evidence,
});

/** A fragment taken from `body` (a string, BOM allowed) at the given UTF-16 range. */
function fragmentOf(
	body: string,
	start: number,
	end: number,
	ordinal = 0,
): Fragment {
	return {
		ordinal,
		byteStart: Buffer.byteLength(body.slice(0, start), "utf8"),
		byteEnd: Buffer.byteLength(body.slice(0, end), "utf8"),
		headingPath: [],
		text: body.slice(start, end),
	};
}

const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** The original text a range stands for, and whether its digest matches. */
function restore(body: string, range: EvidenceRange) {
	const bytes = Buffer.from(body, "utf8").subarray(
		range.byteStart,
		range.byteEnd,
	);
	return { text: bytes.toString("utf8"), digest: sha(bytes) };
}

const body =
	"# 概要\n\n田中太郎は東京の本社に勤める。\n鈴木花子は田中太郎の上司である。\n";
const fragment = fragmentOf(body, 0, body.length);

function okValue(result: FragmentExtraction) {
	if (result.status !== "ok") throw new Error(`failed: ${result.errorCode}`);
	return result;
}

describe("verifyExtraction: a valid answer", () => {
	test("keeps records, locates quotes and copies the model", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [
						entity("e1", "田中太郎", ["田中太郎は東京の本社に勤める"]),
						entity("e2", "鈴木花子", ["鈴木花子は田中太郎の上司である"]),
					],
					relations: [
						relation(
							"r1",
							"e2",
							"e1",
							["鈴木花子は田中太郎の上司である"],
							true,
						),
					],
				}),
			),
		);
		expect(result.fragmentOrdinal).toBe(0);
		expect(result.model).toBe("m-1");
		expect(result.dropped).toEqual([]);
		expect(result.entities.map((e) => e.name)).toEqual([
			"田中太郎",
			"鈴木花子",
		]);
		expect(result.relations).toHaveLength(1);
		const firstRange = result.entities[0]?.evidence[0] as EvidenceRange;
		expect(firstRange).toMatchObject({ fragmentOrdinal: 0, ambiguous: false });
		const restored = restore(body, firstRange);
		expect(restored.text).toBe("田中太郎は東京の本社に勤める");
		expect(restored.digest).toBe(firstRange.quoteSha256);
		expect(result.relations[0]?.directed).toBe(true);
		expect(result.relations[0]?.qualifiers).toEqual(qualifiers);
		expect("evidence" in (result.entities[0] as object)).toBe(true);
	});

	test("empty lists are valid, null model is copied, surrounding whitespace is allowed", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				ok('\n  {"entities":[],"relations":[]}\r\n\t', null),
			),
		);
		expect(result).toMatchObject({ entities: [], relations: [], model: null });
	});
});

describe("verifyExtraction: byte ranges", () => {
	test.each([
		["BOM and Japanese", "﻿# 見出し\n\n前置き。\n本文はここから始まる。"],
		["emoji before the quote", "😀😀 絵文字の後に「引用される語」がある 🎉。"],
		["CRLF and combining marks", "a\r\nb\r\nがら゙ 後ろ👨‍👩‍👧の語"],
	])("%s: range restores the quote and its sha256", (_name, text) => {
		// The fragment starts in the middle of the body, after a prefix with multi-byte text.
		const prefix = "冒頭😀の文章\n";
		const doc = `${prefix}${text}`;
		const frag = fragmentOf(doc, prefix.length, doc.length, 3);
		const quotes = [...text.matchAll(/[^\s]{2,}/gu)].map((m) => m[0]);
		expect(quotes.length).toBeGreaterThan(1);
		const result = okValue(
			verifyExtraction(
				frag,
				answer({
					entities: quotes.map((q, i) => entity(`e${i + 1}`, q, [q])),
					relations: [],
				}),
			),
		);
		expect(result.fragmentOrdinal).toBe(3);
		expect(result.entities).toHaveLength(quotes.length);
		for (const [i, e] of result.entities.entries()) {
			const range = e.evidence[0] as EvidenceRange;
			const restored = restore(doc, range);
			expect(restored.text).toBe(quotes[i] as string);
			expect(restored.digest).toBe(range.quoteSha256);
			expect(range.byteStart).toBeGreaterThanOrEqual(frag.byteStart);
			expect(range.byteEnd).toBeLessThanOrEqual(frag.byteEnd);
		}
	});

	test("a quote after a BOM in the fragment itself uses byte (not UTF-16) offsets", () => {
		const doc = "﻿あ😀い";
		const frag = fragmentOf(doc, 0, doc.length);
		const result = okValue(
			verifyExtraction(
				frag,
				answer({ entities: [entity("e1", "い", ["い"])], relations: [] }),
			),
		);
		const range = (result.entities[0] as VerifiedEntity).evidence[0];
		// BOM 3 + あ 3 + emoji 4 = 10
		expect(range).toMatchObject({ byteStart: 10, byteEnd: 13 });
	});

	test("a quote occurring twice uses the first position and is ambiguous", () => {
		const doc = "前置き。東京。中間。東京。末尾";
		const frag = fragmentOf(doc, 0, doc.length);
		const result = okValue(
			verifyExtraction(
				frag,
				answer({ entities: [entity("e1", "東京", ["東京"])], relations: [] }),
			),
		);
		const range = (result.entities[0] as VerifiedEntity)
			.evidence[0] as EvidenceRange;
		expect(range.ambiguous).toBe(true);
		expect(range.byteStart).toBe(Buffer.byteLength("前置き。", "utf8"));
		expect(restore(doc, range).text).toBe("東京");
	});

	test("duplicate quotes of one element collapse to one range", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [entity("e1", "田中太郎", ["田中太郎は", "田中太郎は"])],
					relations: [],
				}),
			),
		);
		expect(result.entities[0]?.evidence).toHaveLength(1);
	});
});

describe("verifyExtraction: dropped elements", () => {
	test("a quote that is not in the fragment is dropped; the element stays on its other quote", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [entity("e1", "田中太郎", ["言い換えた文", "田中太郎は"])],
					relations: [],
				}),
			),
		);
		expect(result.entities).toHaveLength(1);
		expect(result.entities[0]?.evidence).toHaveLength(1);
		expect(result.dropped).toEqual([{ reason: "not_in_fragment", count: 1 }]);
	});

	test("an element with no surviving quote is dropped (no_evidence), relations to it with unknown_entity", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [
						entity("e1", "田中太郎", ["田中太郎は"]),
						entity("e2", "存在しない人", ["存在しない引用"]),
					],
					relations: [
						relation("r1", "e1", "e2", ["田中太郎は"]),
						relation("r2", "e2", "e1", ["田中太郎は"]),
						relation("r3", "e1", "e1", ["全く違う文"]),
					],
				}),
			),
		);
		expect(result.entities.map((e) => e.id)).toEqual(["e1"]);
		expect(result.relations).toEqual([]);
		expect(result.dropped).toEqual([
			{ reason: "not_in_fragment", count: 2 },
			{ reason: "no_evidence", count: 2 },
			{ reason: "unknown_entity", count: 2 },
		]);
	});

	test("a relation naming an id the answer never defines is dropped", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [entity("e1", "田中太郎", ["田中太郎は"])],
					relations: [relation("r1", "e1", "e9", ["田中太郎は"])],
				}),
			),
		);
		expect(result.relations).toEqual([]);
		expect(result.dropped).toEqual([{ reason: "unknown_entity", count: 1 }]);
	});

	test("a later duplicate id is dropped, even when the earlier one was dropped too", () => {
		const result = okValue(
			verifyExtraction(
				fragment,
				answer({
					entities: [
						entity("e1", "田中太郎", ["田中太郎は"]),
						entity("e1", "鈴木花子", ["鈴木花子は"]),
						entity("e2", "消える", ["無い引用"]),
						entity("e2", "二つ目", ["鈴木花子は"]),
					],
					relations: [
						relation("r1", "e1", "e1", ["田中太郎は"]),
						relation("r1", "e1", "e1", ["鈴木花子は"]),
					],
				}),
			),
		);
		expect(result.entities.map((e) => e.name)).toEqual(["田中太郎"]);
		expect(result.relations).toHaveLength(1);
		expect(result.dropped).toEqual([
			{ reason: "not_in_fragment", count: 1 },
			{ reason: "no_evidence", count: 1 },
			{ reason: "duplicate_id", count: 3 },
		]);
	});

	test("a quote with a lone surrogate never matches half of a character", () => {
		const doc = "絵文字😀です";
		const frag = fragmentOf(doc, 0, doc.length);
		const result = okValue(
			verifyExtraction(
				frag,
				ok(
					'{"entities":[{"id":"e1","name":"x","type":"t","description":"d","evidence":["\\ud83d","\\ude00"]}],"relations":[]}',
				),
			),
		);
		expect(result.entities).toEqual([]);
		expect(result.dropped).toEqual([
			{ reason: "not_in_fragment", count: 2 },
			{ reason: "no_evidence", count: 1 },
		]);
	});
});

describe("verifyExtraction: failures", () => {
	const failedCode = (result: InferenceResult) => {
		const value = verifyExtraction(fragment, result);
		if (value.status !== "failed") throw new Error("expected failed");
		return value;
	};

	test("ok:false is inference_failed and keeps the model, not the provider's code", () => {
		const value = failedCode({
			ok: false,
			error: "provider_secret_code",
			model: "m-2",
			usage,
			durationMs: 1,
		});
		expect(value).toEqual({
			fragmentOrdinal: 0,
			status: "failed",
			errorCode: "inference_failed",
			model: "m-2",
		});
	});

	test.each([
		["not JSON", "これは JSON ではない"],
		["empty", ""],
		["code fence", '```json\n{"entities":[],"relations":[]}\n```'],
		["leading prose", 'はい。{"entities":[],"relations":[]}'],
		["trailing prose", '{"entities":[],"relations":[]} 以上です'],
		["BOM before the JSON", '﻿{"entities":[],"relations":[]}'],
		["truncated", '{"entities":[{"id":"e1"'],
		["trailing comma", '{"entities":[],"relations":[],}'],
	])("%s is invalid_json", (_name, text) => {
		expect(failedCode(ok(text)).errorCode).toBe("invalid_json");
	});

	test("the failed value carries no answer text", () => {
		const text = "秘密の本文を含む不正な応答";
		expect(JSON.stringify(failedCode(ok(text)))).not.toContain("秘密");
	});

	const valid = () => ({
		entities: [entity("e1", "田中太郎", ["田中太郎は"])],
		relations: [] as unknown[],
	});
	test.each([
		["JSON null", null],
		["an array", []],
		["missing relations", { entities: [] }],
		["unknown top-level key", { ...valid(), extra: 1 }],
		[
			"unknown key in an entity",
			{
				entities: [{ ...entity("e1", "a", ["田中"]), note: "x" }],
				relations: [],
			},
		],
		[
			"wrong type",
			{
				entities: [{ ...entity("e1", "a", ["田中"]), name: 3 }],
				relations: [],
			},
		],
		["bad id", { entities: [entity("x1", "a", ["田中"])], relations: [] }],
		["empty evidence", { entities: [entity("e1", "a", [])], relations: [] }],
		[
			"too many entities",
			{
				entities: Array.from(
					{ length: EXTRACTION_LIMITS.entities + 1 },
					(_, i) => entity(`e${i + 1}`, "a", ["田中"]),
				),
				relations: [],
			},
		],
		[
			"too many relations",
			{
				entities: [entity("e1", "a", ["田中"])],
				relations: Array.from(
					{ length: EXTRACTION_LIMITS.relations + 1 },
					(_, i) => relation(`r${i + 1}`, "e1", "e1", ["田中"]),
				),
			},
		],
		[
			"too long name",
			{
				entities: [
					entity("e1", "あ".repeat(EXTRACTION_LIMITS.nameChars + 1), ["田中"]),
				],
				relations: [],
			},
		],
		[
			"too long quote",
			{
				entities: [
					entity("e1", "a", ["あ".repeat(EXTRACTION_LIMITS.quoteChars + 1)]),
				],
				relations: [],
			},
		],
		[
			"bad certainty",
			{
				entities: [entity("e1", "a", ["田中"])],
				relations: [
					{
						...relation("r1", "e1", "e1", ["田中"]),
						qualifiers: { ...qualifiers, certainty: "maybe" },
					},
				],
			},
		],
	])("%s is schema_violation", (_name, value) => {
		expect(failedCode(answer(value)).errorCode).toBe("schema_violation");
	});

	test("the limits themselves are accepted", () => {
		const entities = Array.from(
			{ length: EXTRACTION_LIMITS.entities },
			(_, i) =>
				entity(`e${i + 1}`, "あ".repeat(EXTRACTION_LIMITS.nameChars), ["田中"]),
		);
		const value = verifyExtraction(
			fragment,
			answer({ entities, relations: [] }),
		);
		expect(value.status).toBe("ok");
	});
});

describe("mergeGleaning", () => {
	const doc = "田中は東京にいる。鈴木は大阪にいる。山田は京都にいる。";
	const frag = fragmentOf(doc, 0, doc.length, 2);
	const run = (value: unknown) =>
		okValue(verifyExtraction(frag, answer(value)));
	const withModel = (value: FragmentExtraction, model: string | null) =>
		({ ...value, model }) as FragmentExtraction;

	test("renumbers ids so the second pass cannot collide, and relations keep their own entities", () => {
		const first = run({
			entities: [
				entity("e1", "田中", ["田中は"]),
				entity("e2", "東京", ["東京に"]),
			],
			relations: [relation("r1", "e1", "e2", ["田中は東京に"])],
		});
		const second = run({
			entities: [
				entity("e1", "鈴木", ["鈴木は"]),
				entity("e2", "大阪", ["大阪に"]),
				entity("e3", "存在しない", ["ない引用"]),
			],
			relations: [relation("r1", "e1", "e2", ["鈴木は大阪に"])],
		});
		const merged = okValue(mergeGleaning(first, second));
		expect(merged.entities.map((e) => [e.id, e.name])).toEqual([
			["e1", "田中"],
			["e2", "東京"],
			["e3", "鈴木"],
			["e4", "大阪"],
		]);
		expect(merged.relations.map((r) => [r.id, r.source, r.target])).toEqual([
			["r1", "e1", "e2"],
			["r2", "e3", "e4"],
		]);
		expect(merged.fragmentOrdinal).toBe(2);
		expect(merged.dropped).toEqual([
			{ reason: "not_in_fragment", count: 1 },
			{ reason: "no_evidence", count: 1 },
		]);
		const ids = merged.entities.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		// the evidence still restores the original text
		const range = merged.entities[3]?.evidence[0] as EvidenceRange;
		expect(restore(doc, range).text).toBe("大阪に");
	});

	test("dropped counts add up per reason; model prefers the first pass", () => {
		const a = run({
			entities: [entity("e1", "x", ["ない"])],
			relations: [],
		});
		const b = run({
			entities: [entity("e1", "y", ["ない"])],
			relations: [],
		});
		const merged = okValue(
			mergeGleaning(withModel(a, null), withModel(b, "second")),
		);
		expect(merged.dropped).toEqual([
			{ reason: "not_in_fragment", count: 2 },
			{ reason: "no_evidence", count: 2 },
		]);
		expect(merged.model).toBe("second");
		expect(okValue(mergeGleaning(withModel(a, "first"), b)).model).toBe(
			"first",
		);
	});

	test("a failed second pass leaves the first; a failed first pass is returned as it is", () => {
		const first = run({
			entities: [entity("e1", "田中", ["田中は"])],
			relations: [],
		});
		const bad = verifyExtraction(frag, ok("x"));
		expect(mergeGleaning(first, bad)).toBe(first);
		expect(mergeGleaning(bad, first)).toBe(bad);
	});

	test("results of different fragments are refused", () => {
		const a = run({ entities: [], relations: [] });
		const other = { ...a, fragmentOrdinal: 9 } as FragmentExtraction;
		expect(() => mergeGleaning(a, other)).toThrow(RangeError);
	});
});
