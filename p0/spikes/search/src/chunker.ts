// spike: Markdown を見出し構造で分割し、各断片の UTF-8 byte 範囲 [start, end) を保持する。
// 範囲は常に「固定した Markdown 本文の bytes」上の値。JS の文字列 index（UTF-16）では持たない。
// BOM は除去しない（先頭 EF BB BF も範囲に含める）。製品コードではない。
import { createHash } from "node:crypto";

export type FragmentKind = "frontmatter" | "preamble" | "section";
export type SplitLevel = "whole-section" | "block" | "line" | "sentence" | "grapheme" | "codepoint";

export interface Fragment {
	index: number;
	/** UTF-8 byte offset（含む） */
	start: number;
	/** UTF-8 byte offset（含まない） */
	end: number;
	text: string;
	sha256: string;
	headingPath: string[];
	kind: FragmentKind;
	/** 見出し節を何で分割したか。whole-section 以外は節が上限を超えた */
	splitLevel: SplitLevel;
	/** 書記素 1 個が上限を超え、code point 境界で切った（書記素の途中で切った）場合 true */
	brokeGrapheme: boolean;
}
export interface ChunkResult {
	bytes: Uint8Array;
	docSha256: string;
	hasBom: boolean;
	fragments: Fragment[];
}
export interface ChunkOptions {
	/** 1 断片の UTF-8 byte 上限。64 以上 */
	maxBytes: number;
}

export const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // ignoreBOM:true = BOM を除去しない
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

/** UTF-16 index -> UTF-8 byte offset。サロゲートペアの 2 つ目の位置は境界にならないので同じ値を入れる。 */
export function buildByteMap(text: string): Uint32Array {
	const map = new Uint32Array(text.length + 1);
	let b = 0;
	for (let i = 0; i < text.length; i++) {
		map[i] = b;
		const c = text.charCodeAt(i);
		if (c < 0x80) b += 1;
		else if (c < 0x800) b += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			b += 4;
			map[++i] = map[i - 1]!; // low surrogate: 境界ではない
		} else b += 3;
	}
	map[text.length] = b;
	return map;
}

interface Line { s: number; e: number; next: number }
function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	const re = /\r\n|\n|\r/g;
	let s = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		lines.push({ s, e: m.index, next: m.index + m[0].length });
		s = m.index + m[0].length;
	}
	if (s < text.length) lines.push({ s, e: text.length, next: text.length });
	return lines;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

interface Section { s: number; e: number; kind: FragmentKind; path: string[] }

function findSections(text: string, lines: Line[]): Section[] {
	const starts: { s: number; kind: FragmentKind; path: string[] }[] = [];
	let i = 0;
	let bodyStartLine = 0;
	// frontmatter: 先頭行（BOM は無視して判定）が --- で、閉じ行が --- か ...
	if (lines.length) {
		const first = text.slice(lines[0]!.s, lines[0]!.e).replace(/^﻿/, "");
		if (/^---[ \t]*$/.test(first)) {
			for (let j = 1; j < lines.length; j++) {
				const l = text.slice(lines[j]!.s, lines[j]!.e);
				if (/^(---|\.\.\.)[ \t]*$/.test(l)) {
					starts.push({ s: 0, kind: "frontmatter", path: [] });
					bodyStartLine = j + 1;
					break;
				}
			}
		}
	}
	const stack: { level: number; title: string }[] = [];
	let fence: { ch: string; len: number } | null = null;
	let firstBodyStart = bodyStartLine < lines.length ? lines[bodyStartLine]!.s : text.length;
	let sawHeading = false;
	for (i = bodyStartLine; i < lines.length; i++) {
		const l = lines[i]!;
		const line = text.slice(l.s, l.e);
		if (fence) {
			const m = FENCE.exec(line);
			if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.slice(m[0].length).trim() === "") fence = null;
			continue;
		}
		const fm = FENCE.exec(line);
		if (fm) { fence = { ch: fm[1]![0]!, len: fm[1]!.length }; continue; }
		const h = HEADING.exec(line);
		if (h) {
			const level = h[1]!.length;
			while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
			stack.push({ level, title: (h[2] ?? "").trim() });
			if (!sawHeading && l.s > firstBodyStart) starts.push({ s: firstBodyStart, kind: "preamble", path: [] });
			sawHeading = true;
			starts.push({ s: l.s, kind: "section", path: stack.map((x) => x.title) });
		}
	}
	if (!sawHeading && firstBodyStart < text.length) starts.push({ s: firstBodyStart, kind: "preamble", path: [] });
	const out: Section[] = [];
	for (let k = 0; k < starts.length; k++) out.push({ s: starts[k]!.s, e: k + 1 < starts.length ? starts[k + 1]!.s : text.length, kind: starts[k]!.kind, path: starts[k]!.path });
	// 先頭が bytes の 0 から始まらない（frontmatter なし・BOM のみ等）場合でも、文書全体を隙間なく覆う
	if (out.length && out[0]!.s > 0) out[0]!.s = 0;
	return out;
}

/** [s, e) と重なる行（行は s 昇順）。二分探索で O(log n + 件数)。 */
function linesIn(lines: Line[], s: number, e: number): Line[] {
	let lo = 0, hi = lines.length;
	while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid]!.next > s) hi = mid; else lo = mid + 1; }
	const out: Line[] = [];
	for (let i = lo; i < lines.length && lines[i]!.s < e; i++) out.push(lines[i]!);
	return out;
}

