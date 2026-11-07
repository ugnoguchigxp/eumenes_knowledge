import {
	type Fragment,
	KnowledgeError,
	MAX_FRAGMENT_BYTES,
} from "../../contracts/index.js";
import { buildByteMap } from "./offsets.js";

export type ChunkOptions = {
	/** Upper bound of one fragment in UTF-8 bytes. Default `MAX_FRAGMENT_BYTES`; at least 4. */
	maxBytes?: number;
};

/** The smallest bound that still holds any single code point (4 UTF-8 bytes). */
const MIN_MAX_BYTES = 4;

// Per-line facts, computed in one pass. Structure only; no word is ever looked at.
const F_BLANK = 1; // only spaces/tabs, outside a fence
const F_FENCE_OPEN = 2;
const F_FENCE_IN = 4; // inside a fenced code block (blank lines included)
const F_FENCE_CLOSE = 8;
const F_HEADING = 16; // ATX heading outside a fence

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const strictDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

/** [charStart, charEnd) in UTF-16 positions, with the line range [lineStart, lineEnd) it covers. */
type Unit = readonly [number, number, number, number];

type Section = { l0: number; l1: number; path: string[] };

/**
 * Splits a Markdown body into fragments (p2.md §2 step 2.2).
 *
 * `text` must be `bytes` decoded as UTF-8 with the BOM kept; anything else is `invalid_input`.
 * Fragments do not overlap, cover the whole body, and are at most `maxBytes` UTF-8 bytes. A
 * boundary is chosen, in this order, at an ATX heading, between paragraphs (blank-line
 * separated; a fenced code block is never split at its blank lines), between lines, between
 * grapheme clusters. A boundary never falls inside a UTF-8 character, a CRLF, or a grapheme
 * cluster, except for one cluster that alone exceeds `maxBytes`: that one is cut between code
 * points. `#` lines inside a fenced code block (or the frontmatter) are not headings.
 * Frontmatter is part of the body and is its own section. Empty body gives no fragment.
 */
export function chunkMarkdown(
	bytes: Uint8Array,
	text: string,
	options: ChunkOptions = {},
): Fragment[] {
	const max = options.maxBytes ?? MAX_FRAGMENT_BYTES;
	if (!Number.isInteger(max) || max < MIN_MAX_BYTES)
		throw new KnowledgeError("invalid_input");
	if (!isDecodingOf(bytes, text)) throw new KnowledgeError("invalid_input");
	if (text.length === 0) return [];

	const map = buildByteMap(text);
	const lines = scanLines(text);
	const { flags, levels, frontmatterLines } = classifyLines(text, lines);
	const sections = buildSections(text, lines, flags, levels, frontmatterLines);

	const fragments: Fragment[] = [];
	const size = (s: number, e: number) =>
		(map[e] as number) - (map[s] as number);
	const lineStart = (i: number) =>
		i < lines.count ? (lines.start[i] as number) : text.length;

	let path: string[] = [];
	const emit = (s: number, e: number) => {
		fragments.push({
			ordinal: fragments.length,
			byteStart: map[s] as number,
			byteEnd: map[e] as number,
			headingPath: path.slice(),
			text: text.slice(s, e),
		});
	};

	/**
	 * Greedy packing of consecutive units. A unit that alone exceeds the bound closes the open
	 * fragment and is split by the next, finer level.
	 */
	const pack = (
		units: Iterable<Unit>,
		split: ((unit: Unit) => void) | null,
	) => {
		let s = -1;
		let e = -1;
		const flush = () => {
			if (s >= 0) emit(s, e);
			s = -1;
		};
		for (const unit of units) {
			if (size(unit[0], unit[1]) > max) {
				flush();
				(split as (unit: Unit) => void)(unit);
				continue;
			}
			if (s >= 0 && size(s, unit[1]) > max) flush();
			if (s < 0) s = unit[0];
			e = unit[1];
		}
		flush();
	};

	function* blockUnits(l0: number, l1: number): Generator<Unit> {
		let blockStart = l0;
		let hasContent = ((flags[l0] as number) & F_BLANK) === 0;
		for (let i = l0 + 1; i < l1; i++) {
			const f = flags[i] as number;
			if ((f & F_BLANK) !== 0) continue;
			const p = flags[i - 1] as number;
			if (
				hasContent &&
				((p & F_BLANK) !== 0 ||
					(f & F_FENCE_OPEN) !== 0 ||
					(p & F_FENCE_CLOSE) !== 0 ||
					(f & F_HEADING) !== 0)
			) {
				yield [lineStart(blockStart), lineStart(i), blockStart, i];
				blockStart = i;
			}
			hasContent = true;
		}
		yield [lineStart(blockStart), lineStart(l1), blockStart, l1];
	}

	function* lineUnits(l0: number, l1: number): Generator<Unit> {
		for (let i = l0; i < l1; i++)
			yield [lineStart(i), lineStart(i + 1), i, i + 1];
	}

	function* graphemeUnits(s: number, e: number): Generator<Unit> {
		for (const seg of graphemes.segment(text.slice(s, e))) {
			yield [s + seg.index, s + seg.index + seg.segment.length, 0, 0];
		}
	}

	function* codePointUnits(s: number, e: number): Generator<Unit> {
		for (let p = s; p < e;) {
			const n = (text.codePointAt(p) as number) > 0xffff ? 2 : 1;
			yield [p, p + n, 0, 0];
			p += n;
		}
	}

	const splitGrapheme = (u: Unit) => pack(codePointUnits(u[0], u[1]), null);
	const splitLine = (u: Unit) => pack(graphemeUnits(u[0], u[1]), splitGrapheme);
	const splitBlock = (u: Unit) => pack(lineUnits(u[2], u[3]), splitLine);

	for (const section of sections) {
		path = section.path;
		const s = lineStart(section.l0);
		const e = lineStart(section.l1);
		if (size(s, e) <= max) emit(s, e);
		else pack(blockUnits(section.l0, section.l1), splitBlock);
	}
	return fragments;
}

