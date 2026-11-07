import { createHash } from "node:crypto";
import { KnowledgeError } from "../contracts/index.js";

/** sha256 as lowercase hex over bytes (a leading BOM is part of the bytes). */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * UTF-8 bytes of a Markdown body, exactly as written (no BOM stripping, no newline change).
 * A string that does not survive the round trip holds a lone surrogate, which UTF-8 cannot
 * represent: it is refused instead of being silently replaced.
 */
export function utf8Bytes(markdown: string): Uint8Array {
	const bytes = Buffer.from(markdown, "utf8");
	if (bytes.toString("utf8") !== markdown) {
		throw new KnowledgeError("invalid_input");
	}
	return bytes;
}
