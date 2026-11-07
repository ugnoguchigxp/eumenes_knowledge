import { KnowledgeError } from "../../contracts/index.js";

/**
 * UTF-8 byte length of a string, as `new TextEncoder().encode(text).length` would give.
 * A lone surrogate counts as 3 bytes (it would be encoded as U+FFFD).
 */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && isLowSurrogate(text, i + 1)) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * UTF-8 byte offset of a UTF-16 position (`0..text.length`). The position must not fall
 * between the two halves of a surrogate pair, because that is not a position in the UTF-8 bytes.
 */
export function byteOffsetOfIndex(text: string, utf16Index: number): number {
	if (
		!Number.isInteger(utf16Index) ||
		utf16Index < 0 ||
		utf16Index > text.length
	) {
		throw new KnowledgeError("invalid_input");
	}
	if (
		utf16Index > 0 &&
		utf16Index < text.length &&
		isLowSurrogate(text, utf16Index) &&
		isHighSurrogate(text, utf16Index - 1)
	) {
		throw new KnowledgeError("invalid_input");
	}
	return utf8ByteLength(text.slice(0, utf16Index));
}

/**
 * `map[i]` is the UTF-8 byte offset of UTF-16 position `i` (`map[text.length]` is the total).
 * The second half of a surrogate pair is not a boundary; it repeats the offset of the first half.
 */
export function buildByteMap(text: string): Uint32Array {
	const map = new Uint32Array(text.length + 1);
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		map[i] = bytes;
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (c >= 0xd800 && c <= 0xdbff && isLowSurrogate(text, i + 1)) {
			bytes += 4;
			i++;
			map[i] = map[i - 1] as number;
		} else bytes += 3;
	}
	map[text.length] = bytes;
	return map;
}

function isHighSurrogate(text: string, index: number): boolean {
	const c = text.charCodeAt(index);
	return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(text: string, index: number): boolean {
	const c = text.charCodeAt(index);
	return c >= 0xdc00 && c <= 0xdfff;
}