/** `text` is exactly `bytes` decoded as UTF-8 with the BOM kept (so it holds no lone surrogate). */
function isDecodingOf(bytes: Uint8Array, text: string): boolean {
	try {
		return strictDecoder.decode(bytes) === text;
	} catch {
		return false;
	}
}

type Lines = { count: number; start: Uint32Array; end: Uint32Array };

/** Lines end at CRLF, LF or CR. `start[i]..end[i]` is the content; the terminator follows. */
function scanLines(text: string): Lines {
	const n = text.length;
	let count = 0;
	let lineBegin = 0;
	for (let i = 0; i < n; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
			count++;
			lineBegin = i + 1;
		}
	}
	if (lineBegin < n) count++;
	const start = new Uint32Array(count);
	const end = new Uint32Array(count);
	let line = 0;
	lineBegin = 0;
	for (let i = 0; i < n; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
			start[line] = lineBegin;
			end[line] =
				c === 10 && i > lineBegin && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
			line++;
			lineBegin = i + 1;
		}
	}
	if (lineBegin < n) {
		start[line] = lineBegin;
		end[line] = n;
	}
	return { count, start, end };
}

const isSpaceOrTab = (c: number) => c === 0x20 || c === 0x09;

function onlySpaceOrTabAfter(text: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++)
		if (!isSpaceOrTab(text.charCodeAt(i))) return false;
	return true;
}

function runLength(text: string, from: number, to: number): number {
	const c = text.charCodeAt(from);
	let n = 0;
	while (from + n < to && text.charCodeAt(from + n) === c) n++;
	return n;
}

/** First line is `---` (a BOM is ignored) and a later line is `---` or `...`: that many lines. */
function frontmatterLineCount(text: string, lines: Lines): number {
	if (lines.count < 2) return 0;
	let first = lines.start[0] as number;
	if (text.charCodeAt(first) === 0xfeff) first++;
	const isRule = (s: number, e: number, mark: string) =>
		s + 3 <= e &&
		text.startsWith(mark, s) &&
		onlySpaceOrTabAfter(text, s + 3, e);
	if (!isRule(first, lines.end[0] as number, "---")) return 0;
	for (let i = 1; i < lines.count; i++) {
		const s = lines.start[i] as number;
		const e = lines.end[i] as number;
		if (isRule(s, e, "---") || isRule(s, e, "...")) return i + 1;
	}
	return 0;
}

/**
 * Where line `i` starts for structure checks. A leading BOM belongs to the bytes (and to the
 * first fragment), but not to the Markdown structure: `\uFEFF# Title` is a heading.
 */
function structuralStart(text: string, lines: Lines, i: number): number {
	const s = lines.start[i] as number;
	return i === 0 && text.charCodeAt(0) === 0xfeff ? s + 1 : s;
}

