import { KnowledgeError } from "../contracts/errors.js";
import {
	INSTRUCTION_SET_DIGEST,
	instructionEntries,
	type InstructionEntry,
} from "./generated.js";

export { INSTRUCTION_SET_DIGEST };

/** One versioned instruction text, bundled as JS (nothing is read from disk at runtime). */
export type Instruction = InstructionEntry;

/** Every bundled instruction, ordered by id and then version. Empty until instructions are added. */
export const instructions: readonly Instruction[] = instructionEntries;

/**
 * Looks up `id` in `entries`: the exact `version` when given, otherwise the highest one.
 * Throws `KnowledgeError("not_available")` when there is no such instruction.
 */
export function findInstruction(
	entries: readonly Instruction[],
	id: string,
	version?: number,
): Instruction {
	let found: Instruction | undefined;
	for (const entry of entries) {
		if (entry.id !== id) continue;
		if (version !== undefined) {
			if (entry.version === version) found = entry;
		} else if (found === undefined || entry.version > found.version) {
			found = entry;
		}
	}
	if (found === undefined) throw new KnowledgeError("not_available");
	return found;
}

export function instruction(id: string, version?: number): Instruction {
	return findInstruction(instructions, id, version);
}
