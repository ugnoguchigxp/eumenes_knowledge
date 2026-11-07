// spike: 引用 = { start, end, sha256 }（固定した Markdown 本文の UTF-8 byte 範囲 + その範囲の digest）。
import { sha256Hex } from "./chunker.ts";

export interface Citation { start: number; end: number; sha256: string }
export type CitationCheck =
	| { ok: true; text: string }
	| { ok: false; reason: "range" | "utf8_boundary" | "digest" };

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isContinuation = (b: number) => (b & 0xc0) === 0x80;

export function verifyCitation(doc: Uint8Array, c: Citation): CitationCheck {
	if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end < c.start || c.end > doc.length) return { ok: false, reason: "range" };
	if ((c.start < doc.length && isContinuation(doc[c.start]!)) || (c.end < doc.length && isContinuation(doc[c.end]!))) return { ok: false, reason: "utf8_boundary" };
	const slice = doc.subarray(c.start, c.end);
	if (sha256Hex(slice) !== c.sha256) return { ok: false, reason: "digest" };
	try {
		return { ok: true, text: strict.decode(slice) };
	} catch {
		return { ok: false, reason: "utf8_boundary" };
	}
}