function classifyLines(text: string, lines: Lines) {
	const flags = new Uint8Array(lines.count);
	const levels = new Uint8Array(lines.count);
	const frontmatterLines = frontmatterLineCount(text, lines);
	let inFence = false;
	let fenceChar = 0;
	let fenceLength = 0;
	for (let i = frontmatterLines; i < lines.count; i++) {
		const s = structuralStart(text, lines, i);
		const e = lines.end[i] as number;
		let q = s;
		let hasTab = false;
		while (q < e && isSpaceOrTab(text.charCodeAt(q))) {
			if (text.charCodeAt(q) === 0x09) hasTab = true;
			q++;
		}
		if (q === e) {
			flags[i] = inFence ? F_FENCE_IN : F_BLANK;
			continue;
		}
		const structural = q - s <= 3 && !hasTab;
		const ch = text.charCodeAt(q);
		if (inFence) {
			if (structural && ch === fenceChar) {
				const n = runLength(text, q, e);
				if (n >= fenceLength && onlySpaceOrTabAfter(text, q + n, e)) {
					flags[i] = F_FENCE_CLOSE;
					inFence = false;
					continue;
				}
			}
			flags[i] = F_FENCE_IN;
			continue;
		}
		if (!structural) continue;
		if (ch === 0x60 || ch === 0x7e) {
			const n = runLength(text, q, e);
			if (n >= 3 && (ch === 0x7e || !hasBacktick(text, q + n, e))) {
				flags[i] = F_FENCE_OPEN;
				inFence = true;
				fenceChar = ch;
				fenceLength = n;
			}
		} else if (ch === 0x23) {
			const n = runLength(text, q, e);
			if (n <= 6 && (q + n === e || isSpaceOrTab(text.charCodeAt(q + n)))) {
				flags[i] = F_HEADING;
				levels[i] = n;
			}
		}
	}
	return { flags, levels, frontmatterLines };
}

function hasBacktick(text: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (text.charCodeAt(i) === 0x60) return true;
	return false;
}

/** The title of an ATX heading line: text after the `#` run, without the closing `#` run. */
function headingTitle(
	text: string,
	lineStart: number,
	lineEnd: number,
): string {
	let p = lineStart;
	while (p < lineEnd && isSpaceOrTab(text.charCodeAt(p))) p++;
	p += runLength(text, p, lineEnd);
	let title = text.slice(p, lineEnd).trim();
	if (title.endsWith("#")) {
		let k = title.length;
		while (k > 0 && title.charCodeAt(k - 1) === 0x23) k--;
		if (k === 0) title = "";
		else if (isSpaceOrTab(title.charCodeAt(k - 1)))
			title = title.slice(0, k).trimEnd();
	}
	return title;
}

/**
 * Sections tile the lines: the frontmatter, the lines before the first heading, then one
 * section per heading up to the next heading. `path` is the chain of enclosing heading titles.
 */
function buildSections(
	text: string,
	lines: Lines,
	flags: Uint8Array,
	levels: Uint8Array,
	frontmatterLines: number,
): Section[] {
	const sections: Section[] = [];
	if (frontmatterLines > 0)
		sections.push({ l0: 0, l1: frontmatterLines, path: [] });
	const stack: { level: number; title: string }[] = [];
	let current: Section = {
		l0: frontmatterLines,
		l1: frontmatterLines,
		path: [],
	};
	// Blank lines alone are not worth a fragment: they join the previous section (the
	// frontmatter), or else the first heading section.
	let carried: number | null = null;
	const close = (at: number) => {
		current.l1 = at;
		if (current.l1 <= current.l0) return;
		const previous = sections[sections.length - 1];
		if (
			current.path.length === 0 &&
			previous !== undefined &&
			allBlank(flags, current)
		) {
			previous.l1 = at;
		} else if (
			current.path.length === 0 &&
			at < lines.count &&
			allBlank(flags, current)
		) {
			carried = current.l0;
		} else sections.push(current);
	};
	for (let i = frontmatterLines; i < lines.count; i++) {
		if (((flags[i] as number) & F_HEADING) === 0) continue;
		close(i);
		const level = levels[i] as number;
		while (
			stack.length > 0 &&
			(stack[stack.length - 1] as { level: number }).level >= level
		) {
			stack.pop();
		}
		stack.push({
			level,
			title: headingTitle(
				text,
				structuralStart(text, lines, i),
				lines.end[i] as number,
			),
		});
		current = { l0: carried ?? i, l1: i, path: stack.map((h) => h.title) };
		carried = null;
	}
	close(lines.count);
	return sections;
}

function allBlank(flags: Uint8Array, section: Section): boolean {
	for (let i = section.l0; i < section.l1; i++) {
		if (((flags[i] as number) & F_BLANK) === 0) return false;
	}
	return true;
}
