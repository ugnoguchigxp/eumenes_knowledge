import type { TokenizerPort } from "../../contracts/index.js";
import { instruction } from "../../contexts/index.js";
import {
	createCharclassTokenizer,
	EXTRACT_INSTRUCTION_ID,
	namesModel,
} from "../extract/index.js";

/** The default extractor (kg2.md G7): the model's extraction is frozen. */
export const DEFAULT_EXTRACTOR = "names";

const charclass = createCharclassTokenizer();

/**
 * What extracts a version, as recorded with it (kg2.md G7): `names:<tokenizer>@rules<n>` (the
 * extraction's `model` string) or `model:<instruction>@<version>`. A published version recorded
 * with another value is extracted again when the extractor is `names`.
 */
export function extractorFingerprint(
	extractor: "model" | "names",
	tokenizer: Pick<TokenizerPort, "id"> | undefined,
): string {
	return extractor === "names"
		? namesModel(tokenizer ?? charclass)
		: `model:${EXTRACT_INSTRUCTION_ID}@${instruction(EXTRACT_INSTRUCTION_ID).version}`;
}
