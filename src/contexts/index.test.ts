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

test("P1 ships no instruction, and asking for one fails with not_available", () => {
	expect(instructions).toHaveLength(0);
	expect(() => instruction("extract-entities")).toThrow(KnowledgeError);
	try {
		instruction("extract-entities", 1);
	} catch (error) {
		expect((error as KnowledgeError).code).toBe("not_available");
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
