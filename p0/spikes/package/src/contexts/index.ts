import { INSTRUCTION_SET_DIGEST, instructionEntries } from "./generated.js";

export { INSTRUCTION_SET_DIGEST };

export interface Instruction {
	readonly id: string;
	readonly version: number;
	readonly sha256: string;
	readonly text: string;
}

/** Versioned instruction resources, bundled as JS (no file reads at runtime). */
export const instructions: readonly Instruction[] = instructionEntries;

export function instruction(id: string): Instruction {
	const found = instructions.find((item) => item.id === id);
	if (!found) throw new Error(`instruction_unknown:${id}`);
	return found;
}
