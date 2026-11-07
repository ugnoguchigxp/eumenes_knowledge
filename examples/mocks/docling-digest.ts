import { createHash } from "node:crypto";

/** sha256 of a string's UTF-8 bytes (a leading BOM character is part of the bytes). */
export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * The digest rule of `larm.docling-files.v1`, same as Eumenes' `documentDigests`:
 * `contentDigest = sha256(ascii(markdownSha256 + LF + recoverySha256))`.
 */
export function documentDigests(markdown: string, recovery: string) {
	const markdownSha256 = sha256Hex(markdown);
	const recoverySha256 = sha256Hex(recovery);
	return {
		markdownSha256,
		recoverySha256,
		contentDigest: sha256Hex(`${markdownSha256}\n${recoverySha256}`),
	};
}
