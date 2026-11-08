import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { KnowledgeError } from "../contracts/errors.js";
import {
	INSTRUCTION_SET_DIGEST,
	findInstruction,
	instruction,
	instructions,
	type Instruction,
} from "./index.js";

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");
const make = (id: string, version: number): Instruction => ({
	id,
	version,
	text: `${id} v${version}`,
	sha256: sha256(`${id} v${version}`),
});

test("the bundled set is consistent: ordered, hashes match the text, set digest matches", () => {
	const lines = instructions.map((i) => `${i.id}@${i.version}:${i.sha256}`);
	expect(INSTRUCTION_SET_DIGEST).toBe(sha256(lines.join("\n")));
	for (const entry of instructions)
		expect(sha256(entry.text)).toBe(entry.sha256);
	const keys = instructions.map(
		(i) => `${i.id}\0${String(i.version).padStart(9, "0")}`,
	);
	expect(keys).toEqual([...keys].sort());
});

test("the shipped instructions are extract v1 and v2, link v1 and v2, and summarize v1; an unknown id or version fails with not_available", () => {
	expect(instructions.map((i) => [i.id, i.version])).toEqual([
		["extract", 1],
		["extract", 2],
		["link", 1],
		["link", 2],
		["summarize", 1],
	]);
	// The latest extract instruction is v2; v1 stays shipped.
	expect(instruction("extract").version).toBe(2);
	expect(instruction("extract", 1).version).toBe(1);
	// The latest link instruction is v2; v1 stays shipped (decisions recorded under it stay valid).
	expect(instruction("link").version).toBe(2);
	expect(instruction("link", 1).text).not.toBe(instruction("link", 2).text);
	expect(instruction("link", 2).text).toContain("同じ文書の別の箇所から");
	// The adaptation is traceable from the shipped text (THIRD_PARTY_NOTICES.md, manifest).
	expect(instruction("extract", 1).text).toContain(
		"aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a",
	);
	// v2 is the same adaptation: it keeps the upstream note and adds the rule about document structure.
	expect(instruction("extract", 2).text).toContain(
		"aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a",
	);
	expect(instruction("extract", 2).text).toContain(
		"文書自身の構造は対象にしません",
	);
	expect(instruction("extract", 1).text).not.toContain(
		"文書自身の構造は対象にしません",
	);
	for (const call of [
		() => instruction("extract-entities"),
		() => instruction("extract", 3),
	]) {
		expect(call).toThrow(KnowledgeError);
		try {
			call();
		} catch (error) {
			expect((error as KnowledgeError).code).toBe("not_available");
		}
	}
});

test("findInstruction returns the exact version, or the highest one without a version", () => {
	const set = [make("a", 1), make("a", 3), make("a", 2), make("b", 1)];
	expect(findInstruction(set, "a").version).toBe(3);
	expect(findInstruction(set, "a", 2).text).toBe("a v2");
	expect(findInstruction(set, "b").id).toBe("b");
	expect(() => findInstruction(set, "a", 4)).toThrow(KnowledgeError);
	expect(() => findInstruction(set, "c")).toThrow(KnowledgeError);
	expect(() => findInstruction([], "a")).toThrow(KnowledgeError);
});