/** 節を、空行区切りの段落・フェンスコード・表の「ブロック」に分ける（空行は直前ブロックの末尾に含める）。 */
function splitBlocks(text: string, lines: Line[], s: number, e: number): [number, number][] {
	const inRange = linesIn(lines, s, e);
	const blocks: [number, number][] = [];
	let cur: number | null = null;
	let mode: "para" | "table" | null = null;
	const close = (to: number) => { if (cur !== null) blocks.push([cur, to]); cur = null; mode = null; };
	for (let idx = 0; idx < inRange.length; idx++) {
		const l = inRange[idx]!;
		const line = text.slice(l.s, l.e);
		const fm = FENCE.exec(line);
		if (fm) {
			close(l.s);
			// 閉じフェンスまで 1 ブロック
			let j = idx + 1;
			for (; j < inRange.length; j++) {
				const m = FENCE.exec(text.slice(inRange[j]!.s, inRange[j]!.e));
				if (m && m[1]![0] === fm[1]![0] && m[1]!.length >= fm[1]!.length) break;
			}
			const lastIdx = Math.min(j, inRange.length - 1);
			blocks.push([l.s, inRange[lastIdx]!.next]);
			idx = lastIdx;
			continue;
		}
		if (line.trim() === "") { continue; } // 空行: 直前ブロックの末尾に吸収（下で終端を決める）
		const isTable = /^ {0,3}\|/.test(line);
		const isHeading = HEADING.test(line);
		const want = isHeading ? "heading" : isTable ? "table" : "para";
		if (cur !== null && (want === "heading" || want !== mode)) close(l.s);
		if (cur === null) { cur = l.s; mode = want === "table" ? "table" : "para"; if (want === "heading") { blocks.push([l.s, l.next]); cur = null; mode = null; } }
	}
	close(e);
	// 隙間（空行）を直前ブロックへ、先頭の隙間は先頭ブロックへ。ブロックが無ければ節全体 1 つ。
	if (!blocks.length) return [[s, e]];
	blocks.sort((a, b) => a[0] - b[0]);
	const tiled: [number, number][] = [];
	for (let k = 0; k < blocks.length; k++) tiled.push([k === 0 ? s : blocks[k]![0], k + 1 < blocks.length ? blocks[k + 1]![0] : e]);
	return tiled;
}

type Unit = { s: number; e: number; level: SplitLevel; broke?: boolean };

export function chunkMarkdown(input: Uint8Array | string, options: ChunkOptions): ChunkResult {
	if (!Number.isInteger(options.maxBytes) || options.maxBytes < 64) throw new Error("max_bytes_too_small");
	const max = options.maxBytes;
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input; // TextEncoder は BOM(U+FEFF) を落とさない
	const text = decoder.decode(bytes); // fatal: 不正 UTF-8 は例外
	const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	const map = buildByteMap(text);
	const size = (s: number, e: number) => map[e]! - map[s]!;
	const lines = splitLines(text);
	const sections = text.length ? findSections(text, lines) : [];
	const fragments: Fragment[] = [];

	const expand = (s: number, e: number, level: SplitLevel): Unit[] => {
		if (size(s, e) <= max) return [{ s, e, level }];
		if (level === "block") {
			const out: Unit[] = [];
			for (const l of linesIn(lines, s, e)) out.push(...expand(Math.max(s, l.s), Math.min(e, l.next), "line"));
			// 隙間（行末後の空白など）は無いが、念のため連続性を確認
			return out;
		}
		if (level === "line") {
			const out: Unit[] = [];
			let off = s;
			for (const seg of sentences.segment(text.slice(s, e))) {
				const ss = s + seg.index, se = ss + seg.segment.length;
				out.push(...expand(ss, se, "sentence"));
				off = se;
			}
			void off;
			return out;
		}
		if (level === "sentence") {
			const out: Unit[] = [];
			for (const seg of graphemes.segment(text.slice(s, e))) {
				const gs = s + seg.index, ge = gs + seg.segment.length;
				if (size(gs, ge) <= max) out.push({ s: gs, e: ge, level: "grapheme" });
				else {
					// 書記素 1 個が上限超え: code point 境界で切る
					for (let p = gs; p < ge; ) {
						const cp = text.codePointAt(p)!;
						const n = cp > 0xffff ? 2 : 1;
						out.push({ s: p, e: p + n, level: "codepoint", broke: true });
						p += n;
					}
				}
			}
			return out;
		}
		return [{ s, e, level }];
	};

	for (const sec of sections) {
		let units: Unit[];
		if (size(sec.s, sec.e) <= max) units = [{ s: sec.s, e: sec.e, level: "whole-section" }];
		else units = splitBlocks(text, lines, sec.s, sec.e).flatMap(([s, e]) => expand(s, e, "block"));
		// greedy pack
		let cs = units[0]!.s, ce = units[0]!.s, lvl: SplitLevel = units[0]!.level, broke = false;
		const flush = () => {
			if (ce === cs) return;
			const startB = map[cs]!, endB = map[ce]!;
			fragments.push({
				index: fragments.length, start: startB, end: endB, text: text.slice(cs, ce),
				sha256: sha256Hex(bytes.subarray(startB, endB)), headingPath: sec.path, kind: sec.kind,
				splitLevel: units.length === 1 && lvl === "whole-section" ? "whole-section" : lvl, brokeGrapheme: broke,
			});
		};
		for (const u of units) {
			if (ce !== cs && size(cs, u.e) > max) { flush(); cs = u.s; lvl = u.level; broke = false; }
			if (cs === ce) { cs = u.s; lvl = u.level; }
			ce = u.e;
			if (u.broke) broke = true;
			// より細かい分割が混ざった断片は最も細かい level を記録
			const order: SplitLevel[] = ["whole-section", "block", "line", "sentence", "grapheme", "codepoint"];
			if (order.indexOf(u.level) > order.indexOf(lvl)) lvl = u.level;
		}
		flush();
	}
	return { bytes, docSha256: sha256Hex(bytes), hasBom, fragments };
}
