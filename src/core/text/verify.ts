import { type Fragment, MAX_FRAGMENT_BYTES } from "../../contracts/index.js";

export type FragmentViolationCode =
	/** `ordinal` is not its index. */
	| "ordinal"
	/** `byteStart`/`byteEnd` are not integers, or are outside the bytes, or the range is empty. */
	| "range"
	/** The fragment does not start where the previous one ended (gap or overlap), or the first one does not start at 0. */
	| "continuity"
	/** The fragments stop before the end of the bytes (or none cover non-empty bytes). */
	| "coverage"
	/** More than `maxBytes` bytes. */
	| "too_large"
	/** A boundary falls inside a UTF-8 character. */
	| "utf8_boundary"
	/** The bytes of the range do not decode to `text`. */
	| "text_mismatch"
	/** A boundary falls between the CR and the LF of a CRLF. */
	| "crlf_split";

export type FragmentViolation = {
	/** `null` for a violation of the whole list. */
	ordinal: number | null;
	code: FragmentViolationCode;
};

export type VerifyFragmentsOptions = {
	/** Default `MAX_FRAGMENT_BYTES`. */
	maxBytes?: number;
	/** Stop collecting after this many violations. Default 1000. */
	limit?: number;
};

const strictDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});
const isContinuation = (b: number) => (b & 0xc0) === 0x80;

/**
 * Checks the invariants of a fragment list against the exact UTF-8 bytes of the body (BOM
 * included): ordinals, no gap or overlap, full coverage, the size bound, UTF-8 and CRLF
 * boundaries, and that each range decodes to its `text`. Returns the violations; an empty
 * array means all hold. It does not judge where headings or paragraphs are.
 */
export function verifyFragments(
	bytes: Uint8Array,
	fragments: readonly Fragment[],
	options: VerifyFragmentsOptions = {},
): FragmentViolation[] {
	const max = options.maxBytes ?? MAX_FRAGMENT_BYTES;
	const limit = options.limit ?? 1000;
	const out: FragmentViolation[] = [];
	const add = (ordinal: number | null, code: FragmentViolationCode) => {
		if (out.length < limit) out.push({ ordinal, code });
	};

	let expectedStart = 0;
	for (let i = 0; i < fragments.length && out.length < limit; i++) {
		const f = fragments[i] as Fragment;
		if (f.ordinal !== i) add(i, "ordinal");
		const { byteStart, byteEnd } = f;
		if (
			!Number.isInteger(byteStart) ||
			!Number.isInteger(byteEnd) ||
			byteStart < 0 ||
			byteEnd <= byteStart ||
			byteEnd > bytes.length
		) {
			add(i, "range");
			expectedStart = Number.isInteger(byteEnd) ? byteEnd : expectedStart;
			continue;
		}
		if (byteStart !== expectedStart) add(i, "continuity");
		expectedStart = byteEnd;
		if (byteEnd - byteStart > max) add(i, "too_large");
		if (
			isContinuation(bytes[byteStart] as number) ||
			(byteEnd < bytes.length && isContinuation(bytes[byteEnd] as number))
		) {
			add(i, "utf8_boundary");
		} else {
			let decoded: string | null;
			try {
				decoded = strictDecoder.decode(bytes.subarray(byteStart, byteEnd));
			} catch {
				decoded = null;
			}
			if (decoded === null) add(i, "utf8_boundary");
			else if (decoded !== f.text) add(i, "text_mismatch");
		}
		const next = fragments[i + 1];
		if (
			f.text.endsWith("\r") &&
			next !== undefined &&
			next.text.startsWith("\n")
		) {
			add(i, "crlf_split");
		}
	}
	if (expectedStart !== bytes.length) add(null, "coverage");
	return out;
}
