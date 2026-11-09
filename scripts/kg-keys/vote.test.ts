import { describe, expect, test } from "bun:test";
import { RULES } from "./names.js";
import {
	buildVoteRequest,
	containmentCandidates,
	containsName,
	MAX_VOTE_CANDIDATES,
	parseVote,
	type VoteGroup,
} from "./vote.js";

const clean = (s: string) => RULES.apply(s).normalize("NFKC");
/** U+2028, which would start a new line of the prompt if it were not escaped. */
const LS = String.fromCharCode(0x2028);

describe("name rules (kg.md §8.6)", () => {
	test("a leading list number, code marks in brackets and 約 before a number are removed", () => {
		expect(clean("5. 配布の管理を正す（E5）")).toBe("配布の管理を正す");
		expect(clean("1. 公開の物差しを作る（E4、M1、M6）")).toBe(
			"公開の物差しを作る",
		);
		expect(clean("2）候補の絞り込み")).toBe("候補の絞り込み");
		expect(clean("約 7,000 token")).toBe("7,000 token");
	});
	test("versions, counts and other brackets stay", () => {
		expect(clean("0.0.4")).toBe("0.0.4");
		expect(clean("3.14")).toBe("3.14");
		expect(clean("3 つの信号")).toBe("3 つの信号");
		expect(clean("Graph Memory（Platform）")).toBe("Graph Memory(Platform)");
		// Versions and names that start with a number and a dot, and ASCII brackets of product names.
		expect(clean("1.x")).toBe("1.x");
		expect(clean("2.x の API")).toBe("2.x の API");
		expect(clean("3.js")).toBe("3.js");
		expect(clean("Amazon (S3)")).toBe("Amazon (S3)");
		// A name the rules would empty stays as it is.
		expect(clean("（E5）")).toBe("(E5)");
		expect(clean("約束")).toBe("約束");
	});
});

describe("contained names", () => {
	test("an ASCII word does not continue across either edge", () => {
		expect(containsName("mem0 oss", "mem0")).toBe(true);
		expect(containsName("mem0 oss", "oss")).toBe(true);
		expect(containsName("mem0ai", "mem0")).toBe(false);
		expect(containsName("mem0ai/mem0", "mem0")).toBe(true);
		expect(containsName("記憶の減衰", "減衰")).toBe(true);
		// Equal or longer is not contained.
		expect(containsName("mem0", "mem0")).toBe(false);
	});

	const group = (namespace: string, ...names: string[]): VoteGroup => ({
		members: names.map((name, i) => ({
			id: i,
			name,
			type: "t",
			description: "",
			namespace,
			cleaned: name,
		})),
	});

	test("a group is asked about the groups of its namespace whose names it contains, longest first", () => {
		const groups = [
			group("n", "mem0 の Platform"),
			group("n", "mem0"),
			group("n", "Platform", "platform"),
			group("other", "Platform"),
			group("n", "の"),
			group("n", "AI"),
		];
		expect(containmentCandidates(groups)).toEqual([
			// 「の」 is one character and AI a two-letter ASCII word: neither is a candidate.
			{ item: 0, candidates: [2, 1] },
		]);
	});

	test("at most MAX_VOTE_CANDIDATES candidates", () => {
		const parts = Array.from({ length: MAX_VOTE_CANDIDATES + 2 }, (_, i) =>
			group("n", `part${i}`),
		);
		const long = group("n", parts.map((_, i) => `part${i}`).join(" "));
		const [question] = containmentCandidates([long, ...parts]);
		expect(question?.candidates).toHaveLength(MAX_VOTE_CANDIDATES);
	});
});

describe("vote request and answer", () => {
	test("the answer schema allows only the shown ids and none", () => {
		const one = {
			members: [
				{
					id: 1,
					name: "a b",
					type: "t",
					description: `d${LS}e`,
					namespace: "n",
					cleaned: "a b",
				},
			],
		};
		const request = buildVoteRequest(one, [one, one], "instruction", 0);
		expect(request.outputSchema).toEqual({
			type: "object",
			properties: { same: { type: "string", enum: ["c1", "c2", "none"] } },
			required: ["same"],
			additionalProperties: false,
		});
		expect(request.prompt).not.toContain(LS);
		expect(request.prompt).toContain("\\u2028");
	});
	test("an answer is a shown id, none, or invalid", () => {
		expect(parseVote('{"same":"c2"}', 2)).toBe(1);
		expect(parseVote('{"same":"none"}', 2)).toBeNull();
		expect(parseVote('{"same":"c3"}', 2)).toBe("invalid");
		expect(parseVote('{"same":"c0"}', 2)).toBe("invalid");
		expect(parseVote('{"same":"c1","why":"x"}', 2)).toBe("invalid");
		expect(parseVote("c1", 2)).toBe("invalid");
	});
});
